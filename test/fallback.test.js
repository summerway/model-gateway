// fallback.test.js — ordered fallback chain semantics (mock upstreams).

import test from 'node:test';
import assert from 'node:assert/strict';
import { runFallbackChain, isRetriable, classifyFailure, UpstreamError } from '../src/gateway/fallback/engine.js';

const chain = [
  { id: 'primary' },
  { id: 'backup' },
  { id: 'last' },
];

function httpErr(status, providerId) {
  return new UpstreamError(`http ${status}`, { providerId, status });
}
function netErr(providerId) {
  const e = new UpstreamError('fetch failed', { providerId, cause: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }) });
  e.code = 'ECONNREFUSED';
  return e;
}

test('first provider success — no fallback events', async () => {
  const events = [];
  const { result, provider, attempts } = await runFallbackChain(
    chain,
    async (p) => `ok:${p.id}`,
    { model: 'm1', onEvent: (e) => events.push(e) },
  );
  assert.equal(result, 'ok:primary');
  assert.equal(provider.id, 'primary');
  assert.equal(attempts.length, 1);
  assert.equal(events.length, 0);
});

test('429 on primary → falls to backup, event recorded', async () => {
  const events = [];
  const { result, provider, attempts } = await runFallbackChain(
    chain,
    async (p) => {
      if (p.id === 'primary') throw httpErr(429, p.id);
      return `ok:${p.id}`;
    },
    { model: 'm1', onEvent: (e) => events.push(e) },
  );
  assert.equal(result, 'ok:backup');
  assert.equal(provider.id, 'backup');
  assert.equal(attempts.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'fallback');
  assert.equal(events[0].from, 'primary');
  assert.equal(events[0].to, 'backup');
  assert.equal(events[0].reason, 'rate_limited');
  assert.equal(events[0].model, 'm1');
  assert.equal(events[0].status, 429);
});

test('5xx on first two → third succeeds; two events', async () => {
  const events = [];
  const { result } = await runFallbackChain(
    chain,
    async (p) => {
      if (p.id !== 'last') throw httpErr(503, p.id);
      return 'ok:last';
    },
    { onEvent: (e) => events.push(e) },
  );
  assert.equal(result, 'ok:last');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => [e.from, e.to]), [
    ['primary', 'backup'],
    ['backup', 'last'],
  ]);
  assert.equal(events[1].reason, 'server_error');
});

test('network error triggers fallback (OLP hard trigger)', async () => {
  const events = [];
  const { result } = await runFallbackChain(
    chain,
    async (p) => {
      if (p.id === 'primary') throw netErr(p.id);
      return 'ok';
    },
    { onEvent: (e) => events.push(e) },
  );
  assert.equal(result, 'ok');
  assert.equal(events[0].reason, 'network');
});

test('all fail → UpstreamError with attempts trail; events for each hop', async () => {
  const events = [];
  await assert.rejects(
    runFallbackChain(
      chain,
      async (p) => {
        throw httpErr(500, p.id);
      },
      { onEvent: (e) => events.push(e) },
    ),
    (err) => {
      assert.ok(err instanceof UpstreamError);
      assert.equal(err.attempts.length, 3);
      assert.equal(err.status, 500);
      return true;
    },
  );
  assert.equal(events.length, 2);
});

test('client error 400/401/403/404/422 does NOT advance the chain', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const events = [];
    let calls = 0;
    await assert.rejects(
      runFallbackChain(
        chain,
        async (p) => {
          calls += 1;
          throw httpErr(status, p.id);
        },
        { onEvent: (e) => events.push(e) },
      ),
      (err) => err.status === status,
    );
    assert.equal(calls, 1, `status ${status} must stop after first provider`);
    assert.equal(events.length, 0);
  }
});

test('empty chain throws', async () => {
  await assert.rejects(runFallbackChain([], async () => 'x'), UpstreamError);
});

test('classifyFailure / isRetriable edge cases', () => {
  assert.equal(classifyFailure(httpErr(429, 'x')), 'rate_limited');
  assert.equal(classifyFailure(httpErr(502, 'x')), 'server_error');
  assert.equal(classifyFailure(httpErr(400, 'x')), 'client_error');
  assert.equal(classifyFailure(netErr('x')), 'network');
  assert.ok(isRetriable(httpErr(429, 'x')));
  assert.ok(isRetriable(httpErr(503, 'x')));
  assert.ok(!isRetriable(httpErr(401, 'x')));
  assert.ok(!isRetriable(httpErr(404, 'x')));
  // 408/409: 4xx but not in the no-fallback set → retriable per generic rule
  assert.ok(isRetriable(httpErr(408, 'x')));
  // gateway timeout（fetchUpstream abort）：归类 timeout，retriable 但不喂熔断
  const tErr = new UpstreamError('timeout after 300000ms', { kind: 'timeout' });
  assert.equal(classifyFailure(tErr), 'timeout');
  assert.ok(isRetriable(tErr));
});
