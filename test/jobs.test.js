// jobs.test.js — quota probe (cache/backoff/stale) + window activator (fire-once, backoff, notify).

import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import { WindowActivator } from '../src/ops/jobs/window-activator.js';
import { EventLog } from '../src/events.js';
import { parseSmtpUrl } from '../src/ops/notify.js';

const PROVIDER = {
  id: 'glm-main',
  type: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  apiKeyRef: 'env:TEST_GLM_KEY',
  models: ['glm-5.3'],
};

function okBody(resetMs = Date.now() + 3600_000) {
  return {
    success: true,
    data: {
      level: 'MAX3',
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: resetMs, unit: 3 },
        { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: resetMs + 86400_000, unit: 6 },
      ],
    },
  };
}

test('quota probe: success cached within TTL; force bypasses', async () => {
  process.env.TEST_GLM_KEY = 'k';
  let calls = 0;
  let clock = 1_000_000;
  const events = new EventLog();
  const probe = new QuotaProbe({
    providers: [PROVIDER],
    jobs: { probe: { intervalSec: 300, cacheTtlSec: 300, backoffStartSec: 60, backoffMaxSec: 3600 } },
    events,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(okBody()), { status: 200 });
    },
    now: () => clock,
  });
  try {
    await probe.refresh('glm-main');
    assert.equal(calls, 1);
    // Within TTL: refresh is a cache hit.
    clock += 60_000;
    await probe.refresh('glm-main');
    assert.equal(calls, 1);
    // Past TTL: re-probes.
    clock += 300_000;
    await probe.refresh('glm-main');
    assert.equal(calls, 2);
    // force ignores cache.
    await probe.refresh('glm-main', { force: true });
    assert.equal(calls, 3);

    const snap = probe.snapshot()['glm-main'];
    assert.equal(snap.ok, true);
    assert.equal(snap.stale, false);
    assert.equal(snap.tiers.fiveHour.usedPercent, 30);
    assert.equal(snap.level, 'MAX3');
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

test('quota probe: failure → exponential backoff 60→120→240… capped 3600; stale snapshot retained', async () => {
  process.env.TEST_GLM_KEY = 'k';
  let clock = 1_000_000;
  let mode = 'fail';
  let calls = 0;
  const events = new EventLog();
  const probe = new QuotaProbe({
    providers: [PROVIDER],
    jobs: { probe: { intervalSec: 300, cacheTtlSec: 300, backoffStartSec: 60, backoffMaxSec: 3600 } },
    events,
    fetch: async () => {
      calls += 1;
      if (mode === 'fail') return new Response('{"success":false,"msg":"busy"}', { status: 200 });
      return new Response(JSON.stringify(okBody()), { status: 200 });
    },
    now: () => clock,
  });
  try {
    // Seed a good snapshot first.
    mode = 'ok';
    await probe.refresh('glm-main');
    mode = 'fail';

    // Failure 1 → backoff 60s
    clock += 300_000 + 1; // past TTL
    await probe.refresh('glm-main', { force: true });
    let snap = probe.snapshot()['glm-main'];
    assert.equal(snap.ok, true);
    assert.equal(snap.stale, true, 'last good snapshot retained but marked stale');
    assert.ok(snap.lastError.includes('busy'));
    assert.equal(snap.backingOff, true);

    // tick() inside the 60s backoff window → skipped (no new call).
    const callsBefore = calls;
    clock += 1;
    await probe.tick();
    assert.equal(calls, callsBefore, 'tick() must skip providers in backoff');

    // Failure 2 after backoff expiry (tick-gated) → backoff doubles to 120s.
    clock += 61_000;
    await probe.tick();
    assert.equal(calls, callsBefore + 1);
    snap = probe.snapshot()['glm-main'];
    assert.equal(events.list({ type: 'probe_error' }).length, 2);
    // nextAttemptAt is now clock + 120s.
    const st = probe.state.get('glm-main');
    assert.equal(st.nextAttemptAt, clock + 120_000);

    // Success clears failures and stale flag.
    mode = 'ok';
    clock += 130_000;
    await probe.tick();
    snap = probe.snapshot()['glm-main'];
    assert.equal(snap.ok, true);
    assert.equal(snap.stale, false);
    assert.equal(snap.backingOff, false);
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

test('quota probe: backoff cap at backoffMaxSec', async () => {
  process.env.TEST_GLM_KEY = 'k';
  let clock = 0;
  const probe = new QuotaProbe({
    providers: [PROVIDER],
    jobs: { probe: { intervalSec: 300, cacheTtlSec: 300, backoffStartSec: 60, backoffMaxSec: 3600 } },
    events: new EventLog(),
    fetch: async () => new Response('', { status: 500 }),
    now: () => clock,
  });
  try {
    for (let i = 0; i < 10; i++) {
      await probe.refresh('glm-main', { force: true });
      clock += 1;
    }
    const st = probe.state.get('glm-main');
    const expected = Math.min(60 * 2 ** 9, 3600) * 1000;
    assert.equal(st.nextAttemptAt, 9 * 1 + expected);
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

test('quota probe: nextFiveHourReset returns earliest future reset', async () => {
  process.env.TEST_GLM_KEY = 'k';
  let clock = 1_000_000_000;
  const reset1 = clock + 600_000;
  const reset2 = clock + 1_200_000;
  const p1 = { ...PROVIDER, id: 'a' };
  const p2 = { ...PROVIDER, id: 'b' };
  const bodies = {
    a: okBody(reset1),
    b: okBody(reset2),
  };
  const probe = new QuotaProbe({
    providers: [p1, p2],
    jobs: {},
    events: new EventLog(),
    fetch: async (url) => new Response(JSON.stringify(bodies[url.includes('a') ? 'a' : 'b']), { status: 200 }),
    now: () => clock,
  });
  try {
    await probe.refresh('a');
    await probe.refresh('b');
    const next = probe.nextFiveHourReset();
    assert.equal(next.providerId, 'a');
    assert.equal(next.resetMs, reset1);
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

// ── window activator ───────────────────────────────────────────────────────

function makeProbeWithReset(resetMs, clockRef) {
  const probe = new QuotaProbe({
    providers: [PROVIDER],
    jobs: {},
    events: new EventLog(),
    fetch: async () => new Response(JSON.stringify(okBody(resetMs)), { status: 200 }),
    now: () => clockRef.t,
  });
  return probe;
}

/** 可变配额体：周额度用满（重置在远期）→ 额度恢复后周档清除的正常形态。 */
function makeProbeWithWeeklyCap(clockRef, { fiveHourResetMs, weeklyResetMs }) {
  const cur = { fiveHourResetMs, weeklyResetMs, weeklyUsed: 100 };
  const body = () => ({
    success: true,
    data: {
      level: 'PRO',
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 40, nextResetTime: cur.fiveHourResetMs, unit: 3 },
        ...(cur.weeklyResetMs != null
          ? [{ type: 'TOKENS_LIMIT', percentage: cur.weeklyUsed, nextResetTime: cur.weeklyResetMs, unit: 6 }]
          : []),
      ],
    },
  });
  const probe = new QuotaProbe({
    providers: [PROVIDER],
    jobs: {},
    events: new EventLog(),
    fetch: async () => new Response(JSON.stringify(body()), { status: 200 }),
    now: () => clockRef.t,
  });
  return { probe, cur };
}

test('activator: fires exactly one minimal request inside the post-reset window', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const resetMs = t.t + 3_600_000;
  const probe = makeProbeWithReset(resetMs, t);
  await probe.refresh('glm-main');

  const activations = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [PROVIDER],
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60, maxTokens: 1, prompt: 'ok', timeoutSec: 5, backoffStartSec: 120, backoffMaxSec: 3600 } },
    quotaProbe: probe,
    events,
    fetch: async (url, init) => {
      activations.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
    },
    now: () => t.t,
  });

  // Before reset: no fire.
  await activator.tick();
  assert.equal(activations.length, 0);

  // After reset, inside window: fire once.
  t.t = resetMs + 5_000;
  await activator.tick();
  assert.equal(activations.length, 1);
  assert.equal(activations[0].body.model, 'glm-5.3-flash');
  assert.equal(activations[0].body.max_tokens, 1);
  assert.deepEqual(activations[0].body.messages, [{ role: 'user', content: 'ok' }]);
  assert.equal(activations[0].body.stream, false);
  assert.equal(activations[0].auth, 'Bearer k');
  assert.equal(activations[0].url, PROVIDER.baseUrl);

  // Subsequent ticks in same window: idempotent.
  t.t = resetMs + 10_000;
  await activator.tick();
  assert.equal(activations.length, 1);

  const acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, true);
  assert.equal(acts[0].providerId, 'glm-main');

  // After the window passes with a new reset moment: fires again for the new reset.
  // （本地锚点 = 激活时刻+5h ≥ reset1+5h，新锚点需晚于它才能进入队列——与生产中
  //   GLM 权威锚点晚于本地推算的关系一致。）
  const reset2 = resetMs + 5 * 3600_000 + 60_000;
  t.t = reset2 + 1_000;
  probe.state.get('glm-main').lastFiveHourReset = { resetMs: reset2, resetsAt: new Date(reset2).toISOString() };
  await activator.tick();
  assert.equal(activations.length, 2);
  delete process.env.TEST_GLM_KEY;
});

test('activator retains reset anchor when quota probe clears nextResetTime', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const resetMs = t.t + 3_600_000;
  const probe = makeProbeWithReset(resetMs, t);
  await probe.refresh('glm-main');
  const events = new EventLog();
  let calls = 0;
  const activator = new WindowActivator({
    providers: [PROVIDER],
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60 } },
    quotaProbe: probe, events, now: () => t.t,
    fetch: async () => { calls++; return new Response('{"choices":[]}', { status: 200 }); },
  });
  await activator.tick(); // remember upcoming reset
  probe.state.get('glm-main').snapshot.tiers.fiveHour.resetMs = null;
  probe.state.get('glm-main').snapshot.tiers.fiveHour.resetsAt = null;
  t.t = resetMs + 5_000;
  await activator.tick();
  assert.equal(calls, 1);
  assert.equal(events.list({ type: 'activation' }).length, 1);
  await activator.tick(); // same reset cannot activate twice even with cleared snapshot
  assert.equal(calls, 1);
  delete process.env.TEST_GLM_KEY;
});

test('probe clears reset in a newer successful snapshot before activator tick: saved anchor still activates once', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const resetMs = t.t + 3_600_000;
  let resetVisible = true;
  const probe = new QuotaProbe({
    providers: [PROVIDER], jobs: {}, events: new EventLog(), now: () => t.t,
    fetch: async () => new Response(JSON.stringify({
      success: true, data: { level: 'MAX3', limits: [
        { type: 'TOKENS_LIMIT', percentage: 3, nextResetTime: resetVisible ? resetMs : null, unit: 3 },
      ] },
    }), { status: 200 }),
  });
  const events = new EventLog();
  let calls = 0;
  const activator = new WindowActivator({
    providers: [PROVIDER], jobs: { activate: { model: 'glm-5.3-flash' } },
    quotaProbe: probe, events, now: () => t.t,
    fetch: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  try {
    await probe.refresh(PROVIDER.id);
    assert.equal(probe.lastFiveHourReset(PROVIDER.id).resetMs, resetMs);
    resetVisible = false;
    t.t = resetMs + 1_000;
    await probe.refresh(PROVIDER.id, { force: true });
    assert.equal(probe.snapshot()[PROVIDER.id].tiers?.fiveHour?.resetMs ?? null, null);
    await Promise.all([activator.tick(), activator.tick()]);
    assert.equal(calls, 1);
    await activator.tick();
    assert.equal(calls, 1);
  } finally { delete process.env.TEST_GLM_KEY; }
});

test('activator drains old reset before a newer probe reset and never reactivates the same moment', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const old = t.t + 3600_000;
  const newer = old + 5 * 3600_000;
  const probe = makeProbeWithReset(old, t);
  let calls = 0;
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [PROVIDER], quotaProbe: probe, events, now: () => t.t,
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60 } },
    fetch: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  try {
    await probe.refresh(PROVIDER.id);
    await activator.tick();
    t.t = old + 1_000;
    probe.state.get(PROVIDER.id).lastFiveHourReset = { resetMs: newer, resetsAt: new Date(newer).toISOString() };
    await activator.tick(); // new reset observed before old one gets its first activation
    assert.equal(calls, 1);
    assert.equal(events.list({ type: 'activation' })[0].resetFor, new Date(old).toISOString());
    await activator.tick();
    assert.equal(calls, 1);
    t.t = newer + 1_000;
    await activator.tick();
    await activator.tick();
    assert.equal(calls, 2);
    assert.equal(events.list({ type: 'activation' })[0].resetFor, new Date(newer).toISOString());
  } finally { delete process.env.TEST_GLM_KEY; }
});

test('activator: failure → backoff (no burst), event recorded, single notify flagged', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const resetMs = t.t + 3_600_000;
  const probe = makeProbeWithReset(resetMs, t);
  await probe.refresh('glm-main');

  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [PROVIDER],
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 120, giveUpAfterSec: 300, timeoutSec: 5, backoffStartSec: 120, backoffMaxSec: 3600 } },
    quotaProbe: probe,
    events,
    fetch: async () => new Response('{"error":"busy"}', { status: 429 }),
    now: () => t.t,
  });

  t.t = resetMs - 1_000;
  await activator.tick(); // observe reset before the probe clears it
  t.t = resetMs + 1_000;
  probe.state.get('glm-main').snapshot.tiers.fiveHour.resetMs = null;
  await activator.tick();
  let acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, false);
  assert.equal(acts[0].status, 429);
  assert.match(acts[0].error, /HTTP 429/); // stale endpoint errors visible in memory

  // Inside backoff (120s): no retry.
  t.t = resetMs + 60_000;
  await activator.tick();
  assert.equal(events.list({ type: 'activation' }).length, 1);

  // After backoff, inside giveUpAfter (300s) window: retry #2.
  t.t = resetMs + 125_000;
  await activator.tick();
  acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 2);
  assert.equal(acts[0].attempt, 2); // newest first

  // Past giveUpAfter: no more attempts for this reset moment.
  t.t = resetMs + 400_000;
  await activator.tick();
  assert.equal(events.list({ type: 'activation' }).length, 2);
  delete process.env.TEST_GLM_KEY;
});

test('activator retries 429 after snapshot reset clears, then next reset gets a fresh single attempt', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const old = t.t + 3_600_000;
  const next = old + 5 * 3_600_000;
  const probe = makeProbeWithReset(old, t);
  const events = new EventLog();
  let calls = 0;
  const activator = new WindowActivator({
    providers: [PROVIDER], quotaProbe: probe, events, now: () => t.t,
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60, backoffStartSec: 2, giveUpAfterSec: 300 } },
    fetch: async () => (++calls === 1 ? new Response('{"error":"old endpoint"}', { status: 429 }) : new Response('{}', { status: 200 })),
  });
  try {
    await probe.refresh(PROVIDER.id);
    t.t = old + 1_000;
    probe.state.get(PROVIDER.id).snapshot.tiers.fiveHour.resetMs = null;
    await activator.tick();
    assert.equal(events.list({ type: 'activation' })[0].status, 429);
    assert.equal(events.list({ type: 'activation' })[0].ok, false);
    await activator.tick();
    assert.equal(calls, 1); // same reset backoff, no burst
    t.t += 2_001;
    await activator.tick();
    assert.equal(calls, 2);
    assert.equal(events.list({ type: 'activation' })[0].attempt, 2);
    await activator.tick();
    assert.equal(calls, 2); // success idempotent
    probe.state.get(PROVIDER.id).lastFiveHourReset = { resetMs: next, resetsAt: new Date(next).toISOString() };
    t.t = next + 1_000;
    await activator.tick();
    await activator.tick();
    assert.equal(calls, 3);
    assert.equal(events.list({ type: 'activation' })[0].attempt, 1); // fresh reset
  } finally { delete process.env.TEST_GLM_KEY; }
});

test('activator: weekly quota exhausted → skip activation (no request, no notify), resume after weekly reset', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const fiveHourReset = t.t + 3_600_000;
  const weeklyReset = t.t + 40 * 3_600_000;
  const { probe, cur } = makeProbeWithWeeklyCap(t, { fiveHourResetMs: fiveHourReset, weeklyResetMs: weeklyReset });
  await probe.refresh(PROVIDER.id);

  const calls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [PROVIDER],
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60 } },
    quotaProbe: probe,
    events,
    notifyCfg: { smtpUrl: 'smtp://user:pass@mail.example.com:25/?toAddr=a@b.c' }, // 不应被触发
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); },
    now: () => t.t,
  });

  t.t = fiveHourReset + 5_000;
  await activator.tick();
  assert.equal(calls.length, 0, '额度用满：不发激活请求');
  assert.equal(events.list({ type: 'activation' }).length, 0);
  let skips = events.list({ type: 'activation_skipped' });
  assert.equal(skips.length, 1, '同一额度周期只记一条 skip 事件');
  assert.equal(skips[0].providerId, 'glm-main');
  assert.equal(skips[0].reason, 'quota_exhausted');
  assert.equal(skips[0].resumesAt, new Date(weeklyReset).toISOString());

  const snap = activator.snapshot();
  assert.equal(snap['glm-main'].suppressed.until, new Date(weeklyReset).toISOString());
  assert.equal(snap['glm-main'].suppressed.reason, 'quota_exhausted');

  await activator.tick(); // 幂等：同一额度周期不重复记 skip
  assert.equal(events.list({ type: 'activation_skipped' }).length, 1);

  // 周额度重置已过、快照恢复（周档清除）→ 新窗口观测驱动正常激活
  cur.weeklyResetMs = null;
  const nextReset = t.t + 3_600_000;
  cur.fiveHourResetMs = nextReset;
  t.t += 60_000;
  await probe.refresh(PROVIDER.id, { force: true });
  assert.equal(probe.subscriptionQuotaCap(PROVIDER.id), null);
  assert.equal(activator.snapshot()['glm-main'].suppressed, null);

  t.t = nextReset + 5_000;
  await activator.tick();
  assert.equal(calls.length, 1, '额度恢复后激活回归');
  assert.equal(events.list({ type: 'activation' }).length, 1);
  assert.equal(events.list({ type: 'activation' })[0].ok, true);
  delete process.env.TEST_GLM_KEY;
});

test('activator: 429 quota-cap failure (GLM 1310) → no retry, no notify, quotaExhausted flagged', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const t = { t: 1_000_000 };
  const resetMs = t.t + 3_600_000;
  const probe = makeProbeWithReset(resetMs, t); // 无周档（Lite 形态）→ 预检放行
  await probe.refresh(PROVIDER.id);

  const calls = [];
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [PROVIDER],
    quotaProbe: probe,
    events,
    notifyCfg: { smtpUrl: 'smtp://user:pass@mail.example.com:25/?toAddr=a@b.c' }, // 不应被触发
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60, giveUpAfterSec: 900, backoffStartSec: 120 } },
    fetch: async () => {
      calls.push(1);
      return new Response('{"error":{"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-09-29 10:35:28 重置。"}}', { status: 429 });
    },
    now: () => t.t,
  });

  t.t = resetMs + 1_000;
  await activator.tick();
  const acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, false);
  assert.equal(acts[0].quotaExhausted, true);
  assert.equal(calls.length, 1);

  // 退避期满后也不重试（额度重置前重试必败）
  t.t = resetMs + 300_000;
  await activator.tick();
  t.t = resetMs + 1_000_000;
  await activator.tick();
  assert.equal(calls.length, 1, '额度上限失败：不重试');
  assert.equal(events.list({ type: 'activation' }).length, 1);
  delete process.env.TEST_GLM_KEY;
});

test('parseSmtpUrl: watchtower-style URL parsing', () => {
  const p = parseSmtpUrl('smtp://user:p%40ss@mail.example.com:587/?toAddr=a@b.c&from=gw@x.y');
  assert.equal(p.scheme, 'smtp');
  assert.equal(p.host, 'mail.example.com');
  assert.equal(p.port, 587);
  assert.equal(p.user, 'user');
  assert.equal(p.pass, 'p@ss');
  assert.equal(p.to, 'a@b.c');
  assert.equal(p.from, 'gw@x.y');
  assert.equal(parseSmtpUrl(null), null);
  assert.equal(parseSmtpUrl('https://x'), null);
});

test('parseSmtpUrl smtps default port', () => {
  const p = parseSmtpUrl('smtps://mail.example.com/?toAddr=a@b.c');
  assert.equal(p.port, 465);
  assert.equal(p.implicitTls, true);
  const q = parseSmtpUrl('smtp://mail.example.com/?toAddr=a@b.c');
  assert.equal(q.port, 25);
  assert.equal(q.implicitTls, false);
});

test('parseSmtpUrl: watchtower/shoutrrr 实际形态（2026-09-25 实测）', () => {
  const raw = 'smtp://user:p%40ss@smtp.example.com:465/?fromaddress=x%40x.com&toaddresses=y%40y.com&usestarttls=no&encryption=ImplicitTLS&usehtml=yes';
  const p = parseSmtpUrl(raw);
  assert.equal(p.scheme, 'smtp');
  assert.equal(p.implicitTls, true); // encryption=ImplicitTLS → 隐式 TLS，不看 scheme
  assert.equal(p.host, 'smtp.example.com');
  assert.equal(p.port, 465);
  assert.equal(p.user, 'user');
  assert.equal(p.pass, 'p@ss');
  assert.equal(p.from, 'x@x.com');
  assert.equal(p.to, 'y@y.com');

  // 参数名大小写不敏感 + toaddresses 逗号列表取首个
  const ci = parseSmtpUrl('smtp://u:p@h/?ToAddresses=a%40b.c,d%40e.f&FromAddress=g%40h.i');
  assert.equal(ci.to, 'a@b.c');
  assert.equal(ci.from, 'g@h.i');

  // 隐式 TLS 无端口 → 默认 465；usestarttls=yes 未支持 → 拒配（null）
  assert.equal(parseSmtpUrl('smtp://u:p@h/?toaddresses=a%40b.c&encryption=ImplicitTLS').port, 465);
  assert.equal(parseSmtpUrl('smtp://u:p@h/?toaddresses=a%40b.c&usestarttls=yes'), null);
});
