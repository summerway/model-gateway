/**
 * Codex provider 出口 — 网关内 GPT (ChatGPT OAuth) 模型的统一接入点。
 *
 * 模块 A 的 proxy/fallback 通过本文件消费 codex 能力，不直接 import 内部文件：
 *  - createCodexProvider({ secretsDir, models }) → provider 对象
 *      .id / .models / .healthy() / .status()
 *      .chatCompletions(body, ctx)  — /v1/chat/completions 形态入口（自动转换）
 *      .responses(body, ctx)        — /v1/responses 形态入口（透传 responses API）
 *      .images(body, ctx)           — /v1/images/generations 形态入口（GPT Image 订阅链）
 *
 * 请求失败（含刷新失败 unhealthy）抛 CodexProviderError —— fallback 引擎按错误类别
 * 决定跳到链上下一个 provider（不重试 codex 本身，TokenManager 已处理刷新重试）。
 */

import { TokenManager } from './token-manager.js';
import { CodexClient } from './client.js';
import {
  chatToResponses, responsesToChat, createSseConverter, aggregateSseToChat, aggregateSseToResponse,
} from './responses-convert.js';
import { OAuthError } from './oauth.js';

export const PROVIDER_ID = 'codex';

export class CodexProviderError extends Error {
  constructor(message, { kind, status, retryable } = {}) {
    super(message);
    this.name = 'CodexProviderError';
    this.kind = kind; // 'auth' | 'rate_limited' | 'upstream' | 'network'
    this.status = status;
    this.retryable = Boolean(retryable);
  }
}

export function createCodexProvider({
  secretsDir,
  models = [],
  baseUrl,
  originator,
  fetchImpl = fetch,
  tokenManagerOptions = {},
} = {}) {
  const tokenManager = new TokenManager({ secretsDir, fetchImpl, ...tokenManagerOptions });

  const provider = {
    id: PROVIDER_ID,
    models,
    tokenManager,
    loaded: false,

    /** 启动时调用：加载 secrets。文件缺失 → healthy()=false（fallback 跳过）。 */
    async init() {
      await tokenManager.load();
      provider.loaded = true;
    },

    healthy() {
      return tokenManager.isHealthy();
    },

    status() {
      return { id: PROVIDER_ID, ...tokenManager.getStatus() };
    },

    /**
     * /v1/responses 形态：透传 responses API（含流式 SSE 透传）。
     * 非流式：codex backend 只收 stream:true（"Stream must be set to true"），上行改流式，
     * 本地聚合成 response 对象，包成 JSON Response 交回路由（路由侧按 .ok/.json() 消费不变）。
     */
    async responses(body, { signal, sessionHeaders } = {}) {
      return runWithClient(async (client) => {
        if (body.stream) return client.send(body, { signal, stream: true, sessionHeaders });
        const upstream = await client.send(body, { signal, stream: true, sessionHeaders });
        if (!upstream.ok) return upstream;
        const resp = await aggregateSseToResponse(upstream);
        return new Response(JSON.stringify(resp), {
          status: resp.status === 'failed' ? 502 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
    },

    /** /v1/images/generations 形态：透传 codex images API（非流式 JSON）。 */
    async images(body, { signal } = {}) {
      return runWithClient(async (client) => {
        const upstream = await client.sendImages(body, { signal });
        if (!upstream.ok) {
          throw await upstreamError(upstream);
        }
        return upstream.json();
      });
    },

    /**
     * /v1/chat/completions 形态：转换 → codex responses → 转换回 chat 形态。
     * 流式请求返回 async generator（产出 chat chunk 字符串）。
     */
    async chatCompletions(body, { signal, thinkingLevelMap } = {}) {
      return runWithClient(async (client) => {
        const responsesBody = chatToResponses(body, { thinkingLevelMap });
        // ChatGPT codex backend 只接受流式（"Stream must be set to true"）：
        // 非流式请求也转 SSE 上行，本地聚合回 chat 形态。
        responsesBody.stream = true;
        const upstream = await client.send(responsesBody, { signal, stream: true });
        if (!upstream.ok) {
          throw await upstreamError(upstream);
        }
        if (body.stream) {
          return streamAsChatChunks(upstream, body.model);
        }
        // 非流式：聚合 SSE 成完整 chat 响应
        return aggregateSseToChat(upstream, body.model);
      });
    },
  };

  async function runWithClient(fn) {
    const client = new CodexClient({ tokenManager, baseUrl, ...(originator ? { originator } : {}), fetchImpl });
    try {
      return await fn(client);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  function toProviderError(err) {
    if (err instanceof CodexProviderError) return err;
    if (err instanceof OAuthError) {
      const kind = err.status === 401 || err.status === 403 ? 'auth'
        : err.status === 429 ? 'rate_limited' : 'auth';
      return new CodexProviderError(err.message, { kind, status: err.status, retryable: false });
    }
    if (err?.status === 429 || err?.code === 'UND_ERR_HEADERS_TIMEOUT') {
      return new CodexProviderError(`codex upstream 429: ${err.message}`, { kind: 'rate_limited', status: 429, retryable: true });
    }
    return new CodexProviderError(`codex upstream error: ${err?.message ?? err}`, { kind: 'upstream', retryable: true });
  }

  async function upstreamError(upstream) {
    const text = await upstream.text().catch(() => '');
    const kind = upstream.status === 429 ? 'rate_limited' : upstream.status >= 500 ? 'upstream' : 'upstream';
    return new CodexProviderError(
      `codex upstream ${upstream.status}: ${text.slice(0, 300)}`,
      { kind, status: upstream.status, retryable: upstream.status >= 500 || upstream.status === 429 },
    );
  }

  /** 上游 responses SSE → chat chunks generator（字符串，含 data: 前缀与 [DONE]）。 */
  async function* streamAsChatChunks(upstream, model) {
    const converter = createSseConverter({ model });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const chunk of converter.feed(decoder.decode(value, { stream: true }))) {
          yield chunk;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
      try { await reader.cancel(); } catch {}
    }
  }

  return provider;
}
