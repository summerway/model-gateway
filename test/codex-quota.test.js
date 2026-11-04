// codex-quota.test.js — wham/usage parser + QuotaProbe codex dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsageBody, probeCodexUsage } from '../src/ops/codex-quota.js';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import { EventLog } from '../src/events.js';

const FIXTURE = {
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 2789, reset_at: 1790229521 },
    secondary_window: { used_percent: 18, limit_window_seconds: 604800, reset_after_seconds: 501190, reset_at: 1790727922 },
  },
};

test('parseCodexUsageBody: normal payload → tiers with ms resetsAt + labels', () => {
  const r = parseCodexUsageBody(FIXTURE);
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'plus');
  assert.equal(r.tiers.fiveHour.usedPercent, 5);
  assert.equal(r.tiers.fiveHour.windowSeconds, 18000);
  assert.equal(r.tiers.fiveHour.label, '5 小时窗口');
  assert.equal(r.tiers.fiveHour.resetMs, 1790229521 * 1000);
  assert.equal(r.tiers.fiveHour.resetsAt, new Date(1790229521 * 1000).toISOString());
  assert.equal(r.tiers.weekly.usedPercent, 18);
  assert.equal(r.tiers.weekly.label, '本周额度');
});

test('parseCodexUsageBody: only primary window / error shapes', () => {
  const onlyPrimary = parseCodexUsageBody({ rate_limit: { primary_window: FIXTURE.rate_limit.primary_window } });
  assert.equal(onlyPrimary.ok, true);
  assert.equal(onlyPrimary.tiers.weekly, undefined);
  assert.equal(onlyPrimary.tiers.fiveHour.usedPercent, 5);

  assert.equal(parseCodexUsageBody(null).ok, false);
  assert.equal(parseCodexUsageBody({}).ok, false);
  assert.equal(parseCodexUsageBody({ rate_limit: {} }).ok, false);
  assert.equal(parseCodexUsageBody({ rate_limit: { primary_window: { reset_at: 1 } } }).ok, false);
});

test('probeCodexUsage: headers + happy path; 403 → auth error, never throws', async () => {
  let seen = {};
  const fetch = async (url, opts) => {
    seen = { url, headers: opts.headers };
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  };
  const r = await probeCodexUsage({
    getAccessToken: async () => 'tok-123',
    accountId: 'acc-1',
    baseUrl: 'https://chatgpt.com/backend-api',
    fetch,
  });
  assert.equal(seen.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(seen.headers.Authorization, 'Bearer tok-123');
  assert.equal(seen.headers['ChatGPT-Account-Id'], 'acc-1');
  assert.equal(seen.headers['User-Agent'], 'codex-cli');
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'plus');

  const denied = await probeCodexUsage({
    getAccessToken: async () => 'bad',
    accountId: null,
    fetch: async () => new Response('cf block', { status: 403 }),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /auth failed/);
});

test('probeCodexUsage: 瞬态网络错误重试一次即恢复（2026-09-25 21:26 fetch failed 回归）', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  };
  const r = await probeCodexUsage({ getAccessToken: async () => 't', fetch, retryDelayMs: 1 });
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'plus');
});

test('probeCodexUsage: HTTP 错误不重试；持续网络错误只重试一次', async () => {
  let calls401 = 0;
  const r401 = await probeCodexUsage({
    getAccessToken: async () => 't',
    fetch: async () => { calls401 += 1; return new Response('no', { status: 401 }); },
    retryDelayMs: 1,
  });
  assert.equal(calls401, 1);
  assert.equal(r401.ok, false);

  let callsNet = 0;
  const rNet = await probeCodexUsage({
    getAccessToken: async () => 't',
    fetch: async () => { callsNet += 1; throw new TypeError('fetch failed'); },
    retryDelayMs: 1,
  });
  assert.equal(callsNet, 2);
  assert.equal(rNet.ok, false);
  assert.match(rNet.error, /network error/);
});

test('QuotaProbe: codex snapshot quotaBase 指向 chatgpt.com（非 GLM 域）', () => {
  const probe = new QuotaProbe({
    providers: [{ id: 'codex', type: 'codex', models: ['gpt-6-luna'] }],
    events: new EventLog(10),
  });
  assert.equal(probe.snapshot().codex.quotaBase, 'https://chatgpt.com');
});

test('QuotaProbe probes codex providers via registry tokenManager', async () => {
  const events = new EventLog(20);
  const tokenManager = {
    getAccessToken: async () => 'tok',
    credentials: { accountId: 'acc-1' },
  };
  const registry = { get: (id) => (id === 'codex' ? { tokenManager } : null) };
  const probe = new QuotaProbe({
    providers: [{ id: 'codex', type: 'codex', baseUrl: 'https://chatgpt.com/backend-api', models: ['gpt-6-sol'] }],
    events,
    registry,
    fetch: async () => new Response(JSON.stringify(FIXTURE), { status: 200 }),
  });
  const r = await probe.refresh('codex', { force: true });
  assert.equal(r.ok, true);
  const snap = probe.snapshot();
  assert.equal(snap.codex.ok, true);
  assert.equal(snap.codex.level, 'plus'); // plan mapped onto level
  assert.equal(snap.codex.tiers.fiveHour.usedPercent, 5);
  assert.equal(snap.codex.tiers.weekly.usedPercent, 18);
  assert.equal(snap.codex.balance, null);
});

test('QuotaProbe codex without registry → failure, not crash', async () => {
  const events = new EventLog(20);
  const probe = new QuotaProbe({
    providers: [{ id: 'codex', type: 'codex', models: ['gpt-6-sol'] }],
    events,
    fetch: async () => { throw new Error('must not fetch'); },
  });
  const r = await probe.refresh('codex', { force: true });
  assert.equal(r, null);
  assert.equal(probe.snapshot().codex.ok, false);
  assert.match(probe.snapshot().codex.lastError, /registry miss|not loaded/);
});
