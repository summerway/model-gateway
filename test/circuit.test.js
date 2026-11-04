// circuit.test.js — provider 熔断器（issue #3）：状态机单元 + 链排序接入 +
// 全流程（mock 上游）验收。对应 issue 验收标准 1-5。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CircuitBreaker } from '../src/gateway/fallback/circuit.js';
import { orderChainByQuota, createRequestHandler } from '../src/gateway/router.js';
import { EventLog } from '../src/events.js';

// ── 单元：状态机 ────────────────────────────────────────────────────────────

function breakerWith({ threshold = 2, cooldownSec = 120, events = new EventLog(50) } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const b = new CircuitBreaker({
    providers: [{ id: 'p1' }, { id: 'p2' }],
    circuit: { failureThreshold: threshold, cooldownSec },
    events,
    now,
  });
  return { b, events, advance: (ms) => { t += ms; } };
}

test('circuit: gateway timeout（reason timeout）不计入熔断（2026-10-26 修订）', () => {
  const { b } = breakerWith({ threshold: 3 });
  for (let i = 0; i < 5; i++) b.recordFailure('p1', { reason: 'timeout' });
  assert.equal(b.phase('p1'), 'closed', 'timeout failures must not open the breaker');
  assert.equal(b.isDemoted('p1'), false);
});

test('circuit: N 次 retriable 失败 → open + circuit_open（episode 单条）', () => {
  const { b, events } = breakerWith({ threshold: 3 });
  b.recordFailure('p1', { reason: 'server_error', status: 500 });
  b.recordFailure('p1', { reason: 'network' });
  assert.equal(b.phase('p1'), 'closed'); // 未到阈值
  b.recordFailure('p1', { reason: 'rate_limited', status: 429 });
  assert.equal(b.phase('p1'), 'open');
  assert.equal(b.isDemoted('p1'), true);
  let evs = events.list({ type: 'circuit_open' });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].providerId, 'p1');
  assert.equal(evs[0].failures, 3);
  // open 期间继续失败：冷却顺延，不开新 episode
  b.recordFailure('p1', { reason: 'server_error' });
  assert.equal(events.list({ type: 'circuit_open' }).length, 1);
  assert.equal(b.phase('p1'), 'open');
});

test('circuit: 冷却期满 → half_open 回自然位；试探成功 → circuit_close', () => {
  const { b, events, advance } = breakerWith({ threshold: 2, cooldownSec: 60 });
  b.recordFailure('p1', { reason: 'server_error' });
  b.recordFailure('p1', { reason: 'server_error' });
  assert.equal(b.phase('p1'), 'open');
  advance(61 * 1000);
  assert.equal(b.phase('p1'), 'half_open');
  assert.equal(b.isDemoted('p1'), false); // 不再降级 → 下一个请求即试探
  b.recordSuccess('p1');
  assert.equal(b.phase('p1'), 'closed');
  const evs = events.list({ type: 'circuit_close' });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].providerId, 'p1');
});

test('circuit: half_open 试探失败 → 重新 open（无新 circuit_open 事件）', () => {
  const { b, events, advance } = breakerWith({ threshold: 2, cooldownSec: 60 });
  b.recordFailure('p1', { reason: 'network' });
  b.recordFailure('p1', { reason: 'network' });
  advance(61 * 1000);
  assert.equal(b.phase('p1'), 'half_open');
  b.recordFailure('p1', { reason: 'network' }); // 试探失败
  assert.equal(b.phase('p1'), 'open');
  assert.equal(b.isDemoted('p1'), true); // 冷却重启
  assert.equal(events.list({ type: 'circuit_open' }).length, 1); // episode 不重复
});

test('circuit: client_error 不计数；成功清零连续计数', () => {
  const { b } = breakerWith({ threshold: 2 });
  b.recordFailure('p1', { reason: 'client_error', status: 400 });
  b.recordFailure('p1', { reason: 'client_error', status: 401 });
  assert.equal(b.phase('p1'), 'closed');
  b.recordFailure('p1', { reason: 'server_error' });
  b.recordSuccess('p1'); // 清零
  b.recordFailure('p1', { reason: 'server_error' });
  assert.equal(b.phase('p1'), 'closed'); // 仍是 1 连续，未达 2
  b.recordFailure('p1', { reason: 'server_error' });
  assert.equal(b.phase('p1'), 'open');
});

test('circuit: enabled=false 全退化；未知 provider 惰性注册', () => {
  const { b } = breakerWith({ threshold: 1 });
  const off = new CircuitBreaker({ circuit: { enabled: false } });
  off.recordFailure('x', { reason: 'network' });
  assert.equal(off.isDemoted('x'), false);
  assert.equal(off.phase('x'), 'closed');
  // 惰性：构造时未列出的 provider 首次记录即建 state
  b.recordFailure('unknown-id', { reason: 'network' });
  assert.equal(b.phase('unknown-id'), 'open'); // threshold 1
  assert.ok(b.snapshot()['unknown-id']);
});

// ── 排序接入：orderChainByQuota 同 seam ─────────────────────────────────────

test('orderChain: 熔断降级与配额降级同 seam，均到链尾且不移除', () => {
  const chain = [
    { id: 'a', type: 'openai', models: ['m1'] },
    { id: 'b', type: 'glm', models: ['m1'] },
    { id: 'c', type: 'openai', models: ['m1'] },
  ];
  const quotaSnap = { b: { ok: true, stale: false, tiers: { fiveHour: { usedPercent: 100 } } } };
  const breakerStub = { isDemoted: (id) => id === 'a' };
  // a 熔断 + b 配额用满 → 都到尾，相对序稳定，链成员不变
  const ordered = orderChainByQuota(chain, quotaSnap, { breaker: breakerStub });
  assert.deepEqual(ordered.map((p) => p.id), ['c', 'a', 'b']);
  assert.equal(ordered.length, chain.length);
  // half_open（isDemoted false）→ 回自然位
  const half = { isDemoted: () => false };
  assert.deepEqual(orderChainByQuota(chain, {}, { breaker: half }).map((p) => p.id), ['a', 'b', 'c']);
  // 不注入 breaker → 现状行为不变
  assert.deepEqual(orderChainByQuota(chain, quotaSnap).map((p) => p.id), ['a', 'c', 'b']);
});

// ── 全流程：mock 上游（验收标准 1/3/4/5）────────────────────────────────────

function mockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function gateway({ config, catalog, events, breaker }) {
  return new Promise((resolve) => {
    const handler = createRequestHandler({
      config, catalog, events, circuitBreaker: breaker,
      quotaStore: { snapshot: () => ({}) },
    });
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function chatBody(model = 'm1') {
  return { model, messages: [{ role: 'user', content: 'hi' }] };
}

function call(base, body) {
  return fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw-test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const okJson = (res, model = 'm1') => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', model, choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 1 } }));
};

test('e2e 验收1: 连续 5xx → circuit_open，后续请求不再先打该 provider', async () => {
  const events = new EventLog(100);
  const breaker = new CircuitBreaker({ circuit: { failureThreshold: 2, cooldownSec: 600 }, events });
  let primaryHits = 0;
  const primary = await mockUpstream((req, res) => {
    primaryHits += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  const backup = await mockUpstream((req, res) => okJson(res));
  const catalog = {
    providers: [
      { id: 'primary', type: 'openai', baseUrl: `http://127.0.0.1:${primary.port}/v1/chat/completions`, apiKeyRef: 'env:TEST_PRIMARY_KEY', models: ['m1'] },
      { id: 'backup', type: 'openai', baseUrl: `http://127.0.0.1:${backup.port}/v1/chat/completions`, apiKeyRef: 'env:TEST_BACKUP_KEY', models: ['m1'] },
    ],
  };
  const config = { gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] } };
  const gw = await gateway({ config, catalog, events, breaker });
  process.env.TEST_PRIMARY_KEY = 'sk';
  process.env.TEST_BACKUP_KEY = 'sk';
  try {
    // 两个请求，每个都先撞 primary 失败再由 backup 兜底 → 2 次失败达阈值
    for (let i = 0; i < 2; i++) {
      const r = await call(gw.url, chatBody());
      assert.equal(r.status, 200);
    }
    assert.equal(primaryHits, 2);
    const opened = events.list({ type: 'circuit_open' });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].providerId, 'primary');
    assert.equal(breaker.phase('primary'), 'open');

    // 第 3 个请求：primary 已降级链尾，backup 直接接棒 → primary 零新命中
    const r3 = await call(gw.url, chatBody());
    assert.equal(r3.status, 200);
    assert.equal(primaryHits, 2, '熔断后不再先打 primary');
    assert.equal(breaker.phase('backup'), 'closed');
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    primary.server.close();
    backup.server.close();
    gw.server.close();
  }
});

test('e2e 验收3: 单 provider 链（仅剩被熔断者）→ 请求仍发出且可成功恢复', async () => {
  const events = new EventLog(100);
  const breaker = new CircuitBreaker({ circuit: { failureThreshold: 1, cooldownSec: 600 }, events });
  let fail = true;
  let hits = 0;
  const solo = await mockUpstream((req, res) => {
    hits += 1;
    if (fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    } else okJson(res);
  });
  const catalog = {
    providers: [
      { id: 'solo', type: 'openai', baseUrl: `http://127.0.0.1:${solo.port}/v1/chat/completions`, apiKeyRef: 'env:TEST_SOLO_KEY', models: ['m1'] },
    ],
  };
  const config = { gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] } };
  const gw = await gateway({ config, catalog, events, breaker });
  process.env.TEST_SOLO_KEY = 'sk';
  try {
    const r1 = await call(gw.url, chatBody());
    assert.equal(r1.status, 502); // 链耗尽
    assert.equal(breaker.phase('solo'), 'open');
    fail = false;
    const r2 = await call(gw.url, chatBody()); // 仍发出（不移除）→ 成功 → 恢复
    assert.equal(r2.status, 200);
    assert.equal(breaker.phase('solo'), 'closed');
    assert.equal(events.list({ type: 'circuit_close' }).length, 1);
  } finally {
    delete process.env.TEST_SOLO_KEY;
    solo.server.close();
    gw.server.close();
  }
});

test('e2e 验收4（2026-10-26 修订）: 挂起上游超时归 timeout、切链兜底、不计入熔断', async () => {
  const events = new EventLog(100);
  const breaker = new CircuitBreaker({ circuit: { failureThreshold: 1, cooldownSec: 600 }, events });
  const hung = await mockUpstream(() => { /* 接受请求，永不响应 */ });
  const backup = await mockUpstream((req, res) => okJson(res));
  const catalog = {
    providers: [
      { id: 'hung', type: 'openai', baseUrl: `http://127.0.0.1:${hung.port}/v1/chat/completions`, apiKeyRef: 'env:TEST_HUNG_KEY', models: ['m1'] },
      { id: 'backup', type: 'openai', baseUrl: `http://127.0.0.1:${backup.port}/v1/chat/completions`, apiKeyRef: 'env:TEST_BACKUP_KEY', models: ['m1'] },
    ],
  };
  const config = { gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'], timeouts: { requestSec: 0.1 } } };
  const gw = await gateway({ config, catalog, events, breaker });
  process.env.TEST_HUNG_KEY = 'sk';
  process.env.TEST_BACKUP_KEY = 'sk';
  try {
    const t0 = Date.now();
    const r = await call(gw.url, chatBody());
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200); // 超时切链，backup 兜底成功
    assert.ok(elapsed < 5000, `超时应快速切链（耗时 ${elapsed}ms）`);
    // 超时归类 timeout：切链但【不】计入熔断——上游慢生成≠不可达
    assert.equal(breaker.phase('hung'), 'closed', 'gateway timeout must not feed the breaker');
    const reqErr = events.list({ type: 'fallback' });
    assert.equal(reqErr.length, 1);
    assert.equal(reqErr[0].reason, 'timeout');
    assert.equal(reqErr[0].from, 'hung');
    assert.equal(reqErr[0].to, 'backup');
  } finally {
    delete process.env.TEST_HUNG_KEY;
    delete process.env.TEST_BACKUP_KEY;
    hung.server.close();
    backup.server.close();
    gw.server.close();
  }
});

test('e2e 验收5（排序组合）: quota demote 与熔断同时生效时排序稳定', async () => {
  const events = new EventLog(100);
  const breaker = new CircuitBreaker({ circuit: { failureThreshold: 1, cooldownSec: 600 } });
  breaker.recordFailure('glm-x', { reason: 'network' }); // 直接置 open
  const chain = [
    { id: 'glm-x', type: 'glm', models: ['m1'] },
    { id: 'glm-q', type: 'glm', models: ['m1'] },
    { id: 'ds', type: 'openai', models: ['m1'] },
  ];
  const quotaSnap = { 'glm-q': { ok: true, stale: false, tiers: { fiveHour: { usedPercent: 100 } } } };
  const ordered = orderChainByQuota(chain, quotaSnap, { breaker });
  // glm-x 熔断 + glm-q 配额用满 → ds 首位，两个降级项保持相对序到尾
  assert.deepEqual(ordered.map((p) => p.id), ['ds', 'glm-x', 'glm-q']);
});
