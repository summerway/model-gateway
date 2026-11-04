/**
 * 凭据格式转换 — pi auth.json / codex CLI auth.json / 网关 secrets 三种形态互认。
 *
 * 形态参考：
 *  - pi (~/.pi/agent/auth.json): { "openai-codex": { type:'oauth', access, refresh, expires, accountId } }
 *  - codex CLI (~/.codex/auth.json): { OPENAI_API_KEY: null,
 *      tokens: { id_token, access_token, refresh_token, account_id } }
 *  - 网关 (config/secrets/codex.json): 网关原生形态（normalizeCredentials 接受全部三种）
 */

import { extractAccountId } from './oauth.js';

/** pi auth.json → 网关凭据；无 openai-codex 块或非 oauth 返回 null。 */
export function fromPiAuth(piAuthJson) {
  const entry = piAuthJson?.['openai-codex'];
  if (!entry || entry.type !== 'oauth' || !entry.access || !entry.refresh) return null;
  return {
    type: 'oauth',
    access: entry.access,
    refresh: entry.refresh,
    idToken: null,
    expires: typeof entry.expires === 'number' ? entry.expires : 0, // 0 = 视为过期，首请求触发刷新
    accountId: entry.accountId ?? extractAccountId(entry.access),
  };
}

/** codex CLI auth.json → 网关凭据；无 tokens 块返回 null。 */
export function fromCodexCliAuth(codexAuthJson) {
  const tokens = codexAuthJson?.tokens;
  if (!tokens?.access_token || !tokens.refresh_token) return null;
  return {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    idToken: tokens.id_token ?? null,
    expires: 0, // CLI 形态无过期时间：视为已过期，首个请求触发刷新拿最新 expires_in
    accountId: tokens.account_id ?? extractAccountId(tokens.access_token),
  };
}

/** 网关凭据 → codex CLI auth.json 形态（写回/导出用）。 */
export function toCodexCliAuth(credentials) {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: credentials.idToken ?? null,
      access_token: credentials.access,
      refresh_token: credentials.refresh,
      account_id: credentials.accountId ?? null,
    },
  };
}
