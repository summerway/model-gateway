import { createHash } from 'node:crypto';
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { syncObserved } from './observed-push.js';

export const CODEX_CLIENTS = { app:'codex-local-app',cli:'codex-local-cli',unknown:'codex-local-unknown' };
export const isCodexClient = client => Object.values(CODEX_CLIENTS).includes(client);
const digest = value => createHash('sha256').update(value).digest('hex');
const fields = ['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens'];
const safe = n => Number.isSafeInteger(n) && n >= 0;
function clientOf(meta) {
  if (/desktop/i.test(meta.originator ?? '')) return 'app';
  if (/cli|codex_exec/i.test(meta.originator ?? '') || ['cli','exec'].includes(meta.source)) return 'cli';
  return 'unknown';
}

/** Parse only complete lines. The file cursor advances only after acknowledgement. */
export function collectCodex({ sessionDir, state = {}, now = Date.now(), limit = 500 }) {
  const next = structuredClone(state); next.files ??= {}; next.sessions ??= {};
  const events = [];
  const cutoff = now - 90 * 86400000; // 与 UsageLog 明细保留期一致
  const files = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir,{ withFileTypes:true })) {
      const file = join(dir,e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile() && e.name.endsWith('.jsonl') && statSync(file).mtimeMs >= cutoff) files.push(file);
    }
  }
  walk(sessionDir);
  for (const file of files.sort()) {
    const stat = statSync(file), size = stat.size, identity = `${stat.dev}:${stat.ino}`;
    let cursor = next.files[file];
    if (!cursor || cursor.offset > size || (cursor.identity && cursor.identity !== identity)) cursor = next.files[file] = { offset:0 };
    cursor.identity = identity;
    const fd = openSync(file,'r');
    try {
      let position = cursor.offset, pending = Buffer.alloc(0), lineStart = position, oversized = false;
      while (position < size && events.length < limit) {
        const chunk = Buffer.alloc(Math.min(65536,size-position));
        const count = readSync(fd,chunk,0,chunk.length,position); if (!count) break;
        position += count; pending = Buffer.concat([pending,chunk.subarray(0,count)]);
        let newline;
        while ((newline = pending.indexOf(10)) >= 0 && events.length < limit) {
          const bytes = pending.subarray(0,newline); lineStart += newline+1;
          pending = pending.subarray(newline+1); cursor.offset = lineStart;
          if (oversized) { oversized = false; continue; }
          let event; try { event = JSON.parse(bytes.toString('utf8')); } catch { continue; }
          const p = event.payload;
          if (event.type === 'session_meta') {
            cursor.client = clientOf(p ?? {}); cursor.provider = p?.model_provider ?? 'openai';
            cursor.session = {id:p?.id ?? '',parent:p?.forked_from_id ?? null,start:Date.parse(p?.timestamp ?? event.timestamp),client:cursor.client};
            if (cursor.client === 'unknown' && p?.parent_thread_id) cursor.client = next.sessions[p.parent_thread_id]?.client ?? 'unknown';
            cursor.session.client = cursor.client;
            if (cursor.session.id) next.sessions[cursor.session.id] = cursor.session;
          }
          if (event.type === 'turn_context' && typeof p?.model === 'string') cursor.model = p.model;
          if (event.type !== 'event_msg' || p?.type !== 'token_count' || !p.info?.total_token_usage) continue;
          const total = p.info.total_token_usage;
          if (!fields.every(k => safe(total[k] ?? 0))) continue;
          const values = Object.fromEntries(fields.map(k => [k,total[k] ?? 0]));
          const previous = cursor.total;
          if (previous && fields.every(k => previous[k] === values[k])) continue;
          const reset = !previous || fields.some(k => values[k] < previous[k]);
          const delta = reset ? p.info.last_token_usage : Object.fromEntries(fields.map(k => [k,values[k] - previous[k]]));
          cursor.total = values;
          if (!delta || !fields.every(k => safe(delta[k] ?? 0))) continue;
          if (cursor.provider !== 'openai' || !cursor.model || !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) < cutoff) continue;
          // 跳过 Codex 内部后台任务（如 auto review）：占位 1-token 用量，非用户会话，不应进入统计
          if (cursor.model === 'codex-auto-review') continue;
          const input = delta.input_tokens ?? 0, output = delta.output_tokens ?? 0;
          const cacheRead = delta.cached_input_tokens ?? 0, cacheWrite = delta.cache_write_input_tokens ?? 0;
          if (cacheRead + cacheWrite > input || input + output === 0) continue;
          // Attribute inherited prefixes to their ancestor, new work to its own session.
          // Independent sessions may legitimately have identical counters and timestamps.
          let scope = cursor.session; const visited = new Set();
          if (scope?.parent && !Number.isFinite(scope.start)) continue;
          while (scope?.parent && Date.parse(event.timestamp) <= scope.start) {
            if (visited.has(scope.parent)) { scope = null; break; }
            visited.add(scope.parent); scope = next.sessions[scope.parent];
          }
          if (cursor.session?.parent && !scope) continue; // Unresolvable inherited history is not guessed.
          const id = digest(JSON.stringify([scope?.id ?? '',event.timestamp,values]));
          events.push({ id,ts:event.timestamp,model:cursor.model,client:cursor.client ?? 'unknown',usage:{input:input-cacheRead-cacheWrite,output,cacheRead,cacheWrite} });
        }
        if (pending.length > 1024 * 1024) { lineStart += pending.length; pending = Buffer.alloc(0); oversized = true; }
      }
    } finally { closeSync(fd); }
    if (events.length >= limit) break;
  }
  const existing = new Set(files);
  for (const file of Object.keys(next.files)) if (!existing.has(file)) delete next.files[file];
  const retained = new Set();
  for (const cursor of Object.values(next.files)) { let id=cursor.session?.id; while (id && !retained.has(id)) { retained.add(id); id=next.sessions[id]?.parent; } }
  for (const id of Object.keys(next.sessions)) if (!retained.has(id)) delete next.sessions[id];
  return { events,state:next };
}

export function validateCodexBatch(body, now = Date.now(), device = 'mac') {
  if (!Array.isArray(body?.events) || body.events.length > 500) throw new Error('events 必须为最多 500 条的数组');
  return body.events.map(e => {
    if (!e || typeof e.id !== 'string' || !/^[a-f0-9]{64}$/.test(e.id) || typeof e.client !== 'string' || !Object.hasOwn(CODEX_CLIENTS,e.client) || typeof e.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(e.model) || typeof e.ts !== 'string' || !Number.isFinite(Date.parse(e.ts)) || Date.parse(e.ts) > now + 300000 || !['input','output','cacheRead','cacheWrite'].every(k => safe(e.usage?.[k]))) throw new Error('无效用量记录');
    return { eventId:e.id,ts:new Date(e.ts).toISOString(),model:e.model,client:CODEX_CLIENTS[e.client],providerId:'codex-local',kind:'observed',device,usage:Object.fromEntries(['input','output','cacheRead','cacheWrite'].map(k => [k,e.usage[k]])),reported:true,ok:null,path:'codex-local' };
  });
}

/** Codex 一轮推送（兼容入口；Mac 采集器统一走 syncObserved）。 */
export async function syncCodex({ sessionDir, stateFile, url, key, fetchFn = fetch, now = Date.now() }) {
  return syncObserved({ source: 'codex', collect: (state) => collectCodex({ sessionDir, state, now }), stateFile, url, key, fetchFn });
}
