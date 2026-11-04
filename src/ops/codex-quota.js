// codex-quota.js — ChatGPT Codex usage probe.
// Aligned with work-dashboard queryCodex (cc-switch v3.20.3 contract):
//   GET https://chatgpt.com/backend-api/wham/usage
//     Authorization: Bearer <access_token>
//     User-Agent: codex-cli, Accept: application/json
//     ChatGPT-Account-Id: <account_id>   (note: capital-case header)
// → rate_limit.primary_window / secondary_window
//     { used_percent, limit_window_seconds, reset_at (epoch SECONDS) }
// reset_at is seconds here (GLM is ms) — normalized to ms on ingest.

const WHAM_USAGE_PATH = '/backend-api/wham/usage';
const WHAM_BASE = 'https://chatgpt.com';

/** 用量监控页基址（quota-probe 快照的 quotaBase 用）。 */
export const codexQuotaBase = () => WHAM_BASE;

function windowLabel(seconds) {
  if (seconds === 18000) return '5 小时窗口';
  if (seconds === 604800) return '本周额度';
  if (seconds === 2592000) return '30 天额度';
  if (seconds && seconds % 86400 === 0) return `${seconds / 86400} 天额度`;
  if (seconds) return `${Math.round(seconds / 3600)} 小时窗口`;
  return '用量窗口';
}

/**
 * Parse the wham/usage body (pure function — unit tested).
 * Returns { ok, plan?, tiers: { fiveHour?, weekly? }, error? } —
 * tiers use the GLM shape (usedPercent + resetsAt ISO) so downstream
 * rendering is shared. reset_at seconds → resetMs milliseconds.
 */
export function parseCodexUsageBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, tiers: {}, error: 'response is not an object' };
  const rl = body.rate_limit;
  if (!rl || typeof rl !== 'object') return { ok: false, tiers: {}, error: "missing 'rate_limit' field" };
  const tier = (w) => {
    if (!w || typeof w !== 'object') return null;
    const pct = typeof w.used_percent === 'number' ? w.used_percent : null;
    if (pct === null) return null;
    const resetMs = typeof w.reset_at === 'number' ? w.reset_at * 1000 : null;
    return {
      usedPercent: pct,
      resetsAt: resetMs !== null && resetMs > 0 ? new Date(resetMs).toISOString() : null,
      resetMs,
      windowSeconds: typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : null,
      label: windowLabel(w.limit_window_seconds),
    };
  };
  const fiveHour = rl.primary_window ? tier(rl.primary_window) : null;
  const weekly = rl.secondary_window ? tier(rl.secondary_window) : null;
  if (!fiveHour && !weekly) return { ok: false, tiers: {}, error: 'no usage windows in response' };
  return {
    ok: true,
    plan: typeof body.plan_type === 'string' ? body.plan_type : null,
    tiers: { ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) },
  };
}

/** 瞬态网络故障（连接重置/DNS 抖动）单次快速重试——监控接口偶发 fetch failed 不上仪表盘事件。 */
export async function probeCodexUsage(opts) {
  const first = await probeCodexUsageOnce(opts);
  if (first.ok || !first.retriable) return first;
  await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1000));
  return probeCodexUsageOnce(opts);
}

/** Probe one codex provider's usage. Never throws — returns {ok:false,error}. */
export async function probeCodexUsageOnce({ getAccessToken, accountId, baseUrl, fetch: fetchFn = globalThis.fetch, timeoutMs = 15000 }) {
  const token = await getAccessToken(); // TokenManager: auto-refresh + single-flight
  const origin = (() => {
    try {
      return baseUrl ? new URL(baseUrl).origin : WHAM_BASE;
    } catch {
      return WHAM_BASE;
    }
  })();
  const url = `${origin}${WHAM_USAGE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'codex-cli',
      Accept: 'application/json',
    };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    const resp = await fetchFn(url, { headers, signal: controller.signal });
    const status = resp.status;
    if (status === 401 || status === 403) {
      return { ok: false, tiers: {}, error: `auth failed (HTTP ${status})`, status };
    }
    let body;
    try {
      body = await resp.json();
    } catch {
      return { ok: false, tiers: {}, error: `non-JSON response (HTTP ${status})`, status };
    }
    if (!resp.ok) {
      return { ok: false, tiers: {}, error: `API error (HTTP ${status})`, status };
    }
    const parsed = parseCodexUsageBody(body);
    return { ...parsed, status };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    // 非超时的网络层错误（fetch failed/ECONNRESET/DNS）值得立刻重试一次；
    // 超时交给上层退避，避免探测周期被拉长到 2×timeout。
    return { ok: false, tiers: {}, error: `network error: ${e?.message ?? e}`, retriable: !aborted };
  } finally {
    clearTimeout(timer);
  }
}
