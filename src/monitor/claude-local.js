// claude-local.js — Claude Code 本地会话（<projects>/<项目>/*.jsonl）用量解析，NAS 容器内同步
// （claude-usage-sync.js）与 Mac 推送采集（scripts/mac-usage-sync.js）共用。
//
// 每段 assistant 应答一行或多行（同一 message.id 分块写入，后写的行 output 可能更完整）：
// 事件 id = sha256('claude-code:' + message.id)，接收端按 id 幂等并取各计数最大值。
// 只产出官方订阅模型（claude-*）：Claude Code 经网关跑的其他模型已由 served 记过（去重规则）。
// 只读 token 计数、模型和时间，不读也不上传对话正文。

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractUsage } from './extract.js';

export const CLAUDE_SUB_SYNC_CLIENT = 'claude-sub-sync';
const RETENTION_MS = 90 * 86400000; // 与 UsageLog 明细保留期一致
const safe = (v) => Number.isSafeInteger(v) && v >= 0;

/** 会话 JSONL 的一行（已 JSON.parse）→ 用量事件；非 assistant / 非订阅模型 / 无 id → null。 */
export function parseClaudeLine(obj) {
  if (obj?.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') return null;
  const msg = obj.message;
  if (typeof msg.id !== 'string' || !msg.id) return null;
  const model = typeof msg.model === 'string' && msg.model ? msg.model : 'claude-unknown';
  if (!model.startsWith('claude-')) return null;
  const ts = typeof obj.timestamp === 'string' && Number.isFinite(Date.parse(obj.timestamp)) ? obj.timestamp : null;
  return {
    id: createHash('sha256').update(`claude-code:${msg.id}`).digest('hex'),
    ts,
    model,
    usage: extractUsage(msg.usage),
  };
}

/**
 * Mac 采集：按文件字节游标读取完整行（半行留到下一轮），产出至多 limit 条事件。
 * state = { files: { [path]: { offset, identity } } }；返回 { events, state }，游标只在接收确认后保存。
 */
export function collectClaude({ projectsDir, state = {}, now = Date.now(), limit = 500 }) {
  const next = structuredClone(state); next.files ??= {};
  const events = [];
  const cutoff = now - RETENTION_MS;
  const files = [];
  (function walk(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile() && e.name.endsWith('.jsonl') && statSync(file).mtimeMs >= cutoff) files.push(file);
    }
  })(projectsDir);
  for (const file of files.sort()) {
    if (events.length >= limit) break;
    const stat = statSync(file), identity = `${stat.dev}:${stat.ino}`;
    let cursor = next.files[file];
    if (!cursor || cursor.offset > stat.size || (cursor.identity && cursor.identity !== identity)) cursor = next.files[file] = { offset: 0 };
    cursor.identity = identity;
    if (cursor.offset >= stat.size) continue;
    const fd = openSync(file, 'r');
    try {
      const base = cursor.offset;
      const buf = Buffer.alloc(stat.size - base);
      readSync(fd, buf, 0, buf.length, base);
      let start = 0, nl;
      while ((nl = buf.indexOf(10, start)) >= 0 && events.length < limit) {
        const line = buf.subarray(start, nl).toString('utf8');
        start = nl + 1;
        cursor.offset = base + start;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        const ev = parseClaudeLine(obj);
        if (!ev || !ev.ts || !ev.usage || Date.parse(ev.ts) < cutoff) continue;
        events.push({ id: ev.id, ts: ev.ts, model: ev.model, usage: ev.usage });
      }
    } finally { closeSync(fd); }
  }
  const alive = new Set(files);
  for (const file of Object.keys(next.files)) if (!alive.has(file)) delete next.files[file];
  return { events, state: next };
}

/** 接收端校验：Mac 推送的 Claude Code 批次 → UsageLog observed 记录。 */
export function validateClaudeBatch(body, now = Date.now(), device = 'mac') {
  if (!Array.isArray(body?.events) || body.events.length > 500) throw new Error('events 必须为最多 500 条的数组');
  return body.events.map((e) => {
    if (!e || typeof e.id !== 'string' || !/^[a-f0-9]{64}$/.test(e.id)
      || typeof e.model !== 'string' || !/^claude-[a-zA-Z0-9._-]{1,100}$/.test(e.model)
      || typeof e.ts !== 'string' || !Number.isFinite(Date.parse(e.ts)) || Date.parse(e.ts) > now + 300000
      || !['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => safe(e.usage?.[k]))) throw new Error('无效用量记录');
    return {
      eventId: e.id, ts: new Date(e.ts).toISOString(), model: e.model, upstreamModel: e.model,
      client: CLAUDE_SUB_SYNC_CLIENT, providerId: 'claude', path: 'claude-code', kind: 'observed', device,
      usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map((k) => [k, e.usage[k]])), reported: true,
    };
  });
}
