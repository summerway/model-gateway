// observed-push.js — Mac 采集器的推送一轮：收集 → POST /internal/usage/observed → 确认后保存游标。
// 游标只在网关完整确认后写盘；失败抛错由调用方退避重试（接收端按 eventId 幂等，重发安全）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @param {object} o
 * @param {'codex'|'claude-code'} o.source
 * @param {(state: object) => { events: object[], state: object }} o.collect
 * @returns {Promise<number>} 本轮推送条数
 */
export async function syncObserved({ source, collect, stateFile, url, key, device = 'mac', fetchFn = fetch }) {
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const batch = collect(state);
  if (batch.events.length) {
    if (!key) throw new Error('缺少用量同步密钥');
    const response = await fetchFn(new URL('/internal/usage/observed', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ source, device, events: batch.events }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`用量同步 HTTP ${response.status}`);
    const ack = await response.json();
    if (ack.accepted !== batch.events.length) throw new Error('接收确认不完整，保留游标以便重试');
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile + '.tmp', JSON.stringify(batch.state), { mode: 0o600 });
  renameSync(stateFile + '.tmp', stateFile);
  return batch.events.length;
}
