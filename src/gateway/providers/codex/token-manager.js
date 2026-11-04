/**
 * TokenManager — codex OAuth 凭据生命周期管理。
 *
 * 职责：
 *  - 启动从 secrets 目录加载 JSON 凭据（600 权限）
 *  - getAccessToken()：过期（含提前量）自动刷新；单飞（并发请求只触发一次刷新）
 *  - 刷新成功原子写回 secrets 文件（chmod 600）
 *  - 连续刷新失败达到阈值 → 标记 unhealthy（fallback 链据此跳过 codex）
 *  - 冷却期：unhealthy 后冷却窗口内不重试刷新，窗口过后允许再试（额度类临时故障可自愈）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { refreshAccessToken, OAuthError } from './oauth.js';

export const DEFAULT_EARLY_REFRESH_MS = 5 * 60 * 1000; // 过期前 5min 提前刷新
export const DEFAULT_MAX_REFRESH_FAILURES = 2;
export const DEFAULT_UNHEALTHY_COOLDOWN_MS = 10 * 60 * 1000; // 10min 后允许重试

export class TokenManager {
  constructor({
    secretsDir,
    accountFile = 'codex.json',
    earlyRefreshMs = DEFAULT_EARLY_REFRESH_MS,
    maxRefreshFailures = DEFAULT_MAX_REFRESH_FAILURES,
    unhealthyCooldownMs = DEFAULT_UNHEALTHY_COOLDOWN_MS,
    fetchImpl = fetch,
    now = Date.now,
  } = {}) {
    if (!secretsDir) throw new TypeError('TokenManager requires secretsDir');
    this.filePath = path.join(secretsDir, accountFile);
    this.earlyRefreshMs = earlyRefreshMs;
    this.maxRefreshFailures = maxRefreshFailures;
    this.unhealthyCooldownMs = unhealthyCooldownMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.credentials = null;
    this.unhealthy = false;
    this.unhealthyReason = null;
    this.unhealthySince = null;
    this.refreshFailures = 0;
    this.lastRefreshAttempt = null;
    this.lastError = null;
    this._inflight = null; // 单飞 promise
  }

  /** 启动加载；文件不存在返回 false（provider 不可用但不算 fatal）。 */
  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.credentials = null;
        this.unhealthy = true;
        this.unhealthyReason = 'credentials file not found';
        return false;
      }
      throw err;
    }
    const json = JSON.parse(raw);
    this.credentials = normalizeCredentials(json);
    this.unhealthy = false;
    this.unhealthyReason = null;
    this.refreshFailures = 0;
    return true;
  }

  isExpired() {
    if (!this.credentials) return true;
    return this.now() >= this.credentials.expires - this.earlyRefreshMs;
  }

  isHealthy() {
    if (this.unhealthy) {
      // 冷却期过后允许探测性恢复（下次 getAccessToken 会重试刷新）
      if (this.unhealthySince !== null && this.now() - this.unhealthySince >= this.unhealthyCooldownMs) {
        return true; // “probation”：仍可尝试，但失败即再度 unhealthy
      }
      return false;
    }
    return this.credentials !== null;
  }

  getStatus() {
    return {
      healthy: this.isHealthy(),
      reason: this.unhealthy ? this.unhealthyReason : null,
      expires: this.credentials?.expires ?? null,
      accountId: this.credentials?.accountId ?? null,
      refreshFailures: this.refreshFailures,
    };
  }

  /**
   * 取有效 access_token；过期则刷新（单飞）。刷新失败抛 OAuthError 并推进
   * 失败计数 → 达阈值标记 unhealthy（供 fallback 链跳过）。
   */
  async getAccessToken() {
    if (!this.credentials) throw new OAuthError('no credentials loaded');
    if (!this.isExpired()) return this.credentials.access;
    if (this._inflight) return this._inflight;
    this._inflight = this._refresh().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _refresh() {
    const nowMs = this.now();
    this.lastRefreshAttempt = nowMs;
    try {
      const fresh = await refreshAccessToken(this.credentials.refresh, {
        fetchImpl: this.fetchImpl,
        now: nowMs,
      });
      // 刷新响应可能不带 accountId（JWT 缺 claim 时 extractAccountId 返回 null）——继承旧值
      if (!fresh.accountId && this.credentials.accountId) fresh.accountId = this.credentials.accountId;
      this.credentials = fresh;
      this.refreshFailures = 0;
      this.lastError = null;
      this.unhealthy = false;
      this.unhealthyReason = null;
      this.unhealthySince = null;
      await this._persist();
      return fresh.access;
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      this.refreshFailures += 1;
      if (this.refreshFailures >= this.maxRefreshFailures || isPermanentOAuthFailure(err)) {
        this.unhealthy = true;
        this.unhealthyReason = `refresh failed ${this.refreshFailures}x: ${this.lastError}`;
        this.unhealthySince = this.now();
      }
      throw err instanceof OAuthError ? err : new OAuthError(this.lastError);
    }
  }

  /** 原子写回（tmp + rename），确保 600 权限。 */
  async _persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.credentials, null, 2) + '\n', { mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => {}); // fs 写入模式受 umask 影响，显式 chmod 兜底
    await fs.rename(tmp, this.filePath);
  }
}

/** invalid_grant 等永久失败：无需重试，立即 unhealthy。 */
export function isPermanentOAuthFailure(err) {
  return typeof err?.status === 'number' && err.status >= 400 && err.status < 500;
}

/**
 * 凭据形态归一化。接受：
 *  - 网关原生: { type:'oauth', access, refresh, expires, accountId }
 *  - codex CLI auth.json tokens 块: { id_token, access_token, refresh_token, account_id }
 */
export function normalizeCredentials(json) {
  if (!json || typeof json !== 'object') throw new TypeError('invalid credentials file');
  // codex CLI auth.json 顶层形态: { OPENAI_API_KEY, tokens: {...} }
  if (json.tokens && typeof json.tokens === 'object') json = json.tokens;
  // codex CLI tokens 形态
  if (json.access_token && json.refresh_token) {
    return {
      type: 'oauth',
      access: json.access_token,
      refresh: json.refresh_token,
      idToken: json.id_token ?? null,
      expires: typeof json.expires === 'number' ? json.expires : Date.now(), // CLI 形态无 expires：视为已过期，首个请求触发刷新
      accountId: json.account_id ?? null,
    };
  }
  // 网关原生形态
  if (json.access && json.refresh) {
    return {
      type: 'oauth',
      access: json.access,
      refresh: json.refresh,
      idToken: json.idToken ?? null,
      expires: typeof json.expires === 'number' ? json.expires : 0,
      accountId: json.accountId ?? null,
    };
  }
  throw new TypeError(
    'invalid credentials: expected { access, refresh, expires, accountId } or codex tokens { access_token, refresh_token, account_id }',
  );
}
