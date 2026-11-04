// chain.js — 模型 → provider 链构建与额度/熔断感知排序（纯函数）。
// 请求路径（router）与展示聚合（ops/dashboard-data）共用同一口径。

/** Build the per-model ordered provider chain from the catalog. */
export function buildChain(catalog, model) {
  return catalog.providers.filter((p) => p.models.includes(model) ||
    (Object.hasOwn(p.fallbackModelMap ?? {}, model) && p.models.includes(p.fallbackModelMap[model])));
}

export function upstreamModel(provider, requested) {
  return Object.hasOwn(provider.fallbackModelMap ?? {}, requested)
    ? provider.fallbackModelMap[requested] : requested;
}

/** Quota-aware chain ordering: GLM/Codex providers whose 5h window is
 *  (nearly) exhausted get demoted to the tail of the chain — backup channels
 *  serve first, the exhausted provider stays as a last resort (small requests
 *  may still pass). 熔断冷却中的 provider（breaker.isDemoted）在同一 seam
 *  一并降级——仍然不移除，单 provider 链照发。Pure function; emits nothing
 *  (transition events are the caller's job). */
export function orderChainByQuota(chain, quotaSnap, { threshold = 95, breaker } = {}) {
  const exhausted = (p) => {
    if (p.type !== 'glm' && p.type !== 'codex') return false;
    const q = quotaSnap?.[p.id];
    if (!q?.ok || q.stale === true) return false;
    const pct = q?.tiers?.fiveHour?.usedPercent;
    return typeof pct === 'number' && pct >= threshold;
  };
  const demoted = (p) => exhausted(p) || (breaker?.isDemoted?.(p.id) ?? false);
  return [
    ...chain.filter((p) => !demoted(p)),
    ...chain.filter(demoted),
  ];
}

/** Track quota-exhaustion transitions and record events on change.
 *  Persistent state (Map) owned by the caller — one event per episode. */
export function recordQuotaTransitions({ providers, quotaSnap, state, events, threshold = 95 }) {
  for (const p of providers) {
    if (p.type !== 'glm' && p.type !== 'codex') continue;
    const q = quotaSnap?.[p.id];
    const pct = q?.ok && q.stale !== true ? q?.tiers?.fiveHour?.usedPercent : null;
    const isExhausted = typeof pct === 'number' && pct >= threshold;
    const prev = state.get(p.id) ?? false;
    if (isExhausted && !prev) {
      events?.record('quota_demoted', { providerId: p.id, usedPercent: pct, threshold });
    } else if (!isExhausted && prev && typeof pct === 'number') {
      events?.record('quota_restored', { providerId: p.id, usedPercent: pct });
    }
    state.set(p.id, isExhausted);
  }
}
