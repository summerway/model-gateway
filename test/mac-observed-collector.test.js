// mac-observed-collector.test.js — MG7：Claude Code 本地采集（Mac 推送）+ 通用接收端 + 同一消息多行取最大值。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectClaude, parseClaudeLine, validateClaudeBatch } from '../src/monitor/claude-local.js';
import { syncObserved } from '../src/monitor/observed-push.js';
import { ClaudeUsageSync } from '../src/monitor/claude-usage-sync.js';
import { UsageLog, localDay } from '../src/monitor/store.js';
import { createRequestHandler } from '../src/gateway/router.js';
import { validateConfig } from '../src/config.js';

const now = Date.now();
const ts = (ago = 0) => new Date(now - ago).toISOString();
const line = (id, model, output = 20, ago = 1000) => JSON.stringify({
  type: 'assistant', timestamp: ts(ago),
  message: { id, model, content: [{ type: 'text', text: 'secret body' }], usage: { input_tokens: 100, cache_read_input_tokens: 5, cache_creation_input_tokens: 10, output_tokens: output } },
});

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mac-collector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseClaudeLine：只产出 claude-*，id 为 message.id 摘要，不含正文', () => {
  const ev = parseClaudeLine(JSON.parse(line('msg_1', 'claude-opus-5-5')));
  assert.match(ev.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(ev.usage, { input: 100, output: 20, cacheRead: 5, cacheWrite: 10 });
  assert.ok(!JSON.stringify(ev).includes('secret body'));
  assert.equal(parseClaudeLine(JSON.parse(line('msg_2', 'glm-5.3'))), null);
  assert.equal(parseClaudeLine({ type: 'user' }), null);
});

test('collectClaude：半行等下一轮、过滤非订阅模型、limit 内游标不越过未确认事件', (t) => {
  const dir = tempDir(t);
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const f = join(proj, 's.jsonl');
  writeFileSync(f, [line('a', 'claude-opus-5-5'), line('g', 'glm-5.3'), line('b', 'claude-haiku-5-5')].join('\n') + '\n' + line('c', 'claude-opus-5-5').slice(0, 30));
  const first = collectClaude({ projectsDir: dir, now, limit: 1 });
  assert.equal(first.events.length, 1);
  const second = collectClaude({ projectsDir: dir, state: first.state, now });
  assert.deepEqual(second.events.map((e) => e.model), ['claude-haiku-5-5']);
  appendFileSync(f, line('c', 'claude-opus-5-5').slice(30) + '\n');
  assert.equal(collectClaude({ projectsDir: dir, state: second.state, now }).events.length, 1);
  assert.deepEqual(Object.keys(first.events[0]).sort(), ['id', 'model', 'ts', 'usage']);
});

test('store：observed 同一 eventId 再到达取各计数最大值，日聚合补差值', () => {
  const log = new UsageLog({ now: () => now });
  const rows = (output) => validateClaudeBatch({ events: [{ ...parseClaudeLine(JSON.parse(line('m', 'claude-opus-5-5', output))) }] }, now);
  assert.equal(log.importObserved(rows(20)), 1);
  assert.equal(log.importObserved(rows(50)), 0);
  assert.equal(log.importObserved(rows(30)), 0, '更小的计数不回退');
  assert.equal(log.size, 1);
  assert.equal(log.buf[0].usage.output, 50);
  const day = log.queryDaily({ from: localDay(now - 86400000), to: localDay(now) });
  assert.equal(day.length, 1);
  assert.equal(day[0].records, 1);
  assert.equal(day[0].usage.output, 50);
});

test('NAS 同步：同一消息多行，后写的行 output 更大 → 计入更大值', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 's.jsonl'), [line('m1', 'claude-opus-5-5', 20), line('m1', 'claude-opus-5-5', 80)].join('\n') + '\n');
  const usageLog = new UsageLog({ file: null });
  const r = new ClaudeUsageSync({ sessionDir: dir, usageLog }).scan();
  assert.equal(r.records, 1);
  assert.equal(usageLog.buf[0].usage.output, 80);
  assert.equal(usageLog.buf[0].device, 'nas');
});

test('接收端 /internal/usage/observed：claude-code 来源、device、鉴权与幂等；syncObserved 端到端', async (t) => {
  process.env.TEST_OBS_KEY = 'obs-test-only';
  t.after(() => delete process.env.TEST_OBS_KEY);
  const cfg = validateConfig({
    gateway: { keys: ['k'] },
    providers: [{ id: 'p', type: 'openai', baseUrl: 'https://x/v1/chat/completions', apiKeyRef: 'env:K', models: ['m'] }],
    jobs: { activate: { enabled: false } },
    observedUsage: { enabled: true, apiKeyRef: 'env:TEST_OBS_KEY' },
  });
  assert.equal(cfg.codexUsage, cfg.observedUsage, '旧名 codexUsage 同义');
  const usageLog = new UsageLog({ now: () => now });
  const server = http.createServer(createRequestHandler({ config: cfg, catalog: { providers: cfg.providers }, usageLog }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, key = 'obs-test-only') => fetch(`${base}/internal/usage/observed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

  const ev = parseClaudeLine(JSON.parse(line('x', 'claude-opus-5-5')));
  assert.equal((await post({ source: 'claude-code', events: [ev] }, 'wrong')).status, 401);
  assert.equal((await post({ source: 'other', events: [] })).status, 400);
  assert.equal((await post({ source: 'claude-code', device: 'Bad Device', events: [] })).status, 400);
  assert.equal((await post({ source: 'claude-code', events: [{ ...ev, model: 'glm-5.3' }] })).status, 400, '非订阅模型拒收');
  assert.deepEqual(await (await post({ source: 'claude-code', device: 'mac-mini', events: [ev] })).json(), { accepted: 1, imported: 1 });
  assert.deepEqual(await (await post({ source: 'claude-code', events: [ev] })).json(), { accepted: 1, imported: 0 });
  const rec = usageLog.buf[0];
  assert.deepEqual([rec.kind, rec.device, rec.client, rec.path, rec.ok], ['observed', 'mac-mini', 'claude-code', 'claude-code', null]); // client 写入侧归一（claude-sub-sync → claude-code）

  // 采集器一轮：收集 → 推送 → 确认后保存游标
  const dir = tempDir(t);
  writeFileSync(join(dir, 's.jsonl'), line('y', 'claude-haiku-5-5') + '\n');
  const stateFile = join(dir, 'state', 'claude.json');
  const opts = { source: 'claude-code', collect: (state) => collectClaude({ projectsDir: dir, state, now }), stateFile, url: base, key: 'obs-test-only' };
  assert.equal(await syncObserved(opts), 1);
  assert.equal(await syncObserved(opts), 0, '游标已保存，不重复推送');
  assert.equal(usageLog.size, 2);
});
