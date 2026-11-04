// quota-probe.js — periodic official-quota probe (OLP pattern).
// Per provider (type: glm → 5h/weekly usage monitor; DeepSeek openai-compat
// → prepaid balance /user/balance):
//   - probe every intervalSec (default 300s)
//   - success result cached cacheTtlSec (default 300s) — force refresh bypasses cache
//   - failure → exponential backoff backoffStartSec → backoffMaxSec (60 → 3600)
//   - on failure the last successful snapshot stays visible with stale: true
// Exposes snapshot() for GET /internal/quota and nextReset info for the
// window activator. Timerless by default: tick() is idempotent and safe to
// call from a single setInterval loop owned by the caller.

import { probeGlmQuota, glmQuotaBase } from '../glm-quota.js';
import { probeDeepseekBalance, deepseekBalanceBase, isDeepseekProvider } from '../deepseek-quota.js';
import { probeCodexUsage, codexQuotaBase } from '../codex-quota.js';
import { probeClaudeUsage, CLAUDE_API_BASE } from '../claude-quota.js';
import { probeAliyunBalance, BSS_API_BASE } from '../aliyun-bss.js';
import { resolveRef } from '../../config.js';

const DEFAULTS = {
  enabled: true,
  intervalSec: 300,
  cacheTtlSec: 300,
  backoffStartSec: 60,
  backoffMaxSec: 3600,
  timeoutSec: 15,
};

export class QuotaProbe {
  /**
   * @param {object} opts
   * @param {Array} opts.providers - catalog providers (type:'glm' + DeepSeek
   *   openai-compat providers with api.deepseek.com baseUrl are probed)
   * @param {object} opts.jobs - config.jobs.probe
   * @param {object} opts.events - EventLog
   * @param {object} [opts.registry] - codex provider registry (tokenManager access)
   * @param {object} [opts.embeddings] - config.embeddings（可选）：配齐
   *   balanceAccessKeyIdRef/balanceAccessKeySecretRef 时合成 dashscope 余额探测条目
   * @param {Function} [opts.fetch] - injectable fetch (tests)
   * @param {{readFileSync: Function}} [opts.fs] - injectable fs (claude credentials, tests)
   * @param {() => number} [opts.now] - injectable clock (tests)
   */
  constructor({ providers, jobs = {}, events, registry, embeddings, fetch: fetchFn, fs, now } = {}) {
    this.cfg = { ...DEFAULTS, ...(jobs?.probe ?? jobs ?? {}) };
    this.providers = providers.filter((p) => p.type === 'glm' || isDeepseekProvider(p) || p.type === 'codex' || p.type === 'claude');
    // 向量展示位余额探测（dashscope）：阿里云 BSS 只读 AK 配齐才入列 —— 两 ref
    // 是可选配置，未配/解析失败时展示位维持静态声明（无余额区块）。凭据在构造
    // 时解析（与 glm/deepseek 的 apiKeyRef 现取不同：BSS AK 不随轮换热变）。
    this.embeddings = null;
    if (embeddings?.balanceAccessKeyIdRef && embeddings?.balanceAccessKeySecretRef) {
      const akId = resolveRef(embeddings.balanceAccessKeyIdRef);
      const akSecret = resolveRef(embeddings.balanceAccessKeySecretRef);
      if (akId && akSecret) {
        this.embeddings = { accessKeyId: akId, accessKeySecret: akSecret };
        this.providers = [...this.providers, { id: 'dashscope', type: 'dashscope', displayName: '阿里云百炼' }];
      }
    }
    this.events = events;
    this.registry = registry ?? null;
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.fs = fs ?? null;
    this.now = now ?? Date.now;
    // providerId -> state
    this.state = new Map();
    for (const p of this.providers) {
      const deepseek = isDeepseekProvider(p);
      const kind = p.type === 'codex' ? 'codex' : p.type === 'claude' ? 'claude' : p.type === 'dashscope' ? 'aliyun' : (deepseek ? 'deepseek' : 'glm');
      this.state.set(p.id, {
        providerId: p.id,
        kind,
        quotaBase: kind === 'codex'
          ? codexQuotaBase()
          : kind === 'claude'
            ? CLAUDE_API_BASE
            : kind === 'aliyun'
              ? BSS_API_BASE
              : kind === 'deepseek'
                ? deepseekBalanceBase(p.baseUrl)
                : glmQuotaBase(p.baseUrl),
        snapshot: null, // last successful result (may be stale)
        lastFiveHourReset: null, // retained across GLM snapshots with no nextResetTime
        localAnchor: null, // activation-derived anchor (now+5h); bridges GLM reporting lag/idle windows
        fetchedAt: null, // ms, success time
        expiresAt: null, // ms, cache expiry
        nextAttemptAt: 0, // ms, earliest next probe (backoff gate)
        failures: 0, // consecutive failure count
        lastError: null,
        lastErrorAt: null,
        inFlight: null, // promise dedupe
      });
    }
    this.timer = null;
  }

  /** Start the periodic loop (no-op when disabled or no glm providers). */
  start() {
    if (!this.cfg.enabled || this.providers.length === 0 || this.timer) return this;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, Math.min(this.cfg.intervalSec, 60) * 1000);
    this.timer.unref?.();
    // Kick off immediately in the background.
    this.tick().catch(() => {});
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /**
   * Advance the probe cycle. For each provider: skip when in-flight, cached
   * (not expired), or backing off. Calls forceRefresh for due providers.
   */
  async tick({ force = false } = {}) {
    const t = this.now();
    const jobs = [];
    for (const [id, st] of this.state) {
      if (st.inFlight) continue;
      if (!force) {
        if (st.snapshot && st.expiresAt !== null && st.expiresAt > t) continue; // cached
        if (st.nextAttemptAt > t) continue; // backoff / pacing
      }
      jobs.push(this.refresh(id, { force }));
    }
    await Promise.allSettled(jobs);
    return this.snapshot();
  }

  /**
   * Probe one provider now. Updates state: success → cache + reset failures;
   * failure → backoff schedule + stale snapshot retained, failure recorded.
   */
  async refresh(providerId, { force = false } = {}) {
    const st = this.state.get(providerId);
    if (!st) throw new Error(`unknown provider ${providerId}`);
    if (st.inFlight) return st.inFlight;

    const t0 = this.now();
    if (!force && st.snapshot && st.expiresAt > t0) return st.snapshot; // cache hit
    if (!force && st.nextAttemptAt > t0) return st.snapshot ?? { stale: true, providerId };

    st.inFlight = (async () => {
      const provider = this.providers.find((p) => p.id === providerId);
      let apiKey = null;
      if (st.kind !== 'codex' && st.kind !== 'claude' && st.kind !== 'aliyun') {
        apiKey = resolveRef(provider.apiKeyRef);
        if (!apiKey) {
          this.#recordFailure(st, 'missing API key (apiKeyRef unresolved)');
          return null;
        }
      }
      let result;
      try {
        if (st.kind === 'aliyun') {
          // 阿里云百炼余额（BSS QueryAccountBalance）：凭据在构造时已解析
          result = await probeAliyunBalance({
            ...this.embeddings,
            fetch: this.fetchFn,
            timeoutMs: this.cfg.timeoutSec * 1000,
          });
        } else if (st.kind === 'deepseek') {
          result = await probeDeepseekBalance({
            baseUrl: provider.baseUrl,
            apiKey,
            fetch: this.fetchFn,
            timeoutMs: this.cfg.timeoutSec * 1000,
          });
        } else if (st.kind === 'codex') {
          const codex = this.registry?.get?.(provider.id);
          const tm = codex?.runtime ?? codex; // registry entry or its runtime
          const tokenManager = tm?.tokenManager ?? (typeof tm?.getAccessToken === 'function' ? tm : null);
          if (!tokenManager) {
            this.#recordFailure(st, 'codex credentials not loaded (registry miss)');
            return null;
          }
          result = await probeCodexUsage({
            getAccessToken: () => tokenManager.getAccessToken(),
            accountId: tokenManager.credentials?.accountId ?? null,
            baseUrl: provider.baseUrl,
            fetch: this.fetchFn,
            timeoutMs: this.cfg.timeoutSec * 1000,
          });
          if (result.ok && result.plan) result.level = result.plan;
        } else if (st.kind === 'claude') {
          // Claude 订阅：每次现读凭据文件取 token（CLI 轮换后立即生效；挂载只读）；
          // probeClaudeUsage 内部预检 expiresAt 已过 → 不发请求（止血 401 风暴）
          result = await probeClaudeUsage({
            credentialFile: provider.credentialFile,
            fetch: this.fetchFn,
            timeoutMs: this.cfg.timeoutSec * 1000,
            now: this.now,
            ...(this.fs ? { fs: this.fs } : {}),
          });
        } else {
          result = await probeGlmQuota({
            baseUrl: provider.baseUrl,
            apiKey,
            fetch: this.fetchFn,
            timeoutMs: this.cfg.timeoutSec * 1000,
          });
        }
      } catch (e) {
        this.#recordFailure(st, e?.message ?? String(e));
        return null;
      }
      if (!result.ok) {
        this.#recordFailure(st, result.error ?? 'probe failed');
        return null;
      }
      this.#recordSuccess(st, result);
      return result;
    })();

    try {
      return await st.inFlight;
    } finally {
      st.inFlight = null;
    }
  }

  #recordSuccess(st, result) {
    const t = this.now();
    const fiveHour = result.tiers?.fiveHour;
    // GLM 在窗口清空后不再上报 nextResetTime；codex/claude 同样可能在激活窗口内
    // 上报无 reset_at 的窗口 —— 保留最近观测，激活器在重置时刻后仍可激活。
    if ((st.kind === 'glm' || st.kind === 'codex' || st.kind === 'claude') && Number.isFinite(fiveHour?.resetMs) &&
        fiveHour.resetMs > (st.lastFiveHourReset?.resetMs ?? -Infinity)) {
      st.lastFiveHourReset = { resetMs: fiveHour.resetMs, resetsAt: fiveHour.resetsAt };
    }
    st.snapshot = {
      providerId: st.providerId,
      quotaBase: st.quotaBase,
      ok: true,
      stale: false,
      level: result.level ?? null,
      tiers: result.tiers ?? null,
      balance: result.balance ?? null,
      isAvailable: typeof result.isAvailable === 'boolean' ? result.isAvailable : null,
      fetchedAt: new Date(t).toISOString(),
      fetchedAtMs: t,
    };
    st.fetchedAt = t;
    st.expiresAt = t + this.cfg.cacheTtlSec * 1000;
    st.nextAttemptAt = t + this.cfg.intervalSec * 1000;
    st.failures = 0;
    st.lastError = null;
    st.lastErrorAt = null;
  }

  #recordFailure(st, message) {
    const t = this.now();
    st.failures += 1;
    st.lastError = message;
    st.lastErrorAt = new Date(t).toISOString();
    // Exponential backoff: start * 2^(failures-1), capped.
    const backoffMs = Math.min(
      this.cfg.backoffStartSec * 2 ** (st.failures - 1),
      this.cfg.backoffMaxSec,
    ) * 1000;
    st.nextAttemptAt = t + backoffMs;
    if (st.snapshot) st.snapshot.stale = true; // keep last good data visible
    this.events?.record('probe_error', { providerId: st.providerId, error: message, failures: st.failures });
  }

  /**
   * Full snapshot for /internal/quota: live values + stale markers + errors.
   */
  snapshot() {
    const t = this.now();
    const out = {};
    for (const [id, st] of this.state) {
      const isStale = st.snapshot ? st.snapshot.stale : false;
      out[id] = {
        providerId: id,
        quotaBase: st.quotaBase,
        ...(st.snapshot
          ? {
              ok: true,
              stale: isStale,
              level: st.snapshot.level,
              tiers: this.#displayTiers(st, t),
              balance: st.snapshot.balance,
              isAvailable: st.snapshot.isAvailable,
              fetchedAt: st.snapshot.fetchedAt,
            }
          : { ok: false, stale: false, tiers: null, balance: null }),
        lastError: st.lastError,
        lastErrorAt: st.lastErrorAt,
        nextAttemptAt: st.nextAttemptAt > 0 ? new Date(st.nextAttemptAt).toISOString() : null,
        backingOff: st.failures > 0 && st.nextAttemptAt > t,
      };
    }
    return out;
  }

  /** Last GLM/codex 5h reset observed, including when the newest snapshot cleared it. */
  lastFiveHourReset(providerId) {
    return this.state.get(providerId)?.lastFiveHourReset ?? null;
  }

  /**
   * RAW external 5h anchor for the window activator: the retained external
   * observation, else the raw snapshot tier. Deliberately ignores the
   * display fill (#displayTiers) and the local activation anchor so the
   * activator's external/local attribution never gets poisoned.
   */
  fiveHourObservation(providerId) {
    const st = this.state.get(providerId);
    if (!st) return null;
    if (st.lastFiveHourReset) return st.lastFiveHourReset;
    const tier = st.snapshot?.tiers?.fiveHour;
    if (Number.isFinite(tier?.resetMs)) return { resetMs: tier.resetMs, resetsAt: tier.resetsAt };
    return null;
  }

  /**
   * Retain/raise the activation-derived anchor (monotonic). A successful
   * window activation means GLM anchored the fresh 5h window at that request,
   * but its monitor API lags ~5-10 min reporting it (and reports nothing
   * while usage stays ~0) — so we track the derived anchor locally. Kept in
   * a SEPARATE slot from lastFiveHourReset so GLM's authoritative value is
   * never blocked by (nor can erase) our estimate; consumers merge via
   * bestFiveHourReset().
   */
  retainActivationAnchor(providerId, { resetMs, resetsAt } = {}) {
    const st = this.state.get(providerId);
    if (!st || !Number.isFinite(resetMs)) return;
    if (resetMs > (st.localAnchor?.resetMs ?? -Infinity)) {
      st.localAnchor = { resetMs, resetsAt: resetsAt ?? new Date(resetMs).toISOString() };
    }
  }

  /** Best future 5h anchor for a GLM provider: larger of external observation vs local estimate. */
  bestFiveHourReset(providerId) {
    const st = this.state.get(providerId);
    if (!st) return null;
    const ext = st.lastFiveHourReset;
    const local = st.localAnchor;
    if (!ext && !local) return null;
    if (!local) return { ...ext, local: false };
    if (!ext || local.resetMs > ext.resetMs) return { ...local, local: true };
    return { ...ext, local: false };
  }

  /**
   * 订阅级额度（周/月上限）是否已用满。用满 → 返回
   * { resetMs, resetsAt, usedPercent, tier }（重置时刻仍在未来），否则 null。
   * 判据：weekly 档 usedPercent>=100 且未到重置；codex 免费档的
   * primary_window 本身就是 30 天总额度（windowSeconds>=86400），同样视为
   * 订阅上限。5h 档用满不算——那正是窗口激活要解决的问题。stale 快照也采信：
   * resetMs>now 保证「重置已过」必然解除抑制，探测恢复后自然重新评估。
   * 消费方：window-activator（额度用完 → 跳过激活、不告警）。
   */
  subscriptionQuotaCap(providerId, now = this.now()) {
    const st = this.state.get(providerId);
    const tiers = st?.snapshot?.ok ? st.snapshot.tiers : null;
    if (!tiers) return null;
    const weekly = tiers.weekly;
    if (typeof weekly?.usedPercent === 'number' && weekly.usedPercent >= 100 &&
        typeof weekly.resetMs === 'number' && weekly.resetMs > now) {
      return { resetMs: weekly.resetMs, resetsAt: weekly.resetsAt, usedPercent: weekly.usedPercent, tier: 'weekly' };
    }
    const five = tiers.fiveHour;
    if (st.kind === 'codex' && typeof five?.windowSeconds === 'number' && five.windowSeconds >= 86400 &&
        typeof five.usedPercent === 'number' && five.usedPercent >= 100 &&
        typeof five.resetMs === 'number' && five.resetMs > now) {
      return { resetMs: five.resetMs, resetsAt: five.resetsAt, usedPercent: five.usedPercent, tier: 'primary' };
    }
    return null;
  }

  /** GLM/codex/claude 记账延迟空窗：tier 无 resetMs 时用最佳锚点补展示（标记 estimatedReset）。 */
  #displayTiers(st, t) {
    const tiers = st.snapshot?.tiers;
    if ((st.kind !== 'glm' && st.kind !== 'codex' && st.kind !== 'claude') || !tiers?.fiveHour) return tiers;
    if (Number.isFinite(tiers.fiveHour.resetMs)) return tiers;
    const best = this.bestFiveHourReset(st.providerId);
    if (!best || best.resetMs <= t) return tiers;
    return { ...tiers, fiveHour: { ...tiers.fiveHour, resetMs: best.resetMs, resetsAt: best.resetsAt, estimatedReset: true } };
  }

  /**
   * Next pending 5h-window reset among GLM providers (for the activator).
   * Returns {providerId, resetMs, resetsAt} of the earliest future reset, or null.
   */
  nextFiveHourReset() {
    const t = this.now();
    let best = null;
    for (const [, st] of this.state) {
      const resetMs = st.snapshot?.tiers?.fiveHour?.resetMs;
      if (typeof resetMs === 'number' && resetMs > t) {
        if (!best || resetMs < best.resetMs) {
          best = { providerId: st.providerId, resetMs, resetsAt: new Date(resetMs).toISOString() };
        }
      }
    }
    return best;
  }
}
