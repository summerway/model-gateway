// window-anchor.test.js — activation anchors the next 5h window locally:
// GLM's monitor API lags ~5-10 min (and reports nothing while usage ≈ 0), so
// the retained anchor must bridge display countdown, next activation cycle,
// and gateway restarts (rebuilt from persisted activation events).

import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import { WindowActivator, restoreAnchorsFromEvents, GLM_WINDOW_MS, ACTIVATION_ANCHOR_PAD_MS } from '../src/ops/jobs/window-activator.js';
import { EventLog } from '../src/events.js';

const PROVIDER = {
  id: 'glm-main',
  type: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  apiKeyRef: 'env:TEST_GLM_KEY',
  models: ['glm-5.3'],
};

function monitorBody(resetMs, percentage = 3) {
  return {
    success: true,
    data: {
      level: 'lite',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage, ...(resetMs != null ? { nextResetTime: resetMs } : {}) },
      ],
    },
  };
}

function makeProbe(clock, resetMs) {
  let current = resetMs;
  const probe = new QuotaProbe({
    providers: [PROVIDER],
    events: new EventLog(),
    fetch: async () => new Response(JSON.stringify(monitorBody(current)), { status: 200 }),
    now: () => clock.t,
  });
  return { probe, setReset: (v) => { current = v; } };
}

test('retainActivationAnchor: monotonic, fills snapshot resetsAt during GLM lag gap', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const clock = { t: 1_000_000 };
  try {
    const { probe, setReset } = makeProbe(clock, null); // GLM 报了 0% 无 nextResetTime（记账延迟）
    await probe.refresh(PROVIDER.id);
    let snap = probe.snapshot()[PROVIDER.id];
    assert.equal(snap.tiers.fiveHour.resetsAt, null);

    const anchorMs = clock.t + GLM_WINDOW_MS;
    probe.retainActivationAnchor(PROVIDER.id, { resetMs: anchorMs });
    // 更旧的锚点不能覆盖更新的
    probe.retainActivationAnchor(PROVIDER.id, { resetMs: anchorMs - 60_000 });

    snap = probe.snapshot()[PROVIDER.id];
    assert.equal(snap.tiers.fiveHour.resetMs, anchorMs);
    assert.equal(snap.tiers.fiveHour.estimatedReset, true);
    assert.equal(probe.bestFiveHourReset(PROVIDER.id).local, true);

    // GLM 上报权威值后：tier 直接采用，不再标记 estimatedReset
    setReset(anchorMs + 3_000);
    await probe.refresh(PROVIDER.id, { force: true });
    snap = probe.snapshot()[PROVIDER.id];
    assert.equal(snap.tiers.fiveHour.resetMs, anchorMs + 3_000);
    assert.equal(snap.tiers.fiveHour.estimatedReset, undefined);
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

test('activator: successful activation retains the next window anchor locally', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const clock = { t: 1_000_000 };
  try {
    const resetMs = clock.t + 3_600_000;
    const { probe } = makeProbe(clock, resetMs);
    await probe.refresh(PROVIDER.id);

    const activator = new WindowActivator({
      providers: [PROVIDER],
      jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60 } },
      quotaProbe: probe,
      events: new EventLog(),
      fetch: async () => new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 }),
      now: () => clock.t,
    });

    clock.t = resetMs + 1_000;
    await activator.tick();

    const retained = probe.bestFiveHourReset(PROVIDER.id);
    assert.equal(retained.resetMs, clock.t + GLM_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);
    assert.equal(retained.local, true);
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

test('restoreAnchorsFromEvents: rebuilds future anchors from persisted activations', () => {
  const now = 10_000_000_000;
  const probe = makeProbe({ t: now }, null).probe;
  const retained = [];
  probe.retainActivationAnchor = (id, a) => retained.push({ id, ...a });

  const events = new EventLog();
  const past = new Date(now - GLM_WINDOW_MS - 2 * ACTIVATION_ANCHOR_PAD_MS - 1).toISOString();
  events.buf.push({ ts: past, type: 'activation', providerId: 'glm-main', ok: true });
  const recent = new Date(now - 60_000).toISOString();
  events.buf.push({ ts: recent, type: 'activation', providerId: 'glm-main', ok: false });
  events.buf.push({ ts: recent, type: 'activation', providerId: 'glm-main', ok: true });

  restoreAnchorsFromEvents({ providers: [PROVIDER], quotaProbe: probe, events, now: () => now });
  // 只取最新一次成功激活（ok:false 的跳过），过去窗口的忽略
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, 'glm-main');
  assert.equal(retained[0].resetMs, new Date(recent).getTime() + GLM_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);

  // 容错：缺 quotaProbe / events 不抛
  restoreAnchorsFromEvents({ providers: [PROVIDER] });
});
