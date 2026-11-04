/**
 * ChatGPT backend 客户端 — responses API over https://chatgpt.com/backend-api/codex/responses。
 *
 * 请求头（与 codex CLI / pi openai-codex-responses provider 一致）：
 *   Authorization: Bearer <access_token>
 *   chatgpt-account-id: <account_id>
 *   originator: model-gateway
 *   Accept: text/event-stream（stream:true 时）
 *   OpenAI-Beta: responses=experimental（SSE；AIM 兼容惯例，缺失不影响）
 *
 * 网络调用全部经注入 fetchImpl（测试 mock，绝不真打 auth.openai.com / chatgpt.com）。
 */

import { OAuthError } from './oauth.js';

export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const ORIGINATOR = 'model-gateway';

/** baseUrl 归一化到 .../codex/responses（与 pi resolveCodexUrl 同规则）。 */
export function resolveCodexUrl(baseUrl) {
  const normalized = (baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL).replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

/** baseUrl 归一化到 .../codex/images/generations（codex-rs ImagesClient 同路径）。 */
export function resolveImagesUrl(baseUrl) {
  const normalized = (baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL).replace(/\/+$/, '');
  if (normalized.endsWith('/codex/images/generations')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/images/generations`;
  return `${normalized}/codex/images/generations`;
}

const UNSUPPORTED_SAMPLING_PARAMS = ['temperature', 'top_p'];

/**
 * codex CLI 的会话粘性头：backend 据此把同一会话的请求路由到同一副本，前缀缓存才能命中。
 * 网关此前重建请求头时全部丢弃，worker 实测缓存命中只有 13–36%（codex-cli 0.160 抓包核对）。
 * 只透传会话标识类头；认证、originator、beta 特性开关仍由网关决定。
 */
export const CODEX_SESSION_HEADERS = [
  'session-id', 'session_id', 'thread-id', 'conversation_id',
  'x-client-request-id', 'x-codex-window-id', 'x-codex-turn-metadata',
];

/** 从入站请求头（node IncomingHttpHeaders，键已小写）挑出会话粘性头。 */
export function pickCodexSessionHeaders(headers = {}) {
  const picked = {};
  for (const name of CODEX_SESSION_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value.length > 0) picked[name] = value;
  }
  return picked;
}

export class CodexClient {
  constructor({ tokenManager, baseUrl, fetchImpl = fetch, originator = ORIGINATOR } = {}) {
    if (!tokenManager) throw new TypeError('CodexClient requires tokenManager');
    this.tokenManager = tokenManager;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.originator = originator;
  }

  /**
   * 发起 responses 请求（body 为 OpenAI responses API 形态）。
   * 返回原始 fetch Response（流式交给上层；SSE 解析见 responses-convert.js）。
   */
  async send(body, { signal, instructions, stream, sessionHeaders } = {}) {
    const payload = { ...body };
    // ChatGPT codex backend 不收采样参数：temperature / top_p 任意值都 400 Unsupported parameter
    // （2026-10-17 实测 gpt-6.1-sol）。两个入口（chat 转换 / responses 透传）都经此处，统一剥离。
    for (const key of UNSUPPORTED_SAMPLING_PARAMS) delete payload[key];
    if (instructions !== undefined && payload.instructions === undefined) payload.instructions = instructions;
    if (stream !== undefined) payload.stream = stream;
    return this._withAuthRetry(payload, signal, resolveCodexUrl(this.baseUrl), sessionHeaders);
  }

  /**
   * 发起 images/generations 请求（codex-rs ImagesClient 同端点，订阅 OAuth 链）。
   * body: { prompt, model, quality?, size?, background?, n? }（非流式 JSON 响应）。
   */
  async sendImages(body, { signal } = {}) {
    return this._withAuthRetry({ ...body }, signal, resolveImagesUrl(this.baseUrl));
  }

  async _withAuthRetry(payload, signal, url, extraHeaders) {
    const response = await this._do(payload, signal, url, extraHeaders);
    // 401 可能是 access_token 过期但本地时钟认为未过期 —— 强制刷新一次重试
    if (response.status === 401) {
      this.tokenManager.credentials.expires = 0; // 强制下次 getAccessToken 走刷新
      const retry = await this._do(payload, signal, url, extraHeaders);
      if (retry.status === 401) {
        throw new OAuthError('codex backend rejected access token after forced refresh', { status: 401 });
      }
      return retry;
    }
    return response;
  }

  async _do(payload, signal, url, extraHeaders = {}) {
    if (!this.tokenManager.credentials) throw new OAuthError('no credentials loaded');
    const token = await this.tokenManager.getAccessToken();
    const accountId = this.tokenManager.credentials.accountId;
    if (!token) throw new OAuthError('token manager returned empty access token');
    const headers = {
      ...pickCodexSessionHeaders(extraHeaders),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      originator: this.originator,
    };
    if (accountId) headers['chatgpt-account-id'] = accountId;
    if (payload.stream) headers.Accept = 'text/event-stream';
    return this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }
}
