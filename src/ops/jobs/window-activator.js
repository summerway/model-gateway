// window-activator.js — 5h window activation (GLM + Codex/ChatGPT + Claude).
// Reads the 5h reset timestamp from the quota probe; after the reset moment
// (within activate.delaySec), sends ONE minimal request to the provider to
// activate the next window. GLM goes direct (Bearer apiKey, chat form);
// codex goes through its registry runtime (OAuth + SSE aggregate). Failure →
// exponential backoff, never concurrent bursts. Every activation attempt
// records an event; optional SMTP notification on activation failure
// (credentials from env at runtime).
//
// Claude（2026-10-19 重实现）：订阅 OAuth /v1/messages 有客户端指纹门控
// （2026-10-14 实测：同 token/IP 同分钟，真 CLI 200、网关裸请求 429
// rate_limit_error；CLI 2.1.299 指纹含 x-app/User-Agent/X-Claude-Code-
// Session-Id/anthropic-beta + 带 tk 签名的 metadata.user_id，进程内伪装
// 不可持续）。因此 claude 激活不发自本进程：claimClaudeActivation()/
// reportClaudeResult() 把「到点开火」委托给宿主侧真 Claude Code CLI 执行器
// （compose sidecar claude-activator，轮询 /internal/activator/claude/*）。
// 状态机（窗口观测/去重/退避/锚定/事件/告警）仍在本类内单一事实源。
//
// Claude token-refresh 哨兵（2026-10-22）：accessToken TTL 8h，而真 CLI 惰性
// 刷新（只在已过期时）——叠加 5h 激活节奏，实际每 ~10h 才轮换一次，留下最长
// ~2h40m 的 401 空窗（用量查询刷新失败、退避风暴连坐 429）。哨兵复用同一
// claim 通道：expiresAt 临近/已过，或额度探测报 auth 错误时，发放
// task=token-refresh 回合（同一最小 CLI 轮次，CLI 启动即完成 OAuth 轮换）；
// 回报时验凭据文件 expiresAt 是否前移判定成功。CLI 惰性语义兼容：margin 预
// 领但未轮换（未到期）不算失败，改到真过期点再领。激活回合优先（它本身也
// 轮换 token）。网关永不自行刷新 token（挂载只读，防烧单次性 refresh 链）。

import { resolveRef } from '../../config.js';
import { sendMail } from '../notify.js';
import { readClaudeCredentials } from '../claude-quota.js';

const DEFAULTS = {
  enabled: true,
  model: null, // GLM 激活用模型（未配置 → GLM 不激活）
  codexModel: null, // codex(ChatGPT) 激活用模型（未配置 → codex 不激活）
  claudeModel: null, // claude 订阅激活用模型（未配置 → claude 不激活）
  // claude 激活执行方式：host-cli = 委托真 Claude Code CLI 执行器（唯一形态；
  // 进程内直发已被指纹门控 429 证死，不留开关防误开）
  claudeRunner: 'host-cli',
  claudeCliTimeoutSec: 180, // 真 CLI 冷启动含插件装载，比裸 HTTP 宽
  // token-refresh 哨兵提前量：凭据 expiresAt 距今 <= 本值（秒）时发放
  // token-refresh 回合。CLI 惰性刷新（未到期不轮换）→ noop 后到真过期点再领；
  // 0 = 关闭主动哨兵（仅保留探测 auth 错误的反应式触发）。
  claudeTokenRefreshMarginSec: 900,
  // 订阅级额度（周/月上限）用完 → 跳过激活：不发请求、不重试、不告警，
  // 额度重置（探测快照恢复）后自动回归正常激活。
  skipWhenExhausted: true,
  delaySec: 60,
  giveUpAfterSec: 900, // stop retrying a reset moment after this long (15min default)
  // 实测（2026-09-24）：max_tokens=1 的“零用量”请求 GLM 不会提交窗口（200 但
  // 监控无窗口/无重置时间）；必须产生真实用量才能锚定。默认让模型输出 ~几十
  // token，相对 5h 窗口额度可忽略。
  prompt: 'Reply with the two letters OK, repeated 30 times, separated by spaces. No other words.',
  maxTokens: 200,
  timeoutSec: 30,
  backoffStartSec: 120,
  backoffMaxSec: 3600,
};

// GLM anchors a fresh 5h window at the activation request, a few seconds
// AFTER our fetch resolves (server-side post-processing). Pad the locally
// derived anchor so we never fire the next activation before the true reset.
export const ACTIVATION_ANCHOR_PAD_MS = 15_000;
export const GLM_WINDOW_MS = 5 * 3_600_000;
// ChatGPT codex primary_window（wham/usage limit_window_seconds=18000）同为 5h。
export const CODEX_WINDOW_MS = 5 * 3_600_000;
// Claude 订阅 five_hour 窗口同为 5h（/api/oauth/usage five_hour.resets_at）。
export const CLAUDE_WINDOW_MS = 5 * 3_600_000;
// 同一窗口的双锚点去重：上游 resets_at 抖动（实测同一重置两套观测差 ~0.4s，
// 外部锚 vs 本地锚差 ~26s）曾被当作两个窗口 → 一次重置激活两回（10-21/10-22
// 事件成对 ~30-70s）。距上次已处理时刻 <= 本值的"新"外部锚点一律视为同一窗口。
// 远小于窗口长（5h），不影响真实下一窗口（>= 5h 后）的接纳。
export const ANCHOR_DEDUP_MS = 90_000;

/** Providers the activator can handle. */
export function isActivatableProvider(p) {
  return p?.type === 'glm' || p?.type === 'codex' || p?.type === 'claude';
}

/** 激活失败是否属于「订阅级额度用完」（非瞬时限流）。此类失败重试无意义：
 *  不退避、不重试、不发 SMTP；额度重置后自动恢复。识别口径保守：
 *  GLM code 1310（每周/每月使用上限）／中文「已达到…上限」文案／
 *  ChatGPT「usage limit」；普通 429 rate limited 不匹配（仍走退避+告警）。 */
export function isQuotaCapFailure(outcome) {
  if (!outcome || outcome.ok) return false;
  const err = String(outcome.error ?? '');
  return /"code"\s*:\s*"1310"/.test(err) || /已达到.{0,16}上限/.test(err) || /usage limit/i.test(err);
}

/** token-refresh 反应式触发：额度探测的 auth 类失败（401/403/token 过期）。
 *  与 claude-quota 预检错误文案（"access token expired at …"）保持同口径。 */
export function isClaudeAuthError(message) {
  return /auth failed \(HTTP 40[13]\)|access token expired/i.test(String(message ?? ''));
}

function windowMsFor(provider) {
  if (provider.type === 'codex') return CODEX_WINDOW_MS;
  if (provider.type === 'claude') return CLAUDE_WINDOW_MS;
  return GLM_WINDOW_MS;
}

/**
 * Rebuild 5h anchors from persisted activation events (boot recovery —
 * the in-memory retained anchor dies with the process). Newest successful
 * activation per provider whose derived anchor is still in the future wins.
 */
export function restoreAnchorsFromEvents({ providers, quotaProbe, events, now = Date.now } = {}) {
  if (!quotaProbe?.retainActivationAnchor || !events?.list) return;
  const t = now();
  for (const p of providers.filter(isActivatableProvider)) {
    const last = events.list({ type: 'activation', limit: 50 }).find((e) => e.providerId === p.id && e.ok);
    if (!last) continue;
    const anchorMs = new Date(last.ts).getTime() + windowMsFor(p) + ACTIVATION_ANCHOR_PAD_MS;
    if (anchorMs > t) quotaProbe.retainActivationAnchor(p.id, { resetMs: anchorMs });
  }
}

export class WindowActivator {
  /**
   * @param {object} opts
   * @param {object} opts.providers - catalog providers (glm/codex activated)
   * @param {object} opts.jobs - config.jobs (probe + activate)
   * @param {object} opts.quotaProbe - QuotaProbe instance (reset source)
   * @param {object} opts.events - EventLog
   * @param {object} [opts.registry] - codex provider registry (activation path)
   * @param {object} [opts.notifyCfg] - {smtpUrl, from, to} (refs resolved by caller)
   * @param {Function} [opts.fetch]
   * @param {Function} [opts.readCreds] - claude 凭据文件读取（注入点，测试用；
   *   默认 readClaudeCredentials —— 只读，永不写回）
   * @param {() => number} [opts.now]
   */
  constructor({ providers, jobs = {}, quotaProbe, events, registry, notifyCfg, fetch: fetchFn, readCreds, now } = {}) {
    const cfg = { ...DEFAULTS, ...(jobs?.activate ?? {}) };
    this.cfg = cfg;
    this.providers = providers.filter(isActivatableProvider);
    this.registry = registry ?? null;
    this.quotaProbe = quotaProbe;
    this.events = events;
    this.notifyCfg = notifyCfg ?? null;
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.readCreds = readCreds ?? readClaudeCredentials;
    this.now = now ?? Date.now;
    // providerId -> {lastResetHandledMs, pendingReset, queuedReset, failures, nextAttemptAt, activating}
    this.state = new Map();
    this.timer = null;
  }

  start() {
    if (!this.cfg.enabled || this.timer || this.providers.length === 0) return this;
    if (!this.providers.some((p) => this.#activationModel(p))) return this; // 无可用激活模型 → 不启动
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, Math.min(this.cfg.delaySec, 15) * 1000); // poll often enough to meet 60s activation window; sends only once
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /** /internal/activator 数据：各 provider 的待激活窗口与重试状态（只读）。 */
  snapshot() {
    const out = {};
    for (const p of this.providers) {
      if (!this.#activationModel(p)) {
        out[p.id] = { active: false, reason: `no activation model configured for ${p.type}` };
        continue;
      }
      const st = this.#state(p.id); // 与 tick/claim 同源；首 tick 前也能如实报告武装态
      const cap = this.cfg.skipWhenExhausted === false
        ? null
        : this.quotaProbe?.subscriptionQuotaCap?.(p.id, this.now());
      out[p.id] = {
        active: true,
        model: this.#activationModel(p),
        // claude 委托执行：当前在途回合（执行器已领取未回报）+ token 哨兵状态
        ...(p.type === 'claude'
          ? {
              runner: this.cfg.claudeRunner,
              claim: st.claim ? { id: st.claim.id, task: st.claim.kind === 'token-refresh' ? 'token-refresh' : 'activate', expiresAt: st.claim.expiresAtIso } : null,
              tokenRefresh: this.#tokenRefreshSnapshot(p, st),
            }
          : {}),
        // 额度用满抑制中（实时计算；无状态、随探测快照即时解除）
        suppressed: cap ? { reason: 'quota_exhausted', tier: cap.tier, usedPercent: cap.usedPercent, until: cap.resetsAt } : null,
        pendingReset: st.pendingReset
          ? { resetsAt: st.pendingReset.resetsAt, src: st.pendingReset.src }
          : null,
        queuedReset: st.queuedReset
          ? { resetsAt: st.queuedReset.resetsAt, src: st.queuedReset.src }
          : null,
        attempts: st.attempts ?? 0,
        failures: st.failures ?? 0,
        nextAttemptAt: st.nextAttemptAt > 0 ? new Date(st.nextAttemptAt).toISOString() : null,
        lastResetHandledAt: st.lastResetHandledMs ? new Date(st.lastResetHandledMs).toISOString() : null,
      };
    }
    return out;
  }

  /**
   * One activation cycle. For every GLM/codex provider whose 5h reset moment
   * passed and has not been handled yet (and not in failure backoff), fire one
   * minimal request. Safe to call frequently: idempotent per reset moment.
   *
   * Retry semantics: the natural window is (reset, reset + delaySec]; with
   * failures, retries (backoff-gated) continue up to giveUpAfterSec past the
   * reset moment, then the moment is marked handled to stop trying forever.
   */
  async tick() {
    const t = this.now();
    this.#expireClaudeClaims(t);
    for (const provider of this.providers) {
      if (!this.#activationModel(provider)) continue; // 该类型未配置激活模型
      const st = this.#state(provider.id);
      // 订阅级额度（周/月上限）用完 → 整体跳过该 provider：不发请求、不动
      // 窗口状态机（旧 pending 时刻自然过期），额度重置后由新观测恢复链路。
      // 同一额度周期只记一条 activation_skipped 事件（额度重置锚点去重）。
      const cap = this.cfg.skipWhenExhausted === false
        ? null
        : this.quotaProbe?.subscriptionQuotaCap?.(provider.id, t);
      if (cap) {
        if (st.skippedForCapMs !== cap.resetMs) {
          st.skippedForCapMs = cap.resetMs;
          this.events?.record('activation_skipped', {
            providerId: provider.id,
            reason: 'quota_exhausted',
            tier: cap.tier,
            usedPercent: cap.usedPercent,
            resumesAt: cap.resetsAt,
          });
        }
        continue;
      }
      const observed = this.#providerFiveHourReset(provider.id, st);
      // 本地推算 pending 是估计值：未到期且未尝试时，任何新鲜的外部权威锚点
      // （晚于上次已处理时刻，含已到期的）直接置换它 —— 否则本地会永久遮蔽比它
      // 早几秒的 GLM 权威锚点。已到期的 pending 不置换 —— 保障「先消耗旧时刻
      // 再接新时刻」的语义。
      if (observed?.src === 'external' && observed.resetMs > (st.lastResetHandledMs ?? -Infinity) &&
          st.pendingReset?.src === 'local' && (st.attempts ?? 0) === 0 && t <= st.pendingReset.resetMs) {
        st.pendingReset = { resetMs: observed.resetMs, resetsAt: observed.resetsAt, src: 'external' };
        st.queuedReset = null;
        st.failures = 0;
        st.nextAttemptAt = 0;
        st.attempts = 0;
        st.notifiedForReset = null;
      }
      // GLM drops nextResetTime as soon as a window clears. Retain the last
      // observed reset so the probe cannot erase a pending activation/retry.
      if (observed && observed.resetMs > (st.pendingReset?.resetMs ?? -Infinity) &&
          observed.resetMs > (st.queuedReset?.resetMs ?? -Infinity)) {
        st.queuedReset = { resetMs: observed.resetMs, resetsAt: observed.resetsAt, src: observed.src };
      }
      const old = st.pendingReset;
      if (!old || (st.queuedReset && !st.activating &&
          (st.lastResetHandledMs === old.resetMs || t > old.resetMs + this.cfg.giveUpAfterSec * 1000))) {
        st.pendingReset = st.queuedReset;
        st.queuedReset = null;
        st.failures = 0;
        st.nextAttemptAt = 0;
        st.attempts = 0;
        st.notifiedForReset = null;
      }
      const reset = st.pendingReset;
      if (!reset) continue;

      if (t <= reset.resetMs) continue; // not yet reset
      const inNaturalWindow = t <= reset.resetMs + this.cfg.delaySec * 1000;
      const inRetryWindow = st.failures > 0 && t <= reset.resetMs + this.cfg.giveUpAfterSec * 1000;
      if (!inNaturalWindow && !inRetryWindow) {
        // Gave up (or window passed cleanly) — mark handled so a late tick
        // doesn't fire after the fact when failures occurred.
        if (st.lastResetHandledMs !== reset.resetMs && st.failures > 0) {
          st.lastResetHandledMs = reset.resetMs;
          // claude 特例（2026-11-03）：闲置时上游永不报新窗口（5h 窗口仅由
          // 真实用量开启，网关自身对 claude 零流量），give-up 后没有外部
          // 锚点来续链 → 背靠背链会死到 Mac 侧有真实使用为止。把时刻重排到
          // reset + 窗口长（假设该窗口已开，下一轮再锚定），链不断；失败
          // 原因若是持久的（额度/凭据），由抑制/哨兵机制自然接管。GLM/codex
          // 的监控接口随真实流量自然恢复锚点，不重排。
          if (provider.type === 'claude') {
            const requeuedMs = reset.resetMs + windowMsFor(provider) + ACTIVATION_ANCHOR_PAD_MS;
            if (!st.queuedReset || requeuedMs < st.queuedReset.resetMs) {
              st.queuedReset = { resetMs: requeuedMs, resetsAt: new Date(requeuedMs).toISOString(), src: 'local' };
            }
            this.events?.record('activation_gaveup', {
              providerId: provider.id,
              resetFor: reset.resetsAt,
              failures: st.failures,
              attempts: st.attempts,
              requeuedAt: new Date(requeuedMs).toISOString(),
            });
          }
        }
        continue;
      }
      if (st.lastResetHandledMs === reset.resetMs || st.activating) continue; // done / concurrent tick
      if (st.nextAttemptAt > t) continue; // failure backoff

      // claude 不发自本进程：到点后停在这里，等真 CLI 执行器领取（claim）。
      // 门控（窗口/退避/额度抑制/give-up）已在本 tick 前置校验完成。
      if (provider.type === 'claude') continue;

      st.activating = true;
      try {
        await this.#activate(provider, reset);
      } finally {
        st.activating = false;
      }
    }
  }

  /** 到期 claude 回合过期（执行器死亡/网关失联）：清锁、按失败退避，
   *  事件可见。在 tick 中每次巡检。token-refresh 回合过期只退避 token 哨兵
   *  （不动窗口状态机）。 */
  #expireClaudeClaims(t) {
    for (const p of this.providers) {
      if (p.type !== 'claude') continue;
      const st = this.state.get(p.id);
      if (!st?.activating || !st.claim) continue;
      if (st.claim.expiresAtMs > t) continue;
      const claim = st.claim;
      st.claim = null;
      st.activating = false;
      if (claim.kind === 'token-refresh') {
        const tok = this.#tokenState(st);
        tok.failures += 1;
        tok.nextAttemptAt = t + this.#tokenBackoffMs(tok.failures);
        this.events?.record('token_refresh', {
          providerId: p.id,
          ok: false,
          trigger: claim.trigger,
          error: `executor claim expired (no result within ${claim.ttlSec}s)`,
        });
        continue;
      }
      const reset = st.pendingReset;
      if (reset) {
        this.#finishActivation(p, reset, { ok: false, error: `executor claim expired (no result within ${claim.ttlSec}s)` });
      }
    }
  }

  #state(providerId) {
    let st = this.state.get(providerId);
    if (!st) {
      st = { lastResetHandledMs: null, pendingReset: null, queuedReset: null, failures: 0, nextAttemptAt: 0, attempts: 0, activating: false };
      this.state.set(providerId, st);
    }
    return st;
  }

  /** claude token 哨兵状态（惰性建；与窗口状态机分离，共享 claim 通道锁）。 */
  #tokenState(st) {
    if (!st.token) {
      st.token = { failures: 0, nextAttemptAt: 0, lastRefreshAtMs: null };
    }
    return st.token;
  }

  /** token 哨兵失败退避：与激活同基（120s→3600s 封顶），但不设 give-up ——
   *  token 不轮换 401 空窗就永不自愈，必须一直重试。 */
  #tokenBackoffMs(failures) {
    return Math.min(this.cfg.backoffStartSec * 2 ** Math.max(0, failures - 1), this.cfg.backoffMaxSec) * 1000;
  }

  /** token 哨兵求值：主动（expiresAt 临近/已过）或反应式（探测 auth 错误）。
   *  返回 {due:true, trigger:'margin'|'expired'|'auth_error', expiresAtMs:number|null}
   *  或 {due:false, reason}。反应式独立于文件态（token 被服务端吊销/时钟漂移
   *  时文件看起来仍是 fresh）。 */
  #claudeTokenDue(p, st, t) {
    const tok = this.#tokenState(st);
    if (tok.nextAttemptAt > t) return { due: false, reason: 'backoff' };
    const creds = this.readCreds(p.credentialFile);
    const marginMs = this.cfg.claudeTokenRefreshMarginSec * 1000;
    let expiresAtMs = null;
    if (creds.ok && creds.expiresAt !== null) {
      expiresAtMs = creds.expiresAt;
      if (creds.expiresAt <= t) return { due: true, trigger: 'expired', expiresAtMs };
      if (marginMs > 0 && creds.expiresAt - t <= marginMs) {
        return { due: true, trigger: 'margin', expiresAtMs };
      }
    }
    // 反应式：探测 auth 类失败（优先直读探测状态，兼容无 state 的 fake probe）
    const lastError = this.quotaProbe?.state?.get?.(p.id)?.lastError
      ?? this.quotaProbe?.snapshot?.()[p.id]?.lastError
      ?? null;
    if (isClaudeAuthError(lastError)) return { due: true, trigger: 'auth_error', expiresAtMs };
    if (!creds.ok) return { due: false, reason: 'credentials unreadable' };
    return { due: false, reason: expiresAtMs === null ? 'no expiresAt' : 'fresh' };
  }

  /** token 哨兵快照（claude 卡片/排障可见）：当前凭据到期时刻、哨兵状态。 */
  #tokenRefreshSnapshot(p, st) {
    const t = this.now();
    const tok = this.#tokenState(st);
    const creds = this.readCreds(p.credentialFile);
    const expiresAtMs = creds.ok ? creds.expiresAt : null;
    const marginMs = this.cfg.claudeTokenRefreshMarginSec * 1000;
    let state;
    if (st.activating && st.claim?.kind === 'token-refresh') state = 'refreshing';
    else if (tok.nextAttemptAt > t) state = 'backoff';
    else if (expiresAtMs === null) state = creds.ok ? 'unknown' : 'unreadable';
    else if (expiresAtMs - t <= marginMs || expiresAtMs <= t) state = 'due';
    else state = 'fresh';
    return {
      marginSec: this.cfg.claudeTokenRefreshMarginSec,
      expiresAt: expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
      state,
      failures: tok.failures,
      nextAttemptAt: tok.nextAttemptAt > 0 ? new Date(tok.nextAttemptAt).toISOString() : null,
      lastRefreshAt: tok.lastRefreshAtMs ? new Date(tok.lastRefreshAtMs).toISOString() : null,
    };
  }

  /** 该 provider 的激活用模型（glm → cfg.model；codex → cfg.codexModel；claude → cfg.claudeModel）。 */
  #activationModel(provider) {
    if (provider.type === 'codex') return this.cfg.codexModel;
    if (provider.type === 'claude') return this.cfg.claudeModel;
    return this.cfg.model;
  }

  #providerFiveHourReset(providerId, st = {}) {
    // 心跳观察流：外部权威值优先（未来值，或晚于上次已处理时刻 + 去重窗的
    // 已到期新鲜值——到期即需激活）；仅当外部值既非未来也未处理过时才用本地
    // 推算桥接。去重窗（ANCHOR_DEDUP_MS）：上游 resets_at 抖动产生的孪生锚点
    // （距上次已处理时刻 <90s）视为同一窗口，不再触发第二回激活。
    const t = this.now();
    const known = this.quotaProbe?.fiveHourObservation?.(providerId)
      ?? this.quotaProbe?.lastFiveHourReset?.(providerId);
    if (known && (known.resetMs > t || known.resetMs > (st.lastResetHandledMs ?? -Infinity) + ANCHOR_DEDUP_MS)) {
      return { resetMs: known.resetMs, resetsAt: known.resetsAt, src: 'external' };
    }
    const local = this.quotaProbe?.bestFiveHourReset?.(providerId);
    if (local && local.resetMs > t) return { resetMs: local.resetMs, resetsAt: local.resetsAt, src: 'local' };
    if (known) return { resetMs: known.resetMs, resetsAt: known.resetsAt, src: 'external' };
    return null;
  }

  /**
   * Send the single minimal activation request (glm direct HTTP / codex via
   * registry runtime). Records events; on failure, schedule backoff and
   * (optionally) send one SMTP notification. claude 不在此列（真 CLI 执行器
   * 经 claim/report 驱动，结果同样汇入 #finishActivation）。
   */
  async #activate(provider, reset) {
    const model = this.#activationModel(provider);
    let outcome;
    if (provider.type === 'codex') {
      outcome = await this.#activateViaCodex(provider, model);
    } else {
      outcome = await this.#activateViaGlm(provider, model);
    }
    this.#finishActivation(provider, reset, outcome);
  }

  /** 真 CLI 执行器领取一个到期的 claude 回合（单执行器；幂等去重）。
   *  返回 {due:false,reason,...} 或 {due:true,task,claimId,model,prompt,
   *  maxTokens,timeoutSec,...}。task: 'activate'（5h 窗口激活，原任务）或
   *  'token-refresh'（OAuth token 轮换，哨兵任务）。门控与 tick 同源：额度
   *  抑制 / 窗口 / 已处理 / 退避；token 哨兵在激活无到期回合时接管 claim。 */
  claimClaudeActivation() {
    const p = this.providers.find((x) => x.type === 'claude');
    if (!p || !this.cfg.claudeModel) return { due: false, reason: 'claude activation not configured' };
    const t = this.now();
    const st = this.#state(p.id);
    const cap = this.cfg.skipWhenExhausted === false
      ? null
      : this.quotaProbe?.subscriptionQuotaCap?.(p.id, t);
    if (cap) return { due: false, reason: 'quota_exhausted', resumesAt: cap.resetsAt, dueAt: cap.resetsAt };
    if (st.activating) {
      return { due: false, reason: 'claim in flight', claimExpiresAt: st.claim?.expiresAtIso ?? null };
    }
    // ── 激活通道（原逻辑，reason 口径不变；退避不早退 —— 不让激活退避饿死
    //    token 哨兵，两者独立关切）──
    const reset = st.pendingReset;
    let activationReason = null;
    let activationBlocked = null; // 带额外载荷的未到期形态（如退避）
    if (!reset) activationReason = 'no pending reset';
    else if (t <= reset.resetMs) activationReason = 'not yet reset';
    else {
      const inNaturalWindow = t <= reset.resetMs + this.cfg.delaySec * 1000;
      const inRetryWindow = st.failures > 0 && t <= reset.resetMs + this.cfg.giveUpAfterSec * 1000;
      if (!inNaturalWindow && !inRetryWindow) activationReason = 'window passed';
      else if (st.lastResetHandledMs === reset.resetMs) activationReason = 'already handled';
      else if (st.nextAttemptAt > t) {
        activationBlocked = { due: false, reason: 'backoff', nextAttemptAt: new Date(st.nextAttemptAt).toISOString(), dueAt: new Date(st.nextAttemptAt).toISOString() };
      }
    }
    if (activationReason === null && activationBlocked === null) {
      const claim = this.#issueClaudeClaim(st, t, { kind: 'activate' });
      return {
        due: true,
        task: 'activate',
        claimId: claim.id,
        model: this.cfg.claudeModel,
        prompt: this.cfg.prompt,
        maxTokens: this.cfg.maxTokens,
        timeoutSec: this.cfg.claudeCliTimeoutSec,
        resetFor: reset.resetsAt,
      };
    }
    // ── token-refresh 哨兵：激活无到期回合时接管同一 claim 通道 ──
    const token = this.#claudeTokenDue(p, st, t);
    if (token.due) {
      const claim = this.#issueClaudeClaim(st, t, {
        kind: 'token-refresh',
        trigger: token.trigger,
        tokenExpiresAtMs: token.expiresAtMs,
      });
      return {
        due: true,
        task: 'token-refresh',
        claimId: claim.id,
        model: this.cfg.claudeModel,
        prompt: this.cfg.prompt,
        maxTokens: this.cfg.maxTokens,
        timeoutSec: this.cfg.claudeCliTimeoutSec,
        trigger: token.trigger,
        ...(token.expiresAtMs !== null ? { tokenExpiresAt: new Date(token.expiresAtMs).toISOString() } : {}),
      };
    }
    return activationBlocked ?? this.#notDueWithNextClaimAt(p, st, t, activationReason);
  }

  /** 未到期响应附带 dueAt（下一可领取时刻，ISO）：执行器据此精确睡到点再领，
   *  替代盲轮询（2026-11-03）。优先级：激活退避 → 激活窗口时刻 → token 哨兵
   *  退避 → token 到期前 margin。拿不到可靠时刻则不携带（执行器退回固定短轮询）。*/
  #notDueWithNextClaimAt(p, st, t, reason) {
    let dueAtMs = null;
    if (st.nextAttemptAt > t) dueAtMs = st.nextAttemptAt;
    else if (st.pendingReset && st.pendingReset.resetMs > t) dueAtMs = st.pendingReset.resetMs;
    else if (st.token?.nextAttemptAt > t) dueAtMs = st.token.nextAttemptAt;
    else {
      const creds = this.readCreds(p.credentialFile);
      const expiresAtMs = creds.ok ? creds.expiresAt : null;
      if (expiresAtMs !== null) {
        const dueMs = expiresAtMs - this.cfg.claudeTokenRefreshMarginSec * 1000;
        if (dueMs > t) dueAtMs = dueMs;
      }
    }
    return { due: false, reason, ...(dueAtMs !== null ? { dueAt: new Date(dueAtMs).toISOString() } : {}) };
  }

  /** 发放 claude 回合（激活/token 共用：锁 st.activating + st.claim）。 */
  #issueClaudeClaim(st, t, { kind, trigger = null, tokenExpiresAtMs = null } = {}) {
    const ttlSec = this.cfg.claudeCliTimeoutSec + 30;
    const claim = {
      id: `cl-${t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      ...(trigger ? { trigger } : {}),
      ...(kind === 'token-refresh' ? { tokenExpiresAtMs } : {}),
      ttlSec,
      issuedAtMs: t,
      expiresAtMs: t + ttlSec * 1000,
      expiresAtIso: new Date(t + ttlSec * 1000).toISOString(),
    };
    st.activating = true;
    st.claim = claim;
    return claim;
  }

  /** 执行器回报 claude 回合结果（激活：成功/失败统一走 #finishActivation；
   *  token-refresh：验凭据文件 expiresAt 前移判定）；claim 不匹配 → 忽略
   *  （已过期被 tick 收扫）。 */
  reportClaudeResult(claimId, outcome) {
    const p = this.providers.find((x) => x.type === 'claude');
    if (!p) return { recorded: false, reason: 'claude not configured' };
    const st = this.state.get(p.id);
    if (!st?.claim || st.claim.id !== claimId) return { recorded: false, reason: 'unknown claim' };
    const claim = st.claim;
    st.claim = null;
    st.activating = false;
    if (claim.kind === 'token-refresh') return this.#finishTokenRefresh(p, claim, outcome);
    const reset = st.pendingReset;
    if (!reset) return { recorded: false, reason: 'no pending reset' };
    this.#finishActivation(p, reset, {
      ok: outcome?.ok === true,
      ...(typeof outcome?.status === 'number' ? { status: outcome.status } : {}),
      ...(typeof outcome?.error === 'string' && outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
      ...(typeof outcome?.durationMs === 'number' ? { durationMs: outcome.durationMs } : {}),
    });
    return { recorded: true };
  }

  /** token-refresh 回报入账：CLI rc 0 且凭据 expiresAt 前移 → 成功；CLI 惰性
   *  刷新下 margin 预领未轮换不算失败（改到真过期点再领）；rc 非零或凭据
   *  未变（auth_error 触发）→ 退避重试（无 give-up）。事件类型 token_refresh。 */
  #finishTokenRefresh(p, claim, outcome) {
    const st = this.#state(p.id);
    const tok = this.#tokenState(st);
    const t = this.now();
    const base = {
      providerId: p.id,
      trigger: claim.trigger,
      ...(typeof outcome?.durationMs === 'number' ? { durationMs: outcome.durationMs } : {}),
    };
    if (outcome?.ok !== true) {
      tok.failures += 1;
      tok.nextAttemptAt = t + this.#tokenBackoffMs(tok.failures);
      this.events?.record('token_refresh', {
        ...base,
        ok: false,
        ...(typeof outcome?.error === 'string' && outcome.error ? { error: outcome.error.slice(0, 300) } : {}),
      });
      return { recorded: true };
    }
    const creds = this.readCreds(p.credentialFile);
    const after = creds.ok ? creds.expiresAt : null;
    const advanced = after !== null && (claim.tokenExpiresAtMs === null || after > claim.tokenExpiresAtMs);
    if (advanced) {
      tok.failures = 0;
      tok.nextAttemptAt = 0;
      tok.lastRefreshAtMs = t;
      this.events?.record('token_refresh', {
        ...base,
        ok: true,
        expiresAt: new Date(after).toISOString(),
      });
      return { recorded: true };
    }
    if (claim.trigger === 'margin' || claim.trigger === 'expired') {
      // CLI 惰性刷新：token 仍未到期（或时钟尚差一点）→ 非失败；到真过期点再领
      tok.failures = 0;
      tok.nextAttemptAt = after !== null ? Math.max(after, t) : t + this.#tokenBackoffMs(1);
      this.events?.record('token_refresh', {
        ...base,
        ok: true,
        refreshed: false,
        note: 'cli lazy refresh: token not rotated (not yet expired), re-armed at expiry',
      });
      return { recorded: true };
    }
    // auth_error 触发且 rc 0 但凭据未变：视为失败退避（防循环）
    tok.failures += 1;
    tok.nextAttemptAt = t + this.#tokenBackoffMs(tok.failures);
    this.events?.record('token_refresh', {
      ...base,
      ok: false,
      error: 'cli reported ok but credentials expiresAt did not advance',
    });
    return { recorded: true };
  }

  /** 统一结果处理（glm/codex 进程内路径与 claude 执行器回报共用）：事件、
   *  周额抑制识别、成功锚定下一窗口、失败退避 + 单次 SMTP 告警。 */
  #finishActivation(provider, reset, outcome) {
    const st = this.#state(provider.id);
    const t = this.now();
    const model = this.#activationModel(provider);
    st.attempts += 1;
    const quotaCap = !outcome.ok && isQuotaCapFailure(outcome);
    const event = {
      providerId: provider.id,
      model,
      maxTokens: this.cfg.maxTokens,
      resetFor: reset.resetsAt,
      attempt: st.attempts,
      ...(quotaCap ? { quotaExhausted: true } : {}),
      ...outcome,
    };
    this.events?.record('activation', event);

    if (outcome.ok) {
      st.lastResetHandledMs = reset.resetMs;
      st.failures = 0;
      st.nextAttemptAt = 0;
      // 监控接口对新窗口有记账延迟（GLM ~5-10 分钟，且用量≈0 时甚至不报窗口）。
      // 激活成功即本地锚定下一窗口（请求时刻 + 窗口长 + padding），倒计时与下一轮
      // 激活不再依赖上游上报；权威值通过独立槽位共存（bestFiveHourReset
      // 取较大者）。网关重启后 restoreAnchorsFromEvents 从持久化事件重建。
      // codex 同理：wham/usage 对近零用量的新窗口上报时机不可依赖，本地锚点
      // 保证窗口链不断。now() 在响应完成后取值，天然 ≥ 上游锚点时刻，加 pad
      // 后必不早于真实重置。
      const anchorMs = this.now() + windowMsFor(provider) + ACTIVATION_ANCHOR_PAD_MS;
      this.quotaProbe?.retainActivationAnchor?.(provider.id, { resetMs: anchorMs });
      return;
    }

    // 订阅级额度用完（GLM 1310 / ChatGPT usage limit）：重试到额度重置为止都
    // 会失败 → 标记本时刻已处理、不退避、不告警；额度重置后探测恢复，新窗口
    // 观测自然驱动下一次激活。
    if (quotaCap) {
      st.lastResetHandledMs = reset.resetMs;
      st.failures = 0;
      st.nextAttemptAt = 0;
      return;
    }

    // Failure: keep the moment unhandled so backoff-gated retries continue
    // (up to giveUpAfterSec), exponential backoff, single SMTP notify per reset.
    st.failures += 1;
    const backoffMs = Math.min(
      this.cfg.backoffStartSec * 2 ** (st.failures - 1),
      this.cfg.backoffMaxSec,
    ) * 1000;
    st.nextAttemptAt = t + backoffMs;

    if (this.notifyCfg?.smtpUrl && !st.notifiedForReset) {
      st.notifiedForReset = reset.resetMs;
      const url = resolveRef(this.notifyCfg.smtpUrl);
      if (url) {
        sendMail(
          { smtpUrl: url, from: this.notifyCfg.from, to: this.notifyCfg.to },
          {
            subject: `[model-gateway] 5h window activation failed (${provider.type}:${provider.id})`,
            text: `Activation request failed after 5h window reset ${reset.resetsAt}.\n\nprovider: ${provider.id}\nmodel: ${model}\nerror: ${outcome.error}\nattempt: ${st.attempts}\n\n-- model-gateway window-activator`,
          },
        ).catch(() => {});
      }
    }
  }

  /** GLM：直接 chat-completions 形态打 provider.baseUrl（Bearer apiKey）。 */
  async #activateViaGlm(provider, model) {
    const apiKey = resolveRef(provider.apiKeyRef);
    if (!apiKey) {
      return { ok: false, error: 'missing API key (apiKeyRef unresolved)' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutSec * 1000);
    const startedAt = Date.now();
    try {
      const resp = await this.fetchFn(provider.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: this.cfg.prompt }],
          max_tokens: this.cfg.maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (resp.ok) {
        return { ok: true, status: resp.status, durationMs: Date.now() - startedAt };
      }
      const text = await resp.text().catch(() => '');
      return {
        ok: false,
        status: resp.status,
        error: `HTTP ${resp.status}: ${text.slice(0, 300)}`,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message ?? String(e)) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** codex：经 registry 运行时走 OAuth（chatCompletions 自动转 SSE 上行 + 聚合，
   *  originator 指纹与正常代理流量一致）。CodexProviderError 携带上游 status。 */
  async #activateViaCodex(provider, model) {
    const entry = this.registry?.get?.(provider.id);
    const runtime = entry?.runtime ?? entry;
    if (!runtime || typeof runtime.chatCompletions !== 'function') {
      return { ok: false, error: 'codex provider not available (registry miss or credentials not loaded)' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutSec * 1000);
    const startedAt = Date.now();
    try {
      await runtime.chatCompletions(
        {
          model,
          messages: [{ role: 'user', content: this.cfg.prompt }],
          max_tokens: this.cfg.maxTokens,
          stream: false,
        },
        { signal: controller.signal },
      );
      return { ok: true, status: 200, durationMs: Date.now() - startedAt };
    } catch (e) {
      const timeout = e?.name === 'AbortError';
      return {
        ok: false,
        status: e?.status ?? null,
        error: timeout
          ? 'timeout'
          : `${e?.name ?? 'error'}: ${e?.message ?? String(e)}`.slice(0, 300),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
