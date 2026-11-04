// glm-quota.js — GLM official (unofficially documented) monitor endpoint client + parser.
// Source of truth for the endpoint contract: cc-switch src-tauri/src/services/coding_plan.rs
//  - Personal: GET {quotaBase}/api/monitor/usage/quota/limit
//      Authorization: <raw key> (NO Bearer prefix), Content-Type: application/json
//  - quotaBase: baseUrl host contains bigmodel.cn → https://open.bigmodel.cn,
//    contains z.ai → https://api.z.ai (same backend, same shape)
//  - Response: {success:bool, msg?, data:{level?:string,
//      limits:[{type:"TOKENS_LIMIT", percentage:number(used %), nextResetTime:number(ms),
//               unit?:number}]}}
//      unit 3 → five-hour window; unit 6 → weekly window (do NOT anchor on `number`);
//      fallback heuristic when unit missing: entries without nextResetTime → 5h first.
//  - Team plan (not enabled in MVP): same path + "/team?type=2" with
//      bigmodel-organization / bigmodel-project headers.

export const GLM_MONITOR_PATH = '/api/monitor/usage/quota/limit';

/** Resolve the monitor host from a provider baseUrl (cc-switch zhipu_quota_base). */
export function glmQuotaBase(baseUrl) {
  const u = String(baseUrl).toLowerCase();
  if (u.includes('bigmodel.cn')) return 'https://open.bigmodel.cn';
  if (u.includes('z.ai')) return 'https://api.z.ai';
  // Unknown host: derive scheme+host from baseUrl as a last resort.
  try {
    return new URL(baseUrl).origin;
  } catch {
    return 'https://open.bigmodel.cn';
  }
}

/** Map a monitor `limits[]` entry to our tier shape, or null when not a quota entry. */
function entryToTier(item) {
  const type = String(item.type ?? '').toUpperCase();
  if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') return null;
  const percentage = typeof item.percentage === 'number' ? item.percentage : 0;
  const resetMs = typeof item.nextResetTime === 'number' ? item.nextResetTime : null;
  return {
    percentage,
    resetsAt: resetMs !== null && resetMs > 0 ? new Date(resetMs).toISOString() : null,
    resetMs,
    unit: typeof item.unit === 'number' ? item.unit : null,
  };
}

/**
 * Parse the monitor response body (pure function — unit tested against fixtures).
 * Returns { ok, level?, tiers: {fiveHour?, weekly?}, error? } — normalized shape
 * consumed by quota-probe. tier: {usedPercent, resetsAt, resetMs, raw}.
 */
export function parseGlmQuotaBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, tiers: {}, error: 'response is not an object' };
  if (body.success === false) {
    return { ok: false, tiers: {}, error: `API error: ${body.msg ?? 'unknown'}` };
  }
  const data = body.data;
  if (!data || typeof data !== 'object') return { ok: false, tiers: {}, error: "missing 'data' field" };

  let fiveHour = null;
  let weekly = null;
  const unclassified = [];
  if (Array.isArray(data.limits)) {
    for (const rawItem of data.limits) {
      const tier = entryToTier(rawItem);
      if (!tier) continue;
      if (tier.unit === 3 && !fiveHour) fiveHour = tier;
      else if (tier.unit === 6 && !weekly) weekly = tier;
      else unclassified.push(tier);
    }
  }
  // Heuristic fallback (cc-switch): 5h bucket may lack reset when idle → 5h first.
  unclassified.sort((a, b) => (a.resetMs === null ? -1 : b.resetMs === null ? 1 : a.resetMs - b.resetMs));
  for (const tier of unclassified) {
    if (!fiveHour) fiveHour = tier;
    else if (!weekly) weekly = tier;
  }

  const norm = (t) =>
    t
      ? {
          usedPercent: t.percentage,
          resetsAt: t.resetsAt,
          resetMs: t.resetMs,
        }
      : undefined;
  return {
    ok: true,
    level: typeof data.level === 'string' ? data.level : undefined,
    tiers: {
      fiveHour: norm(fiveHour),
      weekly: norm(weekly),
    },
  };
}

/**
 * Probe GLM official quota endpoint.
 * @param {{baseUrl:string, apiKey:string, fetch?:Function, timeoutMs?:number, now?:() => number}} opts
 * @returns {Promise<{ok:boolean, ...}>} parsed result (see parseGlmQuotaBody) plus meta.
 */
export async function probeGlmQuota({ baseUrl, apiKey, fetch: fetchFn = globalThis.fetch, timeoutMs = 15000 }) {
  const url = `${glmQuotaBase(baseUrl)}${GLM_MONITOR_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: 'GET',
      headers: {
        // GLM monitor endpoint: raw key, no Bearer prefix (cc-switch verified).
        Authorization: apiKey,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      signal: controller.signal,
    });
    const status = resp.status;
    if (status === 401 || status === 403) {
      return { ok: false, tiers: {}, error: `auth failed (HTTP ${status})`, authFailed: true, status };
    }
    let body;
    try {
      body = await resp.json();
    } catch {
      return { ok: false, tiers: {}, error: `non-JSON response (HTTP ${status})`, status };
    }
    if (!resp.ok) {
      const parsed = parseGlmQuotaBody(body);
      return {
        ok: false,
        tiers: {},
        error: `API error (HTTP ${status}): ${parsed.error ?? 'unknown'}`,
        status,
      };
    }
    const parsed = parseGlmQuotaBody(body);
    return { ...parsed, status };
  } catch (e) {
    return { ok: false, tiers: {}, error: `network error: ${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}
