// agent-endpoints.js — 应用密钥页 Agent 映射的唯一数据源：skills 仓 distribution.json 的 endpoints。
// endpoint id 与 gateway.keys[].app 一一对应；type 推导位置：mac-symlink → 本地（Mac），
// nas-dist-dir → 云端（NAS），其余 → unknown。图标按 agent 类型内置在看板（console.html AGENT_ICON），
// 这里只给出类型：id 含 claude → claudecode，codex → codex，pi → pi，openclaw → openclaw。
// 启动读一次、之后定时重读；文件缺失/解析失败 → 保留上次结果并标 stale（首读失败 → 空映射）。
// skills-admin 服务只跑在 Mac 127.0.0.1，NAS 上的网关访问不到，所以读文件而不是调它的 API。

import { readFileSync } from 'node:fs';

const LOCATION = { 'mac-symlink': 'local', 'nas-dist-dir': 'cloud' };

/** endpoint id → 页面图标类型（未识别 → null，页面只显示名称）。 */
export function iconKindOf(id) {
  if (/claude/.test(id)) return 'claudecode';
  if (/codex/.test(id)) return 'codex';
  if (/openclaw/.test(id)) return 'openclaw';
  if (/(^|-)pi(-|$)/.test(id)) return 'pi';
  return null;
}

/** distribution.json 文本 → agents（本地在前、云端其次、未知最后；同组保持文件顺序）。 */
export function parseAgentEndpoints(text) {
  const endpoints = JSON.parse(text)?.endpoints;
  if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) throw new Error('distribution.json: endpoints 不是映射');
  const rank = { local: 0, cloud: 1, unknown: 2 };
  return Object.entries(endpoints)
    .map(([app, ep]) => ({ app, iconKind: iconKindOf(app), location: LOCATION[ep?.type] ?? 'unknown' }))
    .sort((a, b) => rank[a.location] - rank[b.location]);
}

export class AgentEndpoints {
  constructor({ file = null, intervalMs = 600_000, now = Date.now } = {}) {
    this.file = file;
    this.intervalMs = intervalMs;
    this.now = now;
    this.agents = [];
    this.loadedAt = null;
    this.error = null;
    this.timer = null;
  }

  load() {
    if (!this.file) return this;
    try {
      this.agents = parseAgentEndpoints(readFileSync(this.file, 'utf8'));
      this.loadedAt = new Date(this.now()).toISOString();
      this.error = null;
    } catch (err) {
      // 只保留错误类别，不回显文件内容
      this.error = err.code === 'ENOENT' ? '文件不存在' : err instanceof SyntaxError ? 'JSON 解析失败' : (err.message ?? '读取失败');
      console.error(`[agent-endpoints] load failed (${this.file}): ${this.error}`);
    }
    return this;
  }

  start() {
    if (!this.file || this.timer) return this;
    this.load();
    this.timer = setInterval(() => this.load(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      agents: this.agents,
      source: { configured: Boolean(this.file), loadedAt: this.loadedAt, stale: Boolean(this.error), error: this.error },
    };
  }
}
