/**
 * GPT/Codex OAuth — token 获取与刷新（ChatGPT 账号 OAuth 流）。
 *
 * 流程结论（与 codex CLI / pi 0.85 openai-codex provider 同源）：
 *  - 授权端点   POST https://auth.openai.com/oauth/authorize（PKCE S256，浏览器流）
 *  - Token 端点 POST https://auth.openai.com/oauth/token
 *      - 换码: grant_type=authorization_code + client_id + code + code_verifier + redirect_uri
 *      - 刷新: grant_type=refresh_token + refresh_token + client_id
 *      - client_id: app_EMoamEEZ73f0CkXaXp7hrann（codex CLI 公共客户端 id，pi 同款）
 *  - 刷新响应字段: access_token / refresh_token / id_token / expires_in
 *    （每次刷新 refresh_token 轮换，必须持久化新值）
 *  - accountId 从 access_token JWT 的 "https://api.openai.com/auth".chatgpt_account_id 取
 *
 * 本模块零依赖（node:test + 内置 fetch），所有网络调用可注入 fetch 实现以便测试 mock。
 */

import { setTimeout as sleep } from 'node:timers/promises';

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const AUTH_BASE_URL = 'https://auth.openai.com';
export const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
export const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
export const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
export const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
export const SCOPE = 'openid profile email offline_access';
/** access_token JWT 中 accountId 所在的 claim 路径 */
export const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
export const DEVICE_CODE_TIMEOUT_SECONDS = 900;

/**
 * codex CLI auth.json 形态（.codex/auth.json）：
 * { OPENAI_API_KEY: null | string,
 *   tokens: { id_token, access_token, refresh_token, account_id } }
 * pi auth.json 形态：{ type:'oauth', access, refresh, expires(ms), accountId }
 * 本模块内部统一用后者；转换见 convert.js。
 */

export class OAuthError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'OAuthError';
    if (status !== undefined) this.status = status;
  }
}

/** 解码 JWT payload（不验签 —— accountId 提取用途）。非法返回 null。 */
export function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** 从 access_token 提取 chatgpt_account_id；无则 null。 */
export function extractAccountId(accessToken) {
  const claim = decodeJwt(accessToken)?.[JWT_CLAIM_PATH];
  const accountId = claim?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** PKCE verifier/challenge（S256）。随机源与 crypto 可注入以便测试。 */
export async function generatePkce({ randomBytes } = {}) {
  const rand = randomBytes ?? (await import('node:crypto')).randomBytes;
  const verifier = base64url(rand(32));
  const { createHash } = await import('node:crypto');
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** 校验 token 端点响应形态，转换为内部凭据结构。 */
export function tokenResponseToCredentials(json, { now = Date.now(), accessTokens } = {}) {
  const nowMs = typeof now === 'function' ? now() : now; // 兼容注入 clock 函数或直接数值
  if (!json?.access_token || typeof json.access_token !== 'string') {
    throw new OAuthError(`token endpoint response missing access_token: ${safeJson(json)}`);
  }
  if (!json.refresh_token || typeof json.refresh_token !== 'string') {
    throw new OAuthError(`token endpoint response missing refresh_token: ${safeJson(json)}`);
  }
  if (typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in)) {
    throw new OAuthError(`token endpoint response missing expires_in: ${safeJson(json)}`);
  }
  // 网关形态宽限处理：某些响应只回 id_token 不回 access_token 时，允许调用方
  // 通过 accessTokens.idTokenAlias 显式指定别名字段；默认仍严格要求 access_token。
  const credentials = {
    type: 'oauth',
    access: json.access_token,
    refresh: json.refresh_token,
    idToken: typeof json.id_token === 'string' ? json.id_token : null,
    expires: nowMs + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
  void accessTokens; // 预留：别名字段扩展点
  return credentials;
}

function safeJson(json) {
  try {
    return JSON.stringify(json).slice(0, 300);
  } catch {
    return String(json);
  }
}

/**
 * 用 refresh_token 换新 access_token。
 * 刷新失败（网络错误 / 4xx）抛 OAuthError（含 status）；不重试 —— 重试策略由调用方（TokenManager）负责。
 */
export async function refreshAccessToken(refreshToken, { fetchImpl = fetch, signal, now } = {}) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal,
    });
  } catch (err) {
    throw new OAuthError(`token refresh request failed: ${err?.message ?? err}`, {});
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OAuthError(
      `token refresh failed (${response.status}): ${text.slice(0, 300) || response.statusText}`,
      { status: response.status },
    );
  }
  const json = await response.json().catch(() => null);
  return tokenResponseToCredentials(json, { now });
}

/**
 * Device-code 流第一步：申请 user_code。
 * 返回 { deviceAuthId, userCode, intervalSeconds, verificationUri }。
 */
export async function startDeviceAuth({ fetchImpl = fetch, signal, clientId = CLIENT_ID } = {}) {
  const response = await fetchImpl(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OAuthError(
      `device code request failed (${response.status}): ${text.slice(0, 300)}`,
      { status: response.status },
    );
  }
  const json = await response.json();
  const intervalSeconds = typeof json?.interval === 'string' ? Number(json.interval.trim()) : json?.interval;
  if (!json?.device_auth_id || !json.user_code || typeof intervalSeconds !== 'number') {
    throw new OAuthError(`invalid device code response: ${safeJson(json)}`);
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds,
    verificationUri: DEVICE_VERIFICATION_URI,
  };
}

/**
 * Device-code 流轮询（单轮）。返回:
 *  { status: 'pending' } | { status: 'slow_down' }
 *  | { status: 'complete', authorizationCode, codeVerifier }
 *  | { status: 'failed', message }
 */
export async function pollDeviceAuth(device, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    signal,
  });
  if (response.ok) {
    const json = await response.json();
    if (!json?.authorization_code || !json.code_verifier) {
      return { status: 'failed', message: `invalid device token response: ${safeJson(json)}` };
    }
    return { status: 'complete', authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
  }
  if (response.status === 403 || response.status === 404) return { status: 'pending' };
  const text = await response.text().catch(() => '');
  let errorCode;
  try {
    const err = JSON.parse(text)?.error;
    errorCode = typeof err === 'object' ? err?.code : err;
  } catch {}
  if (errorCode === 'deviceauth_authorization_pending') return { status: 'pending' };
  if (errorCode === 'slow_down') return { status: 'slow_down' };
  return { status: 'failed', message: `device auth failed (${response.status}): ${text.slice(0, 300)}` };
}

/**
 * Device-code 流完整循环（带 slow_down 退避与超时）。
 * onEvent 可选回调接收进度事件（user_code 显示 / 等待）。
 * 完成后用 authorization_code + code_verifier 换 token。
 */
export async function loginWithDeviceCode({
  fetchImpl = fetch,
  signal,
  onEvent,
  intervalSeconds: initialInterval = 5,
  expiresInSeconds = DEVICE_CODE_TIMEOUT_SECONDS,
  sleepImpl = sleep,
  now = Date.now,
} = {}) {
  const device = await startDeviceAuth({ fetchImpl, signal });
  onEvent?.({
    type: 'device_code',
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds,
  });
  const deadline = now() + expiresInSeconds * 1000;
  let intervalMs = Math.max(1000, Math.floor(device.intervalSeconds * 1000 || initialInterval * 1000));
  for (;;) {
    if (signal?.aborted) throw new OAuthError('login cancelled');
    const result = await pollDeviceAuth(device, { fetchImpl, signal });
    if (result.status === 'complete') {
      return exchangeAuthorizationCode(result.authorizationCode, result.codeVerifier, DEVICE_REDIRECT_URI, {
        fetchImpl,
        signal,
        now: now(),
      });
    }
    if (result.status === 'failed') throw new OAuthError(result.message);
    if (result.status === 'slow_down') intervalMs = Math.max(intervalMs + 5000, 1000);
    const remaining = deadline - now();
    if (remaining <= 0) throw new OAuthError('device flow timed out');
    await sleepImpl(Math.min(intervalMs, remaining), undefined, { signal }).catch(() => {
      throw new OAuthError('login cancelled');
    });
  }
}

/** authorization_code + PKCE verifier 换 token（device 流收尾）。 */
export async function exchangeAuthorizationCode(code, verifier, redirectUri, {
  fetchImpl = fetch,
  signal,
  now = Date.now(),
} = {}) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new OAuthError(
      `token exchange failed (${response.status}): ${text.slice(0, 300)}`,
      { status: response.status },
    );
  }
  const json = await response.json().catch(() => null);
  return tokenResponseToCredentials(json, { now });
}
