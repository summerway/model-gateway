// window-activator-claude.test.js — 5h window activation for type:claude
// (Claude 消费级订阅监控伪 provider)。2026-10-19 重实现后的契约：
// 网关进程绝不直发订阅 OAuth /v1/messages（客户端指纹门控 429，2026-10-14
// 实测）——claude 激活经 claimClaudeActivation()/reportClaudeResult() 委托
// 真 Claude Code CLI 执行器（compose sidecar）领取/回报；状态机（窗口观测/
// 去重/退避/锚定/事件/告警）仍在 WindowActivator 内。测试覆盖：claim 到点
// 开火与幂等、失败退避、claim 过期收扫、周额度满额抑制、claudeModel 未配置
// 跳过、reset 保留与锚点回填、事件重建锚点。

import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import {
  WindowActivator, restoreAnchorsFromEvents, CLAUDE_WINDOW_MS, ACTIVATION_ANCHOR_PAD_MS,
} from '../src/ops/jobs/window-activator.js';
import { EventLog } from '../src/events.js';
import { readClaudeCredentials } from '../src/ops/claude-quota.js';

const CLAUDE = {
  id: 'claude', type: 'claude', displayName: 'Claude', credentialFile: '/creds.json', models: [],
};

function claudeBody({ fiveHourResetMs = null, fiveHourUsed = 12.5, weeklyUsed = 31, weeklyResetMs = null } = {}) {
  const weeklyReset = weeklyResetMs ?? 100 * 3_600_000 + (fiveHourResetMs ?? 1_800_000);
  return {
    five_hour: {
      utilization: fiveHourUsed,
      ...(fiveHourResetMs != null ? { resets_at: new Date(fiveHourResetMs).toISOString() } : { resets_at: null }),
    },
    seven_day: { utilization: weeklyUsed, resets_at: new Date(weeklyReset).toISOString() },
    limits: [
      { kind: 'weekly_all', group: '7d', percent: weeklyUsed, resets_at: new Date(weeklyReset).toISOString(), scope: null },
    ],
  };
}

function makeClaudeProbe(clock, opts = {}) {
  let body = claudeBody(opts);
  // probe 自身凭据：默认 1h 后到期（与 activator readCreds 无关的另一份 fixture）；
  // 需要多次跨越 1h 的 refresh 成功时传 credsExpiresAtMs 拉长，否则预检
  // （access token expired）会触发反应式哨兵路径。
  const creds = { claudeAiOauth: { accessToken: 'tok', expiresAt: opts.credsExpiresAtMs ?? clock.t + 3_600_000 } };
  const probe = new QuotaProbe({
    providers: [CLAUDE],
    events: new EventLog(),
    fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    fs: { readFileSync: () => JSON.stringify(creds) },
    now: () => clock.t,
  });
  return { probe, setBody: (b) => { body = b; } };
}

/** 网关侧绝不自发 claude HTTP（指纹门控教训）：任何 fetch 调用都是回归。 */
function forbidFetch(calls = []) {
  return async (url, init) => {
    calls.push(String(url));
    throw new Error(`gateway must not send claude activation HTTP itself: ${url}`);
  };
}

function makeActivator(clock, probe, events, activate = {}) {
  return new WindowActivator({
    providers: [CLAUDE],
    jobs: { activate: { claudeModel: 'claude-haiku-5-5', delaySec: 60, prompt: 'say ok', maxTokens: 64, ...activate } },
    quotaProbe: probe,
    events,
    fetch: forbidFetch(),
    now: () => clock.t,
  });
}

test('claude claim/report: 到点领取一次、回报成功锚定下一窗口、幂等', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  const snap0 = probe.snapshot().claude;
  assert.equal(snap0.tiers.fiveHour.usedPercent, 12.5);
  assert.equal(snap0.tiers.weekly.usedPercent, 31);

  const events = new EventLog();
  const activator = makeActivator(clock, probe, events);

  await activator.tick(); // reset 未到 → 不可领取（响应带 dueAt = 窗口重置时刻）
  const early = activator.claimClaudeActivation();
  assert.equal(early.due, false);
  assert.equal(early.reason, 'not yet reset');
  assert.equal(early.dueAt, new Date(resetMs).toISOString());

  clock.t = resetMs + 5_000;
  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, true);
  assert.equal(claim.model, 'claude-haiku-5-5');
  assert.equal(claim.prompt, 'say ok');
  assert.equal(claim.maxTokens, 64);
  assert.equal(claim.timeoutSec, 180); // claudeCliTimeoutSec 默认
  assert.equal(claim.resetFor, new Date(resetMs).toISOString());
  assert.match(claim.claimId, /^cl-/);

  // 回合在途：不重复发放（单执行器语义）
  const dup = activator.claimClaudeActivation();
  assert.equal(dup.due, false);
  assert.equal(dup.reason, 'claim in flight');
  const snap = activator.snapshot();
  assert.equal(snap.claude.runner, 'host-cli');
  assert.equal(snap.claude.claim.id, claim.claimId);

  // 回报成功 → 事件 + 本地锚定下一窗口（回报时刻 + 5h + pad）
  const rep = activator.reportClaudeResult(claim.claimId, { ok: true, durationMs: 4200 });
  assert.equal(rep.recorded, true);
  const acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, true);
  assert.equal(acts[0].providerId, 'claude');
  assert.equal(acts[0].model, 'claude-haiku-5-5');
  assert.equal(acts[0].durationMs, 4200);
  const best = probe.bestFiveHourReset('claude');
  assert.equal(best.resetMs, clock.t + CLAUDE_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);
  assert.equal(best.local, true);

  // 同一 reset 时刻幂等：不再次发放（旧时刻已处理，新 pending 是锚定的下一窗口）
  await activator.tick();
  const after = activator.claimClaudeActivation();
  assert.equal(after.due, false);
  assert.ok(['already handled', 'not yet reset'].includes(after.reason), `unexpected reason: ${after.reason}`);
  const pending = activator.snapshot().claude.pendingReset;
  assert.equal(pending.src, 'local');
  assert.equal(pending.resetsAt, new Date(clock.t + CLAUDE_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS).toISOString());
  assert.equal(events.list({ type: 'activation' }).length, 1);
  assert.equal(activator.snapshot().claude.claim, null);
});

test('claude claim/report: 回报失败 → 退避期内不发放，退避期满重试成功', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeActivator(clock, probe, events, { giveUpAfterSec: 600, backoffStartSec: 120 });

  clock.t = resetMs + 1_000;
  await activator.tick();
  const c1 = activator.claimClaudeActivation();
  assert.equal(c1.due, true);
  const rep = activator.reportClaudeResult(c1.claimId, { ok: false, status: 1, error: 'cli exited 1: boom' });
  assert.equal(rep.recorded, true);
  const acts = events.list({ type: 'activation' });
  assert.equal(acts[0].ok, false);
  assert.equal(acts[0].attempt, 1);
  assert.match(acts[0].error, /boom/);

  clock.t = resetMs + 60_000; // 120s 退避未满 → 不发放
  await activator.tick();
  const mid = activator.claimClaudeActivation();
  assert.equal(mid.due, false);
  assert.equal(mid.reason, 'backoff');
  assert.equal(mid.dueAt, mid.nextAttemptAt); // dueAt = 退避期满时刻

  clock.t = resetMs + 125_000; // 退避期满、仍在重试窗口（failures>0 + giveUp 内）
  await activator.tick();
  const c2 = activator.claimClaudeActivation();
  assert.equal(c2.due, true);
  assert.notEqual(c2.claimId, c1.claimId);
  activator.reportClaudeResult(c2.claimId, { ok: true, durationMs: 800 });
  const acts2 = events.list({ type: 'activation' });
  assert.equal(acts2[0].ok, true); // newest-first
  assert.equal(acts2[0].attempt, 2);
});

test('claude claim 过期（执行器死亡/失联）→ tick 收扫：失败入账 + 退避', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeActivator(clock, probe, events, { claudeCliTimeoutSec: 60, backoffStartSec: 120 });

  clock.t = resetMs + 5_000;
  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, true);

  // 不回报，越过 TTL（60+30s）→ tick 收扫：按失败处理并解锁
  clock.t += 91_000;
  await activator.tick();
  const acts = events.list({ type: 'activation' });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].ok, false);
  assert.match(acts[0].error, /claim expired/);
  const snap = activator.snapshot().claude;
  assert.equal(snap.claim, null);

  // 迟到的回报 → 忽略（unknown claim）
  const late = activator.reportClaudeResult(claim.claimId, { ok: true });
  assert.equal(late.recorded, false);
  assert.equal(events.list({ type: 'activation' }).length, 1);

  // 退避中不重新发放；退避期满（仍在 giveUp 窗口）可再领取
  assert.equal(activator.claimClaudeActivation().reason, 'backoff');
  clock.t += 125_000;
  await activator.tick();
  assert.equal(activator.claimClaudeActivation().due, true);
});

test('claude: 周（订阅级）额度满额 → 不发放；周重置后回归', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const weeklyResetMs = clock.t + 100 * 3_600_000;
  const { probe, setBody } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs, weeklyUsed: 100, weeklyResetMs });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeActivator(clock, probe, events);

  clock.t = resetMs + 5_000;
  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, false);
  assert.equal(claim.reason, 'quota_exhausted');
  assert.equal(claim.resumesAt, new Date(weeklyResetMs).toISOString());
  assert.equal(events.list({ type: 'activation' }).length, 0);
  const skips = events.list({ type: 'activation_skipped' });
  assert.equal(skips.length, 1);
  assert.equal(skips[0].tier, 'weekly');
  assert.equal(activator.snapshot().claude.suppressed.until, new Date(weeklyResetMs).toISOString());

  await activator.tick();
  assert.equal(events.list({ type: 'activation_skipped' }).length, 1, '同一额度周期只记一条');

  // 周额度恢复 → 激活回归
  const nextReset = clock.t + 3_600_000;
  setBody(claudeBody({ fiveHourResetMs: nextReset, weeklyUsed: 5 }));
  clock.t += 60_000;
  await probe.refresh('claude', { force: true });
  clock.t = nextReset + 5_000;
  await activator.tick();
  const c = activator.claimClaudeActivation();
  assert.equal(c.due, true, '额度恢复后激活回归');
  activator.reportClaudeResult(c.claimId, { ok: true, durationMs: 10 });
  assert.equal(events.list({ type: 'activation' })[0].ok, true);
});

test('claude 未配置 claudeModel → 整体跳过', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = new WindowActivator({
    providers: [CLAUDE],
    jobs: { activate: { model: 'glm-5.3-flash', delaySec: 60 } }, // 只有 GLM 模型
    quotaProbe: probe,
    events,
    fetch: forbidFetch(),
    now: () => clock.t,
  });

  clock.t = resetMs + 5_000;
  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, false);
  assert.match(claim.reason, /not configured/);
  assert.equal(events.list({ type: 'activation' }).length, 0);
  assert.equal(activator.snapshot().claude.active, false);
  assert.match(activator.snapshot().claude.reason, /no activation model/);
});

test('claude: five_hour 清掉 resets_at 后保留观测仍驱动领取；展示由本地锚点回填', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe, setBody } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  assert.equal(probe.fiveHourObservation('claude').resetMs, resetMs);

  // 新快照清掉 resets_at（窗口刚清零/记账延迟形态）
  setBody(claudeBody({ fiveHourResetMs: null }));
  clock.t = resetMs + 1_000;
  await probe.refresh('claude', { force: true });
  assert.equal(probe.snapshot().claude.tiers.fiveHour.resetMs ?? null, null);

  const events = new EventLog();
  const activator = makeActivator(clock, probe, events);
  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, true, '保留的外部观测仍驱动激活');
  activator.reportClaudeResult(claim.claimId, { ok: true, durationMs: 5 });

  const snap = probe.snapshot().claude;
  assert.equal(snap.tiers.fiveHour.estimatedReset, true);
  assert.equal(snap.tiers.fiveHour.resetMs, clock.t + CLAUDE_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);
});

test('claude: 自然窗口错过且零失败 → 不再发放（防陈旧 pending 迟到开火）', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeActivator(clock, probe, events);

  // 执行器全程缺位：错过 delaySec 自然窗口，无失败记录
  clock.t = resetMs + 30 * 60_000;
  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, false);
  assert.equal(claim.reason, 'window passed');
  assert.equal(events.list({ type: 'activation' }).length, 0);
});

test('claude: 重试到 give-up → 重排下一窗口续链（闲置时上游永不报新窗口，防死链）', async () => {
  const clock = { t: 1_000_000 };
  const resetMs = clock.t + 3_600_000;
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeActivator(clock, probe, events, { giveUpAfterSec: 600, backoffStartSec: 120 });

  // 窗口内激活失败一次（退避 120s）
  clock.t = resetMs + 1_000;
  await activator.tick();
  const c1 = activator.claimClaudeActivation();
  assert.equal(c1.due, true);
  activator.reportClaudeResult(c1.claimId, { ok: false, error: 'cli exited 1: boom' });

  // 越过 giveUpAfterSec（600s）→ 标记已处理 + claude 重排 reset+5h+pad，链不断
  clock.t = resetMs + 700_000;
  await activator.tick();
  const gaveup = events.list({ type: 'activation_gaveup' });
  assert.equal(gaveup.length, 1);
  assert.equal(gaveup[0].providerId, 'claude');
  assert.equal(gaveup[0].failures, 1);
  const requeuedMs = resetMs + CLAUDE_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS;
  assert.equal(gaveup[0].requeuedAt, new Date(requeuedMs).toISOString());

  // 下一 tick：pending 换入重排时刻（未到期 → 不发放，响应带 dueAt）
  await activator.tick();
  const mid = activator.claimClaudeActivation();
  assert.equal(mid.due, false);
  assert.equal(mid.reason, 'not yet reset');
  assert.equal(mid.dueAt, new Date(requeuedMs).toISOString());

  // 到重排时刻 → 照常领取激活（链已续上）
  clock.t = requeuedMs + 5_000;
  await activator.tick();
  const c2 = activator.claimClaudeActivation();
  assert.equal(c2.due, true);
  assert.equal(c2.task, 'activate');
  activator.reportClaudeResult(c2.claimId, { ok: true, durationMs: 100 });
  assert.equal(events.list({ type: 'activation' })[0].ok, true);
});

test('restoreAnchorsFromEvents: claude 激活锚点同样可从持久化事件重建', () => {
  const now = 10_000_000_000;
  const probe = makeClaudeProbe({ t: now }, { fiveHourResetMs: null }).probe;
  const retained = [];
  probe.retainActivationAnchor = (id, a) => retained.push({ id, ...a });

  const events = new EventLog();
  const recent = new Date(now - 60_000).toISOString();
  events.buf.push({ ts: recent, type: 'activation', providerId: 'claude', ok: true });

  restoreAnchorsFromEvents({ providers: [CLAUDE], quotaProbe: probe, events, now: () => now });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, 'claude');
  assert.equal(retained[0].resetMs, new Date(recent).getTime() + CLAUDE_WINDOW_MS + ACTIVATION_ANCHOR_PAD_MS);
});

// ── token-refresh 哨兵（2026-10-22）：8h TTL × CLI 惰性刷新 → ~10h 刷新周期
// 有 ~2h40m 的 401 空窗（用量查询刷新失败的根因）。哨兵在 expiresAt 临近时
// 领 token-refresh 回合（真 CLI 启动即轮换）；与激活回合共用单执行器 claim 通道。──

/** 可变凭据引用：readCreds 注入点，测试内模拟 CLI 轮换（改 expiresAt）。 */
function credsRef(expiresAtMs) {
  const ref = { obj: { claudeAiOauth: { accessToken: 'tok', expiresAt: expiresAtMs } } };
  return {
    ref,
    rotate(toMs) { ref.obj.claudeAiOauth.expiresAt = toMs; },
    reader: (file) => readClaudeCredentials(file, { fs: { readFileSync: () => JSON.stringify(ref.obj) } }),
  };
}

function makeSentinelActivator(clock, probe, events, creds, activate = {}) {
  return new WindowActivator({
    providers: [CLAUDE],
    jobs: { activate: { claudeModel: 'claude-haiku-5-5', delaySec: 60, prompt: 'say ok', maxTokens: 64, ...activate } },
    quotaProbe: probe,
    events,
    fetch: forbidFetch(),
    readCreds: creds.reader,
    now: () => clock.t,
  });
}

test('token 哨兵: margin 临近 → 发放 token-refresh 回合；轮换成功 → token_refresh 事件 + 哨兵归零', async () => {
  const clock = { t: 1_800_000_000_000 };
  const creds = credsRef(clock.t + 10 * 60_000); // 10min 后到期 < 900s margin
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: null });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeSentinelActivator(clock, probe, events, creds);

  await activator.tick();
  const snapBefore = activator.snapshot().claude.tokenRefresh;
  assert.equal(snapBefore.state, 'due');

  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, true);
  assert.equal(claim.task, 'token-refresh');
  assert.equal(claim.trigger, 'margin');
  assert.equal(claim.tokenExpiresAt, new Date(clock.t + 10 * 60_000).toISOString());
  assert.equal(claim.model, 'claude-haiku-5-5');
  assert.equal(activator.snapshot().claude.claim.task, 'token-refresh');

  // CLI 轮换：expiresAt 前移 8h
  const rotatedTo = clock.t + 8 * 3_600_000;
  creds.rotate(rotatedTo);
  const rep = activator.reportClaudeResult(claim.claimId, { ok: true, durationMs: 9000 });
  assert.equal(rep.recorded, true);
  const ev = events.list({ type: 'token_refresh' })[0];
  assert.equal(ev.ok, true);
  assert.equal(ev.trigger, 'margin');
  assert.equal(ev.expiresAt, new Date(rotatedTo).toISOString());
  const snapAfter = activator.snapshot().claude.tokenRefresh;
  assert.equal(snapAfter.state, 'fresh');
  assert.equal(snapAfter.expiresAt, new Date(rotatedTo).toISOString());
  assert.equal(snapAfter.failures, 0);
});

test('token 哨兵: CLI 惰性刷新未轮换（margin）→ 非失败 no-op，到真过期点再领', async () => {
  const clock = { t: 1_800_000_000_000 };
  const expires = clock.t + 5 * 60_000;
  const creds = credsRef(expires);
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: null });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeSentinelActivator(clock, probe, events, creds);

  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.task, 'token-refresh');

  // rc 0 但凭据未轮换（token 未到真过期点，CLI 不会主动刷新）
  const rep = activator.reportClaudeResult(claim.claimId, { ok: true, durationMs: 8000 });
  assert.equal(rep.recorded, true);
  const ev = events.list({ type: 'token_refresh' })[0];
  assert.equal(ev.ok, true);
  assert.equal(ev.refreshed, false);
  // no-op 后不再立即重领：nextAttemptAt = 真过期时刻
  clock.t = expires - 60_000;
  await activator.tick();
  assert.equal(activator.claimClaudeActivation().due, false);
  clock.t = expires + 1_000;
  await activator.tick();
  const again = activator.claimClaudeActivation();
  assert.equal(again.due, true);
  assert.equal(again.task, 'token-refresh');
  assert.equal(again.trigger, 'expired');
});

test('token 哨兵: 凭据已过期 → expired 触发；rc 非零 → 失败退避（无 give-up）', async () => {
  const clock = { t: 1_800_000_000_000 };
  const creds = credsRef(clock.t - 60_000); // 已过期
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: null });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeSentinelActivator(clock, probe, events, creds, { backoffStartSec: 120 });

  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.task, 'token-refresh');
  assert.equal(claim.trigger, 'expired');

  activator.reportClaudeResult(claim.claimId, { ok: false, error: 'cli exited 1' });
  assert.equal(events.list({ type: 'token_refresh' })[0].ok, false);
  assert.equal(activator.snapshot().claude.tokenRefresh.state, 'backoff');

  // 退避期内不发放；退避期满重领（不管 giveUpAfterSec —— token 永不放弃）
  clock.t += 60_000;
  assert.equal(activator.claimClaudeActivation().due, false);
  clock.t += 125_000;
  const retry = activator.claimClaudeActivation();
  assert.equal(retry.due, true);
  assert.equal(retry.task, 'token-refresh');
});

test('token 哨兵: 反应式触发 —— 凭据 fresh 但探测 401/403 auth 错误 → auth_error 回合；未轮换 → 退避', async () => {
  const clock = { t: 1_800_000_000_000 };
  const creds = credsRef(clock.t + 7 * 3_600_000); // 文件态 fresh
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: null });
  await probe.refresh('claude');
  probe.state.get('claude').lastError = 'request failed: auth failed (HTTP 401)'; // 服务端吊销
  const events = new EventLog();
  const activator = makeSentinelActivator(clock, probe, events, creds);

  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.task, 'token-refresh');
  assert.equal(claim.trigger, 'auth_error');

  // rc 0 但凭据未变（auth_error 触发下未轮换视为失败）→ 退避防循环
  activator.reportClaudeResult(claim.claimId, { ok: true, durationMs: 7000 });
  const ev = events.list({ type: 'token_refresh' })[0];
  assert.equal(ev.ok, false);
  assert.equal(activator.snapshot().claude.tokenRefresh.state, 'backoff');
});

test('token 哨兵: 激活回合优先（同刻双到期 → activate）；激活在退避 → 哨兵仍可领', async () => {
  const clock = { t: 1_800_000_000_000 };
  const resetMs = clock.t + 3_600_000;
  const creds = credsRef(clock.t + 10 * 60_000); // 同时 margin 内
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeSentinelActivator(clock, probe, events, creds);

  clock.t = resetMs + 5_000;
  await activator.tick();
  const both = activator.claimClaudeActivation();
  assert.equal(both.due, true);
  assert.equal(both.task, 'activate'); // 激活优先
  activator.reportClaudeResult(both.claimId, { ok: false, error: 'boom' });

  // 激活退避（120s）内：哨兵不受激活退避影响，接管 claim 通道
  const tok = activator.claimClaudeActivation();
  assert.equal(tok.due, true);
  assert.equal(tok.task, 'token-refresh');
});

test('token 哨兵: 未到期且无激活窗口 → 响应 dueAt = token 到期前 margin（执行器精确休眠）', async () => {
  const clock = { t: 1_800_000_000_000 };
  const expires = clock.t + 5 * 3_600_000; // fresh（> 900s margin）
  const creds = credsRef(expires);
  const { probe } = makeClaudeProbe(clock, { fiveHourResetMs: null });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeSentinelActivator(clock, probe, events, creds);

  await activator.tick();
  const claim = activator.claimClaudeActivation();
  assert.equal(claim.due, false);
  assert.equal(claim.reason, 'no pending reset');
  assert.equal(claim.dueAt, new Date(expires - 900_000).toISOString()); // margin 900s
});

test('锚点去重: 心跳 resets_at 抖动（26s 孪生锚点）不再触发第二次激活', async () => {
  const clock = { t: 1_800_000_000_000 };
  const resetMs = clock.t + 3_600_000;
  const creds = credsRef(clock.t + 5 * 3_600_000);
  const { probe, setBody } = makeClaudeProbe(clock, { fiveHourResetMs: resetMs, credsExpiresAtMs: clock.t + 48 * 3_600_000 });
  await probe.refresh('claude');
  const events = new EventLog();
  const activator = makeSentinelActivator(clock, probe, events, creds);

  clock.t = resetMs + 5_000;
  await activator.tick();
  const c1 = activator.claimClaudeActivation();
  assert.equal(c1.task, 'activate');
  activator.reportClaudeResult(c1.claimId, { ok: true, durationMs: 500 });
  assert.equal(events.list({ type: 'activation' }).length, 1);

  // 心跳观察到的孪生锚点：reset 时刻 +26s（距上次已处理时刻 < ANCHOR_DEDUP_MS）
  setBody(claudeBody({ fiveHourResetMs: resetMs + 26_000 }));
  clock.t += 30_000;
  await probe.refresh('claude', { force: true });
  await activator.tick();
  const c2 = activator.claimClaudeActivation();
  assert.equal(c2.due, false, '孪生锚点不重复激活');
  assert.equal(events.list({ type: 'activation' }).length, 1);
  // 真·新窗口（距上次已处理 > 90s）仍正常开火
  setBody(claudeBody({ fiveHourResetMs: clock.t + 3_600_000 }));
  clock.t += 3_600_000 + 5_000;
  await probe.refresh('claude', { force: true });
  await activator.tick();
  const c3 = activator.claimClaudeActivation();
  assert.equal(c3.due, true);
  assert.equal(c3.task, 'activate');
});
