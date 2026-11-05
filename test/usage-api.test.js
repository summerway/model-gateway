// usage-api.test.js — /internal/usage 聚合接口 + rangeToWindow + 端到端采集
// （mock 上游：非流式 usage、SSE 末 chunk usage、stream_options 注入、失败请求计入成功率）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { rangeToWindow } from '../src/monitor/internal-routes.js';
import { EventLog } from '../src/events.js';
import { UsageLog } from '../src/monitor/store.js';
import { PricingStore } from '../src/monitor/pricing.js';
import { validateConfig } from '../src/config.js';

function mockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function gateway({ config, catalog, usageLog, pricing, monitorProviders }) {
  return new Promise((resolve) => {
    const handler = createRequestHandler({
      config, catalog, events: new EventLog(100),
      quotaStore: { snapshot: () => ({}) },
      usageLog, pricing, monitorProviders,
    });
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function call(base, path, { method = 'GET', key = 'gw-test-key', body, headers = {} } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const KEY = 'gw-test-key';

async function internalCall(handler, path, remoteAddress = '127.0.0.1', headers = {}) {
  const res = {
    statusCode: null, body: '',
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; },
  };
  await handler({ method: 'GET', url: path, headers, socket: { remoteAddress } }, res);
  return { status: res.statusCode, data: JSON.parse(res.body) };
}

test('/internal/keys: 配置顺序、missing/conflict 自检、脱敏、当日用量及历史来源', async (t) => {
  const prefix = 'MGW_ATTRIBUTION_TEST_';
  const env = { FIRST: 'first-test-key-1234', SECOND: 'second-test-key-5678', CONFLICT: 'first-test-key-1234' };
  for (const [name, value] of Object.entries(env)) {
    const old = process.env[prefix + name];
    process.env[prefix + name] = value;
    t.after(() => { if (old === undefined) delete process.env[prefix + name]; else process.env[prefix + name] = old; });
  }
  const missing = prefix + 'MISSING';
  const oldMissing = process.env[missing];
  delete process.env[missing];
  t.after(() => { if (oldMissing !== undefined) process.env[missing] = oldMissing; });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const events = new EventLog(100);
  const now = new Date(2026, 9, 26, 12).getTime();
  const usageLog = new UsageLog({ file: null, now: () => now });
  const add = (client, ts, reported = true) => usageLog.record({
    client, ts: new Date(ts).toISOString(), model: 'm1', reported,
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 5 },
  });
  // 故意乱序：lastSeen 取时间最大值，不能依赖追加顺序或今日窗口。
  add('pi-agent', now - 1000);
  add('pi-agent', now - 86400000);
  add('pi-agent', now - 2000, false);
  add('claude-sub-sync', now - 3000);
  add(null, now - 4000);
  add('retired-app', now - 86400000);
  const config = validateConfig({
    gateway: { keys: [
      { key: 'env:' + prefix + 'FIRST', app: 'pi-agent', note: 'models.json' },
      { key: 'env:' + missing, app: 'mac-pi', note: 'Mac models.json' },
      { key: 'env:' + prefix + 'CONFLICT', app: 'openclaw' },
      { key: 'env:' + prefix + 'SECOND', app: 'shared', note: '' },
      { key: 'literal-test-key-9012', app: 'codex' },
    ] },
    providers: [{ id: 'p', type: 'openai', baseUrl: 'http://localhost/v1/chat/completions', apiKeyRef: 'env:UPSTREAM', models: ['m1'] }],
    jobs: { activate: { model: 'm1' } },
  });
  const handler = createRequestHandler({ config, catalog: { providers: [] }, events, usageLog });
  const { status, data } = await internalCall(handler, '/internal/keys');
  assert.equal(status, 200);
  assert.deepEqual(data.keys, [
    { agent: null, app: 'pi-agent', note: 'models.json', status: 'ok', masked: '…1234', lastSeen: new Date(now - 1000).toISOString(), today: { requests: 2, tokens: 20 } },
    { agent: null, app: 'mac-pi', note: 'Mac models.json', status: 'missing', masked: null, lastSeen: null, today: { requests: 0, tokens: 0 } },
    { agent: null, app: 'openclaw', note: null, status: 'conflict', masked: '…1234', lastSeen: null, today: { requests: 0, tokens: 0 } },
    { agent: null, app: 'shared', note: '', status: 'ok', masked: '…5678', lastSeen: null, today: { requests: 0, tokens: 0 } },
    { agent: null, app: 'codex', note: null, status: 'ok', masked: '…9012', lastSeen: null, today: { requests: 0, tokens: 0 } },
  ]);
  assert.deepEqual(data.extraClients.map((c) => c.client).sort(), ['claude-code', null, 'retired-app'].sort());
  const retired = data.extraClients.find((c) => c.client === 'retired-app');
  assert.equal(retired.lastSeen, new Date(now - 86400000).toISOString());
  assert.deepEqual(retired.today, { requests: 0, tokens: 0 });
  assert.deepEqual(events.list({ type: 'gateway_key_missing' }).map(({ app, ref }) => ({ app, ref })), [{ app: 'mac-pi', ref: 'env:' + missing }]);
  assert.deepEqual(events.list({ type: 'gateway_key_conflict' }).map(({ apps }) => apps), [['pi-agent', 'openclaw']]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /gateway_key_missing/);
  assert.match(errors[1], /gateway_key_conflict/);
  const diagnostics = JSON.stringify({ data, events: events.list(), errors });
  for (const secret of [...Object.values(env), 'literal-test-key-9012']) assert.ok(!diagnostics.includes(secret));
  assert.ok(usageLog.buf.some((r) => r.client === null)); // 不回填旧记录

  // 同值冲突 key 仍归先出现的 app；失败请求也保留调用方归因。
  const gw = await gateway({ config, catalog: { providers: [] }, usageLog });
  try {
    const response = await call(gw.url, '/v1/chat/completions', {
      method: 'POST', key: env.FIRST, body: { model: 'm1', messages: [] },
    });
    assert.equal(response.status, 503);
    assert.equal(usageLog.buf.at(-1).client, 'pi-agent');
  } finally { gw.server.close(); }
});

test('/internal/keys: 与 usage 共用内部 IP 门禁，外部 IP 即使携 key 也 403', async () => {
  const handler = createRequestHandler({ config: { gateway: { keys: [KEY] } }, catalog: { providers: [] }, events: new EventLog(10) });
  for (const path of ['/internal/keys', '/internal/usage']) {
    assert.equal((await internalCall(handler, path, '203.0.113.1', { authorization: `Bearer ${KEY}` })).status, 403);
  }
  const empty = await internalCall(handler, '/internal/keys');
  assert.deepEqual(empty.data, {
    agents: [], agentSource: { configured: false, loadedAt: null, stale: false, error: null },
    topology: { appGroups: [], collectors: [], directConnections: [] },
    keys: [{ app: 'shared', agent: null, note: null, status: 'ok', masked: '…-key', lastSeen: null, today: { requests: 0, tokens: 0 } }], extraClients: [],
  });
});

test('/internal/keys exposes direct-only topology metadata without credential fields', async () => {
  const topology = {
    appGroups: [{ id: 'tools', label: '工具', icon: 'business', apps: ['shared'], apiKey: 'private-value' }],
    collectors: [{ id: 'sync', label: 'Mac 采集', apiKeyRef: 'env:PRIVATE_SYNC_KEY' }],
    directConnections: [{ app: 'claude-code', device: 'mac', providerId: 'claude', collectorId: 'sync', secret: 'private-value' }],
  };
  const handler = createRequestHandler({ config: { gateway: { keys: [KEY] }, topology }, catalog: { providers: [] }, events: new EventLog(10) });
  const { status, data } = await internalCall(handler, '/internal/keys');
  assert.equal(status, 200);
  assert.deepEqual(data.topology, {
    appGroups: [{ id: 'tools', label: '工具', icon: 'business', apps: ['shared'] }],
    collectors: [{ id: 'sync', label: 'Mac 采集' }],
    directConnections: [{ app: 'claude-code', device: 'mac', providerId: 'claude', collectorId: 'sync' }],
  });
  assert.equal(JSON.stringify(data).includes('private-value'), false);
  assert.equal(JSON.stringify(data).includes('PRIVATE_SYNC_KEY'), false);
});

test('rangeToWindow: today/yday/7d/30d/24h 窗口与桶粒度', () => {
  const now = new Date(2026, 8, 29, 10, 30, 0);
  const today = rangeToWindow('today', now);
  assert.equal(today.from.getDate(), 29); assert.equal(today.from.getHours(), 0);
  assert.equal(today.unit, 'hour'); assert.equal(today.to.getTime(), now.getTime());
  const yday = rangeToWindow('yday', now);
  assert.equal(yday.from.getDate(), 28); assert.equal(yday.to.getDate(), 29);
  assert.equal(yday.to.getHours(), 0); assert.equal(yday.unit, 'hour');
  const d7 = rangeToWindow('7d', now);
  assert.equal(d7.from.getDate(), 22); assert.equal(d7.unit, 'day');
  const d30 = rangeToWindow('30d', now);
  assert.equal(d30.unit, 'day');
  // 24h 滚动窗口（日志›请求）：跨零点不断档 —— from = now - 24h（昨日 10:30），非自然日起点
  const h24 = rangeToWindow('24h', now);
  assert.equal(h24.from.getTime(), now.getTime() - 24 * 3600e3);
  assert.equal(h24.from.getDate(), 28); assert.equal(h24.from.getHours(), 10); assert.equal(h24.from.getMinutes(), 30);
  assert.equal(h24.to.getTime(), now.getTime()); assert.equal(h24.unit, 'hour');
  assert.equal(rangeToWindow('whatever', now).unit, 'hour'); // 默认 today
});

test('端到端：非流式 usage 采集 + /internal/usage 聚合 + 定价折算', async () => {
  const upstream = await mockUpstream((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 } },
      }));
    });
  });
  const usageLog = new UsageLog();
  const pricing = new PricingStore({
    overrides: { 'm1': { input: 2, output: 8, cacheRead: 0.4, cacheWrite: 0 } },
    fetchFn: async () => { throw new Error('offline test'); },
  }).start();
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`, apiKeyRef: 'test-key', models: ['m1'] }] },
    usageLog, pricing,
  });
  try {
    const r = await call(gw.url, '/v1/chat/completions', { method: 'POST', body: { model: 'm1', messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(r.status, 200);
    const agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.equal(agg.enabled !== false, true);
    assert.equal(agg.totals.requests, 1);
    assert.equal(agg.totals.input, 200);
    assert.equal(agg.totals.output, 300);
    assert.equal(agg.totals.cacheRead, 1000);
    // 200 input*2 + 300 output*8 + 1000 cacheRead*0.4（/1e6 后极小）
    assert.ok(agg.totals.cost > 0 && agg.totals.cost < 0.01);
    assert.equal(agg.filters.providers[0].id, 'primary');
    assert.deepEqual(agg.filters.models, [{ id: 'm1', name: 'm1' }]);
    assert.equal(agg.logs.length, 1);
    assert.equal(agg.logs[0].providerId, 'primary');
    assert.equal(agg.logs[0].stream, false);
    assert.equal(agg.logs[0].ok, true);
  } finally {
    gw.server.close(); upstream.server.close(); pricing.stop();
  }
});

test('端到端：SSE 流 usage 采集 + openai 上游 stream_options 注入', async () => {
  let seenBody = null;
  const upstream = await mockUpstream((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seenBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":850}}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const usageLog = new UsageLog();
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`, apiKeyRef: 'test-key', models: ['m1'] }] },
    usageLog,
  });
  try {
    const r = await call(gw.url, '/v1/chat/completions', { method: 'POST', body: { model: 'm1', stream: true, messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(r.status, 200);
    const text = await r.text(); // 读完整流，管道走完才落 usage
    assert.ok(text.includes('[DONE]'));
    assert.deepEqual(seenBody.stream_options, { include_usage: true }); // 注入了 include_usage
    const agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.equal(agg.totals.requests, 1);
    assert.equal(agg.totals.cacheRead, 850);
    assert.equal(agg.totals.input, 50); // 900 - 850
    assert.equal(agg.logs[0].stream, true);
  } finally {
    gw.server.close(); upstream.server.close();
  }
});

test('端到端：上游 4xx/5xx 全链失败计入失败率；usage 为空标未上报口径不计', async () => {
  const upstream = await mockUpstream((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  const usageLog = new UsageLog();
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`, apiKeyRef: 'test-key', models: ['m1'] }] },
    usageLog,
  });
  try {
    const r = await call(gw.url, '/v1/chat/completions', { method: 'POST', body: { model: 'm1', messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(r.status, 502); // 链耗尽
    const agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.equal(agg.totals.requests, 1);
    assert.equal(agg.totals.ok, 0);
    assert.equal(agg.totals.failed, 1);
    assert.equal(agg.totals.unreported, 0); // 失败请求不挤占未上报口径
  } finally {
    gw.server.close(); upstream.server.close();
  }
});

test('端到端：旧 /usage 路径 301 到看板用量视图；/internal/usage 外网 403 逻辑同其他 internal 接口', async () => {
  const usageLog = new UsageLog();
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [] },
    usageLog,
  });
  try {
    // MG24：旧独立页下线，301 → /#usage-summary（查询串丢弃）
    const page = await fetch(gw.url + '/usage?range=7d', { redirect: 'manual' });
    assert.equal(page.status, 301);
    assert.equal(page.headers.get('location'), '/#usage-summary');
  } finally {
    gw.server.close();
  }
});

test('GET /internal/usage: 明细分页 — 默认 50，logLimit 白名单 50/100/200，白名单外回退', async () => {
  const usageLog = new UsageLog();
  const now = Date.now();
  for (let i = 0; i < 120; i++) {
    usageLog.record({
      ts: new Date(now - i * 1000).toISOString(),
      providerId: 'p', model: 'm1', upstreamModel: 'm1',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, reported: true,
    });
  }
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [{ id: 'p', type: 'openai', baseUrl: 'http://127.0.0.1:65530/v1', apiKeyRef: 'k', models: ['m1'] }] },
    usageLog,
  });
  try {
    const q = async (extra) => (await (await call(gw.url, `/internal/usage?range=today${extra}`, { key: null })).json()).logs.length;
    assert.equal(await q(''), 50);
    assert.equal(await q('&logLimit=100'), 100);
    assert.equal(await q('&logLimit=200'), 120); // 不足 200 全量返回
    assert.equal(await q('&logLimit=999'), 50); // 白名单外回退默认
  } finally {
    gw.server.close();
  }
});

test('GET /internal/usage: 模型筛选下拉含监控位（claude）模型', async () => {
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    usageLog: new UsageLog(),
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1/chat/completions', apiKeyRef: 'test-key', models: ['m1'] }] },
    monitorProviders: [{
      id: 'claude', type: 'claude', monitor: true, displayName: 'Claude',
      models: ['claude-opus-5-5'], modelDefs: {}, visionRouting: {}, fallbackModelMap: {},
    }],
  });
  try {
    const agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.deepEqual(agg.filters.models, [{ id: 'm1', name: 'm1' }, { id: 'claude-opus-5-5', name: 'claude-opus-5-5' }]);
    assert.deepEqual(agg.filters.providers.map((p) => p.id), ['primary', 'claude']);
  } finally {
    gw.server.close();
  }
});

test('端到端：终止标记后客户端断开记成功（无 client_abort 事件）；标记前断开记客户端中断', async () => {
  const events = new EventLog(100);
  const usageLog = new UsageLog();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 上游：先发首块，等 400ms 再发终止标记 + [DONE]，再等 400ms 才 end——
  // 给客户端留出「标记前断开」与「标记后断开」两个确定性窗口
  const upstream = await mockUpstream((req, res) => {
    res.on('error', () => {}); // 客户端断开后上游写失败会抛 EPIPE，吞掉
    req.on('error', () => {});
    (async () => {
      try {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
        await sleep(400);
        res.write('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\n');
        res.write('data: [DONE]\n\n');
        await sleep(400);
        res.end();
      } catch { /* socket 已关 */ }
    })();
  });
  const gw = await new Promise((resolve) => {
    const handler = createRequestHandler({
      config: { gateway: { keys: [KEY] } },
      catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`, apiKeyRef: 'test-key', models: ['m1'] }] },
      events, usageLog, pricing: null, monitorProviders: [],
    });
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });

  /** 流式请求，读到 stopAfter 出现即 cancel（模拟 codex CLI 的主动断开） */
  async function streamUntil(stopAfter) {
    const r = await call(gw.url, '/v1/chat/completions', {
      method: 'POST', body: { model: 'm1', stream: true, messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
      if (text.includes(stopAfter)) { await reader.cancel(); break; }
    }
  }

  try {
    // 场景 A：标记前断开 → 失败账 + clientAbort 标记 + client_abort 事件
    await streamUntil('"he"');
    await sleep(150); // 等 finally 落账
    let agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.equal(agg.totals.clientAborts, 1);
    assert.equal(agg.totals.failed, 0);
    assert.equal(agg.totals.ok, 0);
    assert.equal(agg.logs.find((l) => l.clientAbort)?.clientAbort, true);
    assert.equal(events.list({ type: 'client_abort' }).length, 1);

    // 场景 B：收到 [DONE] 后断开 → 记成功，无 client_abort 事件、无 clientAbort 标记
    await streamUntil('[DONE]');
    await sleep(150);
    agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.equal(agg.totals.ok, 1);
    assert.equal(agg.totals.failed, 0);
    assert.equal(agg.totals.clientAborts, 1); // 仍是场景 A 那一条
    const okRow = agg.logs.find((l) => l.ok && l.usage);
    assert.equal(okRow?.status, 200);
    assert.equal(okRow?.clientAbort, undefined);
    assert.equal(events.list({ type: 'client_abort' }).length, 1); // 未新增
  } finally {
    gw.server.close(); upstream.server.close();
  }
});

// ── pricingMissing 口径（2026-10-22）：models.dev 为名称/属性唯一权威 ──
// ①尖括号伪 id（<synthetic> 等 CLI 合成占位）剔除；②models.dev 已收录且
// type:image（按张计价，无 token 价格）不算缺定价；③未收录 id（真异常）保留。
test('pricingMissing: 伪 id 与 image 型剔除，未知 id 保留上报', async () => {
  // Query uses an exclusive upper bound; fixture records must precede query time.
  const now = new Date(Date.now() - 1000).toISOString();
  const usageLog = new UsageLog();
  for (const model of ['m1', '<synthetic>', 'gpt-image-1.5', 'ghost-model-x']) {
    usageLog.record({ ts: now, path: '/v1/chat/completions', providerId: 'primary', model, upstreamModel: model, stream: false, status: 200, ok: true, latencyMs: 5, usage: { input: 10, output: 5 }, reported: false });
  }
  const apiJson = {
    openai: {
      models: {
        'gpt-image-1.5': { type: 'image', modalities: { input: ['text'] }, cost: null },
      },
    },
  };
  const pricing = new PricingStore({
    overrides: { m1: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
    fetchFn: async () => ({ ok: true, status: 200, json: async () => apiJson }),
  }).start();
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKeyRef: 'test-key', models: ['m1'] }] },
    usageLog, pricing,
  });
  try {
    await pricing.ready; // 等 models.dev（fake）条目就位
    const agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.equal(agg.pricingMissing.length, 1);
    assert.equal(agg.pricingMissing[0], 'ghost-model-x'); // <synthetic>、gpt-image-1.5 均被口径排除
  } finally {
    gw.server.close(); pricing.stop();
  }
});

test('GET /internal/usage: 向量展示位（dashscope）进筛选器（用量按 providerId=dashscope 落账）', async () => {
  const gw = await gateway({
    config: {
      gateway: { keys: [KEY] },
      embeddings: {
        type: 'dashscope', apiKeyRef: 'env:EMB_KEY', workspaceIdRef: 'env:EMB_WS',
        models: ['text-embedding-v4'], defaultDimensions: 1024,
      },
    },
    usageLog: new UsageLog(),
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1/chat/completions', apiKeyRef: 'test-key', models: ['m1'] }] },
  });
  try {
    const agg = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.deepEqual(agg.filters.providers.map((p) => p.id), ['primary', 'dashscope']);
    assert.deepEqual(agg.filters.providers[1], { id: 'dashscope', name: '阿里云百炼' });
    assert.deepEqual(agg.filters.models, [{ id: 'm1', name: 'm1' }, { id: 'text-embedding-v4', name: 'text-embedding-v4' }]);
  } finally {
    gw.server.close();
  }
});

test('端到端：per-app key 归因 —— client 落进 usage 记录 + /internal/usage client 筛选与来源分布', async () => {
  const upstream = await mockUpstream((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  const APP_KEY = 'gw-app-key';
  const LEGACY_KEY = 'gw-legacy-key';
  const usageLog = new UsageLog();
  const gw = await gateway({
    // 混合形态：结构化条目 + 裸字符串（兼容旧配置，归 shared）
    config: { gateway: { keys: [
      { key: KEY, app: 'shared' },
      { key: APP_KEY, app: 'kb-service' },
      LEGACY_KEY,
    ] } },
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`, apiKeyRef: 'test-key', models: ['m1'] }] },
    usageLog,
  });
  const ua = 'shared-client/'.repeat(15);
  const chat = (key) => call(gw.url, '/v1/chat/completions', {
    method: 'POST', key, headers: { 'user-agent': key === LEGACY_KEY ? '' : ua },
    body: { model: 'm1', messages: [{ role: 'user', content: 'x' }] },
  });
  try {
    // 拒绝行为与旧版一致：无 key / 错 key 仍 401
    assert.equal((await chat(null)).status, 401);
    assert.equal((await chat('wrong-key')).status, 401);
    // app key → client=kb-service；显式 shared 与裸字符串 key → client=shared
    assert.equal((await chat(APP_KEY)).status, 200);
    assert.equal((await chat(KEY)).status, 200);
    assert.equal((await chat(LEGACY_KEY)).status, 200);
    // query 窗口上界不包含 to；确保时钟越过最后一条记录，避免同毫秒查询漏行。
    const lastTs = Date.parse(usageLog.buf.at(-1).ts);
    while (Date.now() <= lastTs) await new Promise((resolve) => setTimeout(resolve, 1));
    const all = await (await call(gw.url, '/internal/usage?range=today', { key: null })).json();
    assert.equal(all.totals.requests, 3);
    assert.deepEqual(all.logs.map((l) => l.client).sort(), ['kb-service', 'shared', 'shared']);
    assert.equal(all.logs.filter((l) => l.ua).length, 1);
    assert.equal(all.logs.find((l) => l.ua)?.ua, ua.slice(0, 120));
    assert.ok(all.logs.filter((l) => l.client !== 'shared').every((l) => !('ua' in l)));
    // client 筛选参数
    const kb = await (await call(gw.url, '/internal/usage?range=today&client=kb-service', { key: null })).json();
    assert.equal(kb.totals.requests, 1);
    assert.equal(kb.logs[0].client, 'kb-service');
    const none = await (await call(gw.url, '/internal/usage?range=today&client=__unmarked__', { key: null })).json();
    assert.equal(none.totals.requests, 0); // 新记录都有 client，历史空 client 才命中
    // 来源分布聚合 + 筛选下拉（配置 app ∪ 观测来源）
    assert.ok(Array.isArray(all.clients));
    const kbRow = all.clients.find((c) => c.client === 'kb-service');
    assert.equal(kbRow.total.requests, 1);
    assert.equal(kbRow.total.tokens, 120); // 100 + 20
    assert.ok(kbRow.today.requests >= 0); // 跨午夜边界时当日可为 0，total 恒准
    assert.ok(Array.isArray(kbRow.buckets) && kbRow.buckets.length > 0);
    assert.deepEqual(all.filters.clients, ['kb-service', 'shared']); // 无 unmarked 观测 → 无哨兵项
  } finally {
    gw.server.close(); upstream.server.close();
  }
});

test('usage api: provider=codex 归并 codex-local 订阅直连流量（OpenAI 渠道口径）', async () => {
  const usageLog = new UsageLog();
  const now = new Date().toISOString();
  usageLog.record({ ts: now, path: '/v1/chat/completions', kind: 'served', client: 'pi', providerId: 'codex', model: 'gpt-6-astra', usage: { input: 100, output: 50 }, reported: true, ok: true });
  usageLog.record({ ts: now, kind: 'observed', device: 'mac', client: 'codex-local-app', providerId: 'codex-local', model: 'gpt-6-astra', usage: { input: 900, output: 100 }, reported: true });
  // query 窗口上界不包含 to；等时钟越过记录时间，避免同毫秒查询漏行。
  while (Date.now() <= Date.parse(now)) await new Promise((resolve) => setTimeout(resolve, 1));
  const gw = await gateway({ config: { gateway: { keys: [KEY] } }, catalog: { providers: [] }, usageLog });
  try {
    const merged = await (await call(gw.url, '/internal/usage?range=today&provider=codex', { key: null })).json();
    assert.equal(merged.totals.tokens, 1150); // served 150 + 订阅直连 1000
    assert.equal(merged.totals.requests, 1);  // 请求数只计经网关
    assert.equal(merged.totals.subscriptionRecords, 1);
    const only = await (await call(gw.url, '/internal/usage?range=today&provider=codex-local', { key: null })).json();
    assert.equal(only.totals.tokens, 1000); // 单选订阅直连仍可隔离观察
    const other = await (await call(gw.url, '/internal/usage?range=today&provider=glm-primary', { key: null })).json();
    assert.equal(other.totals.tokens, 0); // 其余 provider 不受归并影响
  } finally {
    gw.server.close();
  }
});

// ── 空名录 fail-open 回归（2026-10-30 生产事故：容器重启后 models.dev 拉取失败，
// namesSnapshot() 返回空对象 {}（truthy），displayModelFilter 把所有无本地覆盖定价的
// 模型判「未收录」全部剔除，daily 只剩 text-embedding-v4）──
test('daily: 名录空快照不过滤，展示保活', async () => {
  const now = new Date(Date.now() - 1000).toISOString();
  const usageLog = new UsageLog();
  usageLog.record({ ts: now, path: '/v1/chat/completions', providerId: 'primary', model: 'm1', upstreamModel: 'm1', stream: false, status: 200, ok: true, latencyMs: 5, usage: { input: 10, output: 5 }, reported: true });
  const pricing = {
    fetchedAt: 1,
    namesSnapshot: () => ({}), // 拉取失败 + 无落盘缓存：空对象而非 null
    typeFor: () => null,
    costFor: () => null,
    costOf: () => 0,
  };
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKeyRef: 'test-key', models: ['m1'] }] },
    usageLog, pricing,
  });
  try {
    const byModel = await (await call(gw.url, '/internal/usage/daily?groupBy=model', { key: null })).json();
    assert.ok(byModel.rows.some((r) => r.model === 'm1'), `空名录不应剔除模型，实际 ${JSON.stringify(byModel.rows)}`);
  } finally {
    gw.server.close();
  }
});

// ── daily 展示口径回归（2026-10-29 生产事故：rows.filter(modelOk) 误把整行对象
// 当模型 id 传给谓词，全部日聚合行被过滤，网关页渠道/模型加载为空）──
test('daily: 谓词接模型 id 而非整行；零 token 失败模型不进模型维度', async () => {
  const now = new Date(Date.now() - 1000).toISOString();
  const usageLog = new UsageLog();
  for (const spec of [
    { model: 'm1', ok: true, status: 200, reported: true, usage: { input: 10, output: 5 } },
    { model: 'ghost-img', ok: false, status: 403, reported: false, usage: { input: 0, output: 0 } }, // 误配失败：零 token
    { model: '<synthetic>', ok: true, status: 200, reported: true, usage: { input: 3, output: 1 } }, // 伪 id
  ]) {
    usageLog.record({ ts: now, path: '/v1/chat/completions', providerId: 'primary', model: spec.model, upstreamModel: spec.model, stream: false, status: spec.status, ok: spec.ok, latencyMs: 5, usage: spec.usage, reported: spec.reported });
  }
  const pricing = {
    fetchedAt: 1,
    namesSnapshot: () => ({ m1: 'M1', 'ghost-img': 'Ghost' }),
    typeFor: () => null,
    costFor: () => null,
    costOf: () => 0,
  };
  const gw = await gateway({
    config: { gateway: { keys: [KEY] } },
    catalog: { providers: [{ id: 'primary', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKeyRef: 'test-key', models: ['m1'] }] },
    usageLog, pricing,
  });
  try {
    const byModel = await (await call(gw.url, '/internal/usage/daily?groupBy=model', { key: null })).json();
    const ms = byModel.rows.map((r) => r.model);
    assert.ok(ms.includes('m1'), `m1 应保留，实际 ${JSON.stringify(ms)}`);
    assert.ok(!ms.includes('<synthetic>'), '伪 id 不进展示');
    assert.ok(!ms.includes('ghost-img'), '零 token 失败模型不进模型维度');
    const raw = await (await call(gw.url, '/internal/usage/daily', { key: null })).json();
    assert.ok(raw.rows.some((r) => r.model === 'm1'), '原始行不应被整行误杀');
  } finally {
    gw.server.close();
  }
});
