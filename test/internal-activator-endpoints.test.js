// internal-activator-endpoints.test.js — /internal/activator/claude/claim|result
// 端点契约：私网放行、无 claimId 的 result 400、store 未接线 501、
// claim/report 透传到 WindowActivator（状态机真源）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { EventLog } from '../src/events.js';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import { WindowActivator } from '../src/ops/jobs/window-activator.js';

const CLAUDE = {
  id: 'claude', type: 'claude', displayName: 'Claude', credentialFile: '/creds.json', models: [],
};

function claudeBody(resetMs) {
  return {
    five_hour: { utilization: 10, resets_at: resetMs != null ? new Date(resetMs).toISOString() : null },
    seven_day: { utilization: 20, resets_at: new Date(1_800_000_000_000).toISOString() },
    limits: [{ kind: 'weekly_all', group: '7d', percent: 20, resets_at: new Date(1_800_000_000_000).toISOString(), scope: null }],
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function setup({ dueResetMs, clock } = {}) {
  const events = new EventLog();
  const probe = new QuotaProbe({
    providers: [CLAUDE],
    events,
    fetch: async () => new Response(JSON.stringify(claudeBody(dueResetMs)), { status: 200 }),
    fs: { readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: clock.t + 3_600_000 } }) },
    now: () => clock.t,
  });
  await probe.refresh('claude');
  const activator = new WindowActivator({
    providers: [CLAUDE],
    jobs: { activate: { claudeModel: 'claude-haiku-5-5', delaySec: 60 } },
    quotaProbe: probe,
    events,
    now: () => clock.t,
  });
  const handler = createRequestHandler({
    config: { gateway: { keys: ['gw-test-key'], timeouts: {} }, providers: [] },
    catalog: { providers: [] },
    events,
    quotaStore: { snapshot: () => ({}) },
    activatorStore: {
      snapshot: () => activator.snapshot(),
      claim: () => activator.claimClaudeActivation(),
      report: (claimId, outcome) => activator.reportClaudeResult(claimId, outcome),
    },
  });
  const srv = await startServer(handler);
  return { srv, activator, events, probe, url: srv.url };
}

test('claim|result 端点：领取 → 回报 → 事件入账；坏请求 4xx', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const t = await setup({ dueResetMs: resetMs, clock });
  try {
    // 未到点：claim 不可领取
    clock.t = resetMs - 1_000;
    await t.activator.tick();
    let resp = await fetch(t.url + '/internal/activator/claude/claim', { method: 'POST' });
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).due, false);

    // 到点：可领取
    clock.t = resetMs + 5_000;
    await t.activator.tick();
    resp = await fetch(t.url + '/internal/activator/claude/claim', { method: 'POST' });
    const claim = await resp.json();
    assert.equal(claim.due, true);
    assert.equal(claim.model, 'claude-haiku-5-5');

    // result：缺 claimId → 400
    resp = await fetch(t.url + '/internal/activator/claude/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }),
    });
    assert.equal(resp.status, 400);

    // result：合法回报 → recorded，activation 事件入账
    resp = await fetch(t.url + '/internal/activator/claude/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claimId: claim.claimId, ok: true, durationMs: 123 }),
    });
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).recorded, true);
    const acts = t.events.list({ type: 'activation' });
    assert.equal(acts.length, 1);
    assert.equal(acts[0].ok, true);
    assert.equal(acts[0].durationMs, 123);

    // GET /internal/activator 快照含 claude runner 态
    resp = await fetch(t.url + '/internal/activator');
    const snap = (await resp.json()).claude;
    assert.equal(snap.active, true);
    assert.equal(snap.runner, 'host-cli');
  } finally {
    t.srv.server.close();
  }
});

test('activatorStore 未接线 claim/report → 501（不崩）', async () => {
  const handler = createRequestHandler({
    config: { gateway: { keys: ['gw-test-key'], timeouts: {} }, providers: [] },
    catalog: { providers: [] },
    events: new EventLog(),
    quotaStore: { snapshot: () => ({}) },
    activatorStore: { snapshot: () => ({}) }, // 老形态：仅 snapshot
  });
  const srv = await startServer(handler);
  try {
    let resp = await fetch(srv.url + '/internal/activator/claude/claim', { method: 'POST' });
    assert.equal(resp.status, 501);
    resp = await fetch(srv.url + '/internal/activator/claude/result', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: 'x' }),
    });
    assert.equal(resp.status, 501);
  } finally {
    srv.server.close();
  }
});
