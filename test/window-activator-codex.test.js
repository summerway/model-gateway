// window-activator-codex.test.js — 5h window activation for type:codex
// providers: registry-runtime dispatch (OAuth chatCompletions), fire-once,
// backoff/no-burst, registry miss, wham reset retention, restart anchor
// restore, and mixed glm+codex catalogs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import {
  WindowActivator, restoreAnchorsFromEvents, CODEX_WINDOW_MS, ACTIVATION_ANCHOR_PAD_MS,
} from '../src/ops/jobs/window-activator.js';
import { EventLog } from '../src/events.js';

const CODEX = { id: 'codex', type: 'codex', originator: 'pi', models: ['gpt-6-sol', 'gpt-6-luna'] };

function whamBody({ fiveHourResetMs = null, fiveHourUsed = 12.5, fiveHourWindowSeconds = 18000, weeklyUsed = 3, weeklyResetMs = null } = {}) {
  return {
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: fiveHourUsed,
        limit_window_seconds: fiveHourWindowSeconds,
        ...(fiveHourResetMs != null ? { reset_at: Math.floor(fiveHourResetMs / 1000) } : {}),
      },
      secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604800, reset_at: Math.floor((weeklyResetMs ?? (fiveHourResetMs != null ? fiveHourResetMs : 1_800_000) + 604800) / 1000) },
    },
  };
}

function makeCodexProbe(clock, resetMs) {
  let current = resetMs;
  const tokenManager = { getAccessToken: async () => 'access-token', credentials: { accountId: 'acct_1' } };
  const probe = new QuotaProbe({
    providers: [CODEX],
    events: new EventLog(),
    registry: { get: () => ({ tokenManager }) }, // quota-probe 只需 tokenManager
    fetch: async () => new Response(JSON.stringify(whamBody({ fiveHourResetMs: current })), { status: 200 }),
    now: () => clock.t,
  });
  return { probe, setReset: (v) => { current = v; } };
}

function runtimeRecorder(calls, { failWith } = {}) {
  return {
    chatCompletions: async (body, ctx) => {
      calls.push({ body, hasSignal: Boolean(ctx?.signal) });
      if (failWith) throw failWith;
      return { choices: [{ message: { content: 'OK OK' } }], usage: { prompt_tokens: 21, completion_tokens: 42 } };
    },
  };
}

test('codex activator: fires one minimal request via registry runtime, anchors next window, idempotent', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeCodexProbe(clock, resetMs);
  await probe.refresh(CODEX.id);

  const calls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { model: 'glm-5.3-flash', codexModel: 'gpt-6-luna', delaySec: 60, prompt: 'say ok', maxTokens: 64 } },
    quotaProbe: probe,
    events,
    registry: { get: (id) => (id === CODEX.id ? runtimeRecorder(calls) : null) },
    now: () => clock.t,
  });

  await activator.tick(); // before reset → no fire
  assert.equal(calls.length, 0);

  clock.t = resetMs + 5_000;
  await activator.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'say ok' }]);
  assert.equal(calls[0].body.max_tokens, 64);
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].hasSignal, true, 'activation request must be abortable (timeoutSec)');

  const acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, true);
  assert.equal(acts[0].providerId, 'codex');
  assert.equal(acts[0].model, 'gpt-6-luna');
  assert.equal(acts[0].status, 200);

  // 本地锚定下一窗口（激活时刻 + 5h + pad），不依赖 wham 上报时机
  const best = probe.bestFiveHourReset(CODEX.id);
  assert.equal(best.resetMs, clock.t + CODEX_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);
  assert.equal(best.local, true);

  await activator.tick(); // same reset moment → idempotent
  assert.equal(calls.length, 1);
  assert.equal(events.list({ type: 'activation' }).length, 1);
});

test('activator snapshot: armed codex pendingReset 可观测；未配置激活模型的 provider 标注原因', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeCodexProbe(clock, resetMs);
  await probe.refresh(CODEX.id);
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { codexModel: 'gpt-6-luna', delaySec: 60 } },
    quotaProbe: probe,
    events: new EventLog(),
    registry: { get: () => runtimeRecorder([]) },
    now: () => clock.t,
  });
  await activator.tick();
  const snap = activator.snapshot();
  assert.equal(snap.codex.active, true);
  assert.equal(snap.codex.model, 'gpt-6-luna');
  assert.equal(snap.codex.pendingReset.resetsAt, new Date(resetMs).toISOString());
  assert.equal(snap.codex.pendingReset.src, 'external');

  const noModel = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { model: 'glm-5.3-flash' } }, // codexModel 缺省
    quotaProbe: probe,
    events: new EventLog(),
    now: () => clock.t,
  });
  await noModel.tick();
  assert.equal(noModel.snapshot().codex.active, false);
  assert.match(noModel.snapshot().codex.reason, /no activation model/);
});

test('codex activator: upstream failure → backoff (no burst), retry within giveUpAfter succeeds', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeCodexProbe(clock, resetMs);
  await probe.refresh(CODEX.id);

  const calls = [];
  const state = { failWith: null };
  const err = new Error('codex upstream 429: rate limited');
  err.name = 'CodexProviderError';
  err.status = 429;
  state.failWith = err;
  const runtime = {
    chatCompletions: async (body) => {
      calls.push(1);
      if (state.failWith) throw state.failWith;
      return { choices: [] };
    },
  };
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { codexModel: 'gpt-6-luna', delaySec: 60, giveUpAfterSec: 600, backoffStartSec: 120 } },
    quotaProbe: probe,
    events,
    registry: { get: () => runtime },
    now: () => clock.t,
  });

  clock.t = resetMs + 1_000;
  await activator.tick();
  let acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, false);
  assert.equal(acts[0].status, 429);
  assert.match(acts[0].error, /codex upstream 429/);

  clock.t = resetMs + 60_000; // 120s backoff 未到 → 不重试
  await activator.tick();
  assert.equal(calls.length, 1);

  state.failWith = null; // 退避期满后上游恢复
  clock.t = resetMs + 125_000;
  await activator.tick();
  assert.equal(calls.length, 2);
  acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 2);
  assert.equal(acts[0].ok, true);
  assert.equal(acts[0].attempt, 2);
  await activator.tick(); // 成功后幂等
  assert.equal(calls.length, 2);
});

test('codex activator: registry miss records failure without any network call', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeCodexProbe(clock, resetMs);
  await probe.refresh(CODEX.id);

  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { codexModel: 'gpt-6-luna', delaySec: 60 } },
    quotaProbe: probe,
    events,
    registry: { get: () => null },
    now: () => clock.t,
  });

  clock.t = resetMs + 1_000;
  await activator.tick();
  const acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, false);
  assert.match(acts[0].error, /codex provider not available/);
});

test('codex reset retained when wham clears reset_at during the fire window; display fills from anchor', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe, setReset } = makeCodexProbe(clock, resetMs);
  await probe.refresh(CODEX.id);
  assert.equal(probe.fiveHourObservation(CODEX.id).resetMs, resetMs);

  // 新快照清掉 reset_at（窗口刚清零/记账延迟形态）
  setReset(null);
  clock.t = resetMs + 1_000;
  await probe.refresh(CODEX.id, { force: true });
  assert.equal(probe.snapshot()[CODEX.id].tiers.fiveHour.resetMs ?? null, null);

  const calls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { codexModel: 'gpt-6-luna', delaySec: 60 } },
    quotaProbe: probe,
    events,
    registry: { get: () => runtimeRecorder(calls) },
    now: () => clock.t,
  });
  await activator.tick(); // 保留的观测仍驱动激活
  assert.equal(calls.length, 1);
  await activator.tick();
  assert.equal(calls.length, 1); // 同一 reset 时刻不重复

  // 激活成功 → 本地锚点填补展示（estimatedReset）
  const snap = probe.snapshot()[CODEX.id];
  assert.equal(snap.tiers.fiveHour.estimatedReset, true);
  assert.equal(snap.tiers.fiveHour.resetMs, clock.t + CODEX_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);
});

test('codex without codexModel configured is skipped entirely', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeCodexProbe(clock, resetMs);
  await probe.refresh(CODEX.id);

  const calls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60 } }, // 只有 GLM 模型
    quotaProbe: probe,
    events,
    registry: { get: () => runtimeRecorder(calls) },
    now: () => clock.t,
  });

  clock.t = resetMs + 5_000;
  await activator.tick();
  assert.equal(calls.length, 0);
  assert.equal(events.list({ type: 'activation' }).length, 0);
});

test('codex activator: weekly secondary window exhausted → skip activation entirely, resume after reset', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const weeklyResetMs = clock.t + 100 * 3_600_000;
  let body = whamBody({ fiveHourResetMs: resetMs, weeklyUsed: 100, weeklyResetMs });
  const tokenManager = { getAccessToken: async () => 'access-token', credentials: { accountId: 'acct_1' } };
  const probe = new QuotaProbe({
    providers: [CODEX],
    events: new EventLog(),
    registry: { get: () => ({ tokenManager }) },
    fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    now: () => clock.t,
  });
  await probe.refresh(CODEX.id);

  const calls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { codexModel: 'gpt-6-luna', delaySec: 60 } },
    quotaProbe: probe,
    events,
    registry: { get: () => runtimeRecorder(calls) },
    now: () => clock.t,
  });

  clock.t = resetMs + 5_000;
  await activator.tick();
  assert.equal(calls.length, 0, '周额度用满：不发激活请求');
  assert.equal(events.list({ type: 'activation' }).length, 0);
  const skips = events.list({ type: 'activation_skipped' });
  assert.equal(skips.length, 1);
  assert.equal(skips[0].tier, 'weekly');
  assert.equal(activator.snapshot().codex.suppressed.until, new Date(weeklyResetMs).toISOString());

  await activator.tick();
  assert.equal(events.list({ type: 'activation_skipped' }).length, 1, '同一额度周期只记一条');

  // 周额度恢复 → 激活回归
  const nextReset = clock.t + 3_600_000;
  body = whamBody({ fiveHourResetMs: nextReset, weeklyUsed: 5 });
  clock.t += 60_000;
  await probe.refresh(CODEX.id, { force: true });
  clock.t = nextReset + 5_000;
  await activator.tick();
  assert.equal(calls.length, 1, '额度恢复后激活回归');
  assert.equal(events.list({ type: 'activation' })[0].ok, true);
});

test('codex free plan: 30-day primary window exhausted → skip activation (no futile 5h retries)', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000; // 5h 激活锚点
  const monthlyResetMs = clock.t + 500 * 3_600_000;
  const body = {
    plan_type: 'free',
    rate_limit: {
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 2592000, // 30 天总额度窗口（免费档 primary 即总额度）
        reset_at: Math.floor(monthlyResetMs / 1000),
      },
    },
  };
  const tokenManager = { getAccessToken: async () => 'access-token', credentials: { accountId: 'acct_1' } };
  const probe = new QuotaProbe({
    providers: [CODEX],
    events: new EventLog(),
    registry: { get: () => ({ tokenManager }) },
    fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    now: () => clock.t,
  });
  await probe.refresh(CODEX.id);

  const calls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CODEX],
    jobs: { activate: { codexModel: 'gpt-6-luna', delaySec: 60 } },
    quotaProbe: probe,
    events,
    registry: { get: () => runtimeRecorder(calls) },
    now: () => clock.t,
  });

  clock.t = resetMs + 5_000;
  await activator.tick();
  assert.equal(calls.length, 0, '30 天总额度用满：不发激活请求');
  const skips = events.list({ type: 'activation_skipped' });
  assert.equal(skips.length, 1);
  assert.equal(skips[0].tier, 'primary');
});

test('restoreAnchorsFromEvents: rebuilds future codex anchors from persisted activations', () => {
  const now = 10_000_000_000;
  const probe = makeCodexProbe({ t: now }, null).probe;
  const retained = [];
  probe.retainActivationAnchor = (id, a) => retained.push({ id, ...a });

  const events = new EventLog();
  const recent = new Date(now - 60_000).toISOString();
  events.buf.push({ ts: recent, type: 'activation', providerId: 'codex', ok: false });
  events.buf.push({ ts: recent, type: 'activation', providerId: 'codex', ok: true });

  restoreAnchorsFromEvents({ providers: [CODEX], quotaProbe: probe, events, now: () => now });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, 'codex');
  assert.equal(retained[0].resetMs, new Date(recent).getTime() + CODEX_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);

  // 容错：缺 quotaProbe / events 不抛
  restoreAnchorsFromEvents({ providers: [CODEX] });
});

test('mixed catalog: glm fires direct fetch with cfg.model; codex fires runtime with codexModel', async () => {
  process.env.TEST_GLM_KEY = 'glm-key';
  const clock = { t: 1_000_000 };
  const glmReset = clock.t + 3_600_000;
  const codexReset = clock.t + 3_600_000;
  const glm = {
    id: 'glm-main', type: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
    apiKeyRef: 'env:TEST_GLM_KEY', models: ['glm-5.3'],
  };
  const tokenManager = { getAccessToken: async () => 't', credentials: { accountId: 'a' } };
  const probe = new QuotaProbe({
    providers: [glm, CODEX],
    events: new EventLog(),
    registry: { get: () => ({ tokenManager }) },
    fetch: async (url) => {
      if (String(url).includes('chatgpt.com')) {
        return new Response(JSON.stringify(whamBody({ fiveHourResetMs: codexReset })), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: { level: 'MAX3', limits: [{ type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: glmReset, unit: 3 }] },
      }), { status: 200 });
    },
    now: () => clock.t,
  });
  await probe.refresh('glm-main');
  await probe.refresh('codex');

  const httpCalls = [];
  const runtimeCalls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [glm, CODEX],
    jobs: { activate: { model: 'glm-5.3-flash', codexModel: 'gpt-6-luna', delaySec: 60, prompt: 'ok' } },
    quotaProbe: probe,
    events,
    registry: { get: () => ({ chatCompletions: async (body) => { runtimeCalls.push(body); return { choices: [] }; } }) },
    fetch: async (url, init) => {
      httpCalls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return new Response('{}', { status: 200 });
    },
    now: () => clock.t,
  });

  clock.t = glmReset + 5_000;
  await activator.tick();
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].body.model, 'glm-5.3-flash');
  assert.equal(httpCalls[0].auth, 'Bearer glm-key');
  assert.equal(httpCalls[0].url, glm.baseUrl);
  assert.equal(runtimeCalls.length, 1);
  assert.equal(runtimeCalls[0].model, 'gpt-6-luna');
  assert.equal(events.list({ type: 'activation' }).length, 2);
  delete process.env.TEST_GLM_KEY;
});
