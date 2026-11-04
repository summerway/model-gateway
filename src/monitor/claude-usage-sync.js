// claude-usage-sync.js — Claude Code 会话用量 → UsageLog 增量同步。
// Claude Code 把每段 assistant 应答逐行落在 <sessionDir>/<项目目录>/*.jsonl；
// 本 job 定时（默认 5 分钟 + 启动即扫）增量读取：
//   - 每文件字节游标持久化到 stateFile（仿 model-guard 的 data/ 同目录约定），
//     只消费完整行——正在写入的半行留到下一轮；文件截断/回绕 → 游标归零重读。
//   - type:'assistant' 行经 parseClaudeLine（claude-local.js，与 Mac 采集共用）记入 usage 统计
//     （kind:'observed'，eventId = message.id 摘要）：同一消息多行由 store 按 eventId 幂等并取
//     各计数最大值；非 claude-* 模型（Claude Code 经网关跑 GLM）不导入——served 已记过。
//   - 幂等可重启：游标即进度。
// 不读任何凭据；sessionDir 由 compose 只读挂载。

import {
  closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDE_SUB_SYNC_CLIENT, parseClaudeLine } from './claude-local.js';

export { CLAUDE_SUB_SYNC_CLIENT };

export class ClaudeUsageSync {
  /**
   * @param {object} opts
   * @param {string} [opts.sessionDir] Claude Code projects 目录（缺省/null → 不启动）
   * @param {object} [opts.usageLog] UsageLog 实例
   * @param {string|null} [opts.stateFile] 游标持久化文件（null → 仅内存，重启全量首扫）
   * @param {number} [opts.intervalMs] 扫描周期（默认 5 分钟）
   * @param {() => number} [opts.now]
   * @param {string} [opts.device] 采集设备标识（默认 nas：生产挂载的是 NAS 上的 Claude Code 配置目录）
   */
  constructor({ sessionDir, usageLog, stateFile = null, intervalMs = 300_000, now = Date.now, device = 'nas' } = {}) {
    this.device = device;
    this.sessionDir = sessionDir ?? null;
    this.usageLog = usageLog ?? null;
    this.stateFile = stateFile ?? null;
    this.intervalMs = intervalMs;
    this.now = now;
    this.cursors = new Map(); // 绝对路径 → 已消费字节偏移
    this.timer = null;
    if (this.stateFile) this.#loadState();
  }

  start() {
    if (!this.sessionDir || !this.usageLog || this.timer) return this;
    this.timer = setInterval(() => {
      try { this.scan(); } catch (e) {
        console.error(`[claude-usage-sync] scan failed: ${e?.message ?? e}`);
      }
    }, this.intervalMs);
    this.timer.unref?.();
    try { this.scan(); } catch (e) {
      console.error(`[claude-usage-sync] initial scan failed: ${e?.message ?? e}`);
    }
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /** 单轮全量扫描（同步；本地 jsonl 小体量）。返回 {files, records}。 */
  scan() {
    if (!this.sessionDir || !this.usageLog) return { files: 0, records: 0 };
    const files = this.#listJsonl(this.sessionDir);
    let records = 0;
    for (const f of files) records += this.#syncFile(f);
    // 游标表瘦身：已消失的文件不再保留游标（防无界增长）
    if (files.length < this.cursors.size) {
      const alive = new Set(files);
      for (const k of this.cursors.keys()) if (!alive.has(k)) this.cursors.delete(k);
    }
    this.#saveState();
    return { files: files.length, records };
  }

  #listJsonl(dir, out = []) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) this.#listJsonl(p, out);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  #syncFile(file) {
    let size;
    try { size = statSync(file).size; } catch { return 0; }
    let cursor = this.cursors.get(file) ?? 0;
    if (size < cursor) cursor = 0; // 截断/回绕：从头重读
    if (size === cursor) return 0;

    let fd;
    try { fd = openSync(file, 'r'); } catch { return 0; }
    let buf;
    try {
      buf = Buffer.alloc(size - cursor);
      readSync(fd, buf, 0, buf.length, cursor);
    } catch {
      return 0;
    } finally {
      closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return 0; // 尚无完整行（半行留到下一轮，游标不动）

    let records = 0;
    for (const line of buf.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; } // 脏行跳过
      const ev = parseClaudeLine(obj);
      if (!ev) continue;
      const kept = this.usageLog.record({
        ts: ev.ts ?? new Date(this.now()).toISOString(),
        kind: 'observed',
        eventId: ev.id,
        device: this.device,
        path: 'claude-code',
        client: CLAUDE_SUB_SYNC_CLIENT,
        providerId: 'claude',
        model: ev.model,
        upstreamModel: ev.model,
        stream: false,
        latencyMs: null,
        usage: ev.usage,
        reported: true,
      });
      if (kept) records += 1;
    }
    this.cursors.set(file, cursor + lastNl + 1);
    return records;
  }

  #loadState() {
    try {
      const st = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (st && typeof st === 'object' && st.cursors && typeof st.cursors === 'object') {
        for (const [k, v] of Object.entries(st.cursors)) {
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) this.cursors.set(k, Math.floor(v));
        }
      }
    } catch { /* 无状态文件/损坏 → 全量首扫（message.id 去重兜底跨重启重复风险见 README 注） */ }
  }

  #saveState() {
    if (!this.stateFile) return;
    const obj = {
      version: 1,
      savedAt: new Date(this.now()).toISOString(),
      cursors: Object.fromEntries(this.cursors),
    };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, this.stateFile);
    } catch (e) {
      console.error(`[claude-usage-sync] state persist failed: ${e?.message ?? e}`);
    }
  }
}
