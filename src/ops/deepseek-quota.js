// deepseek-quota.js — DeepSeek official balance endpoint client + parser.
// Contract: GET {origin}/user/balance  (origin from provider baseUrl, api.deepseek.com)
//   Authorization: Bearer <key>
// Response: { is_available: bool,
//             balance_infos: [{ currency: "CNY", total_balance: "110.00",
//                                granted_balance: "10.00", topped_up_balance: "100.00" }] }
// Balances stay strings — the dashboard renders them verbatim (no float math).

export const DEEPSEEK_BALANCE_PATH = '/user/balance';

/** Is this an openai-compatible provider pointed at DeepSeek (probeable)? */
export function isDeepseekProvider(p) {
  return p?.type === 'openai' && typeof p.baseUrl === 'string'
    && p.baseUrl.toLowerCase().includes('api.deepseek.com');
}

/** Balance endpoint origin derived from provider baseUrl. */
export function deepseekBalanceBase(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return 'https://api.deepseek.com';
  }
}

/**
 * Parse the /user/balance response body (pure function — unit tested).
 * Returns { ok, balance?: {currency, total, granted, toppedUp}, isAvailable?, error? }.
 */
export function parseDeepseekBalanceBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'response is not an object' };
  if (!Array.isArray(body.balance_infos) || body.balance_infos.length === 0) {
    return { ok: false, error: "missing 'balance_infos' field" };
  }
  // Prefer the CNY entry; fall back to the first.
  const entry = body.balance_infos.find((b) => b?.currency === 'CNY') ?? body.balance_infos[0];
  if (!entry || typeof entry.total_balance !== 'string') {
    return { ok: false, error: "missing 'total_balance' in balance entry" };
  }
  const num = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return {
    ok: true,
    isAvailable: body.is_available === true,
    balance: {
      currency: typeof entry.currency === 'string' ? entry.currency : 'CNY',
      total: entry.total_balance,
      granted: num(entry.granted_balance),
      toppedUp: num(entry.topped_up_balance),
    },
  };
}

/** Probe one DeepSeek provider's balance. Never throws — returns {ok:false,error}. */
export async function probeDeepseekBalance({ baseUrl, apiKey, fetch: fetchFn = globalThis.fetch, timeoutMs = 15000 }) {
  const url = `${deepseekBalanceBase(baseUrl)}${DEEPSEEK_BALANCE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const status = resp.status;
    if (status === 401 || status === 403) {
      return { ok: false, error: `auth failed (HTTP ${status})`, status };
    }
    let body;
    try {
      body = await resp.json();
    } catch {
      return { ok: false, error: `non-JSON response (HTTP ${status})`, status };
    }
    if (!resp.ok) {
      return { ok: false, error: `API error (HTTP ${status})`, status };
    }
    const parsed = parseDeepseekBalanceBody(body);
    return { ...parsed, status };
  } catch (e) {
    return { ok: false, error: `network error: ${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}
