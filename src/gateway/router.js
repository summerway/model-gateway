// router.js — HTTP request routing + reverse proxy core (gateway 数据面).
// 页面/静态资源 → dashboard/serve.js；/internal/* → monitor/internal-routes.js（usage、keys、
// usage/codex）与 ops/internal-routes.js（其余）；本文件只实现 /v1/* 与鉴权归因。
// Endpoints:
//   POST /v1/chat/completions      — passthrough to upstream (SSE transparent);
//                                     type:codex providers go through the codex
//                                     module (chat ↔ responses conversion)
//   POST /v1/responses             — responses-API form (codex passthrough)
//   POST /v1/messages              — Anthropic form: native passthrough only, via providers
//                                     declaring anthropicBaseUrl (SSE/tools verbatim — Claude
//                                     Code clients); no native provider → 400
//   POST /v1/messages/count_tokens — Anthropic token count (native providers only)
//   POST /v1/images/generations    — GPT Image 生成（codex 订阅链；config.imageGeneration 声明）
//   POST /v1/embeddings            — 文本向量（阿里百炼 DashScope；config.embeddings 声明）
//   GET  /v1/models                — catalog listing (gateway key auth)
//   GET  /                         — console page (src/dashboard/console.html, v0.5 起为默认页)
//   GET  /console | /dashboard     — 301 → /
//   GET  /usage | /keys | /inbox    — 301 → /#usage-summary | /#gateway-keys | /#gateway-suggestions
//   GET  /internal/dashboard       — dashboard aggregate (providers + events)
//   GET  /internal/usage           — usage stats aggregate (totals/buckets/logs)
//   GET  /internal/keys            — masked gateway keys + attribution status
//   GET  /internal/quota           — live quota snapshots from probe job
//   GET  /internal/events          — fallback / activation event stream
//   GET  /internal/providers       — codex provider health snapshot
//   GET  /internal/activator       — 5h window activator arming/retry state
//   POST /internal/activator/claude/claim  — 真 CLI 执行器领取到期 claude 激活回合
//   POST /internal/activator/claude/result — 执行器回报激活结果（事件/退避/锚定入账）
// Auth: Authorization: Bearer <gateway key> (or x-api-key header) on all /v1/*;
//       /internal/* restricted to internal networks by default.

import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolveRef } from '../config.js';
import { createAuth } from '../auth.js';
import { runFallbackChain, UpstreamError, classifyFailure } from './fallback/engine.js';
import { applyVisionRouting } from './vision-routing.js';
import { parseEmbeddingsRequest, embed } from './embeddings.js';
import { CodexProviderError } from './providers/codex/index.js';
import { SseUsageTap, extractUsage } from '../monitor/extract.js';
import { buildChain, orderChainByQuota, recordQuotaTransitions, upstreamModel } from './chain.js';
import { NOT_HANDLED, extractKey, readBody, sendJson } from '../http.js';
import { servePage } from '../dashboard/serve.js';
import { createOpsRoutes } from '../ops/internal-routes.js';
import { createMonitorRoutes } from '../monitor/internal-routes.js';
import { createAdminRoutes } from '../admin/routes.js';

// 测试与外部调用方沿用 router 入口导入链工具
export { buildChain, orderChainByQuota, recordQuotaTransitions };

const HOP_BY_TIMEOUT = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERROR']);

function isSseResponse(headers) {
  const ct = headers['content-type'] ?? '';
  return ct.includes('text/event-stream');
}

/**
 * Normalize OpenAI-isms that GLM upstream rejects. 智谱只认 system/user/assistant/tool
 * 角色，OpenAI 新式 `developer` 系统角色直通会被 400 code 1214「角色信息不正确」
 * 拒收（2026-09-24 实测：coding 端点 glm-5.3 后端容忍、glm-5.3-flash 严格拒收，
 * pi 子代理因此全灭）。codex responses-convert 对两种角色等价接受，统一归一无副作用。
 */
function normalizeUpstreamBody(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;
  let changed = false;
  const normalized = messages.map((m) => {
    if (m && typeof m === 'object' && m.role === 'developer') {
      changed = true;
      return { ...m, role: 'system' };
    }
    return m;
  });
  return changed ? { ...body, messages: normalized } : body;
}

/**
 * Create the HTTP request handler.
 * @param {object} deps — { config, catalog, events, quotaStore, registry?, fetch?, now? }
 *   registry: provider registry（codex 运行时；无 codex 时可省略）
 */
export function createRequestHandler(deps) {
  const { config, catalog, events } = deps;
  const auth = deps.auth ?? createAuth(config, { events });
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const quotaStore = deps.quotaStore ?? { snapshot: () => ({}) };
  // provider 熔断器（issue #3）；未注入则全部行为退化为现状（单测兼容）
  const breaker = deps.circuitBreaker ?? null;
  // per-attempt 超时（issue #3）：流式/非流式各自的上限；超时归 network 类失败。
  // 下限 50ms 仅防手建 config 的零/负值（YAML 路径由 validateConfig 拦）。
  const timeouts = {
    requestMs: Math.max(50, (config.gateway?.timeouts?.requestSec ?? 120) * 1000),
    streamMs: Math.max(50, (config.gateway?.timeouts?.streamSec ?? 300) * 1000),
  };
  // Quota-exhaustion episode state for transition events (per process).
  const quotaEpisodeState = new Map();
  // Latest real successful request per requested model (process-local, not inferred from quota).
  const lastSuccess = new Map();
  const markSuccess = (requested, provider) => lastSuccess.set(requested, {
    providerId: provider.id, model: upstreamModel(provider, requested), at: new Date().toISOString(),
  });
  const registry = deps.registry ?? { get: () => null, snapshot: () => ({}) };
  // 监控伪 provider（claude 订阅）：仅注入展示层聚合 —— /internal/dashboard 卡片、
  // /internal/usage 筛选器、?force 刷新 known 集；路由链构建（buildChain）永远
  // 只看 catalog.providers，claude 无 models、不可经代理端点寻址。
  const monitorProviders = deps.monitorProviders ?? [];
  // 向量端点展示位（dashscope/阿里百炼）：与 claude 监控位同构的 display-only 伪
  // provider —— 仅进 /internal/dashboard 卡片与 /internal/usage 筛选器；不进
  // catalog.providers，路由链构建与 /v1/models 目录零改动（向量经 /v1/embeddings
  // 单独寻址，不走 chat 链）。healthy = 凭据可解析：每次聚合时实时读 env，
  // 缺失即显式「异常」，而非等首个请求 500 才暴露。
  const embeddingsProviders = () => {
    const em = config.embeddings;
    if (!em) return [];
    const credOk = Boolean(resolveRef(em.apiKeyRef)) && Boolean(resolveRef(em.workspaceIdRef));
    return [{
      id: 'dashscope',
      type: 'dashscope',
      monitor: true,
      // monitor 位但流量确实经网关（/v1/embeddings）：拓扑卡据此连 gateway 边
      // 并纳入演示路由（claude 监控位无此标记，保持直连口径）。
      routable: true,
      // 名称/图标均为官方口径：官网导航简称「阿里云百炼」（全称「大模型服务平台百炼」），
      // 图标取百炼控制台 favicon（见 dashboard ICONS.bailian 注释）
      displayName: '阿里云百炼',
      badge: 'API按量收费',
      desc: '文本向量 · POST /v1/embeddings',
      healthy: credOk,
      statusReason: credOk ? null : 'apiKeyRef/workspaceIdRef 解析为空（env 未配置），向量请求将返回 500',
      models: [...em.models],
      modelDefs: {},
      // 维度信息移至模型行展示（用户要求）；供 modelRows 渲染「默认 N 维」
      defaultDimensions: em.defaultDimensions ?? 1024,
    }];
  };
  const displayCatalog = () => ({ providers: [...catalog.providers, ...monitorProviders, ...embeddingsProviders()] });
  const usageLog = deps.usageLog ?? null;
  const pricing = deps.pricing ?? null;
  // ── 用量记录：uctx 贯穿单请求生命周期，recorded 防重复；client = 调用方
  //    归因（authorized 返回的 app；共享 key/裸字符串配置 → 'shared'）──
  const newUctx = (path, client, req) => ({
    t0: Date.now(), path, model: null, recorded: false, client: client || null,
    ...(client === 'shared' && req.headers['user-agent'] ? { ua: req.headers['user-agent'].slice(0, 120) } : {}),
  });
  function recordU(uctx, fields = {}) {
    if (!usageLog || !uctx || uctx.recorded || !uctx.model) return;
    uctx.recorded = true;
    usageLog.record({
      ts: new Date(uctx.t0).toISOString(),
      path: uctx.path,
      client: uctx.client ?? null,
      ...(uctx.ua ? { ua: uctx.ua } : {}),
      providerId: fields.providerId ?? null,
      model: uctx.model,
      upstreamModel: fields.upstreamModel ?? uctx.model,
      stream: fields.stream === true,
      status: fields.status ?? null,
      ok: fields.ok !== false,
      latencyMs: Date.now() - uctx.t0,
      usage: fields.usage ?? null,
      reported: fields.reported === true,
      ...(fields.clientAbort === true ? { clientAbort: true } : {}),
    });
  }
  const activatorStore = deps.activatorStore ?? { snapshot: () => ({ error: 'activator not wired' }) };
  // codex-reset.com 重置预测（可选注入；未注入 → codex 卡片不渲染预测区）
  const forecastStore = deps.forecastStore ?? null;
  // model-guard 配置态（可选注入；未注入 → features 不出现，🛡 图标不渲染）
  const modelGuardStore = deps.modelGuardStore ?? null;
  // gateway keys：key → app（per-app 归因）。兼容归一化后的 {key, app} 条目与
  // 裸字符串/手建 config（app=shared）；未解析/冲突条目记事件并保留诊断状态。
  const gatewayKeys = new Map();
  const keyStates = [];
  for (const entry of config.gateway?.keys ?? []) {
    const ref = typeof entry === 'string' ? entry : entry?.key;
    const app = (typeof entry === 'string' ? undefined : entry?.app) || 'shared';
    const k = resolveRef(ref);
    let status = 'ok';
    if (!k || k.startsWith('env:')) {
      status = 'missing';
      events?.record('gateway_key_missing', { app, ref });
      console.error(`[gateway] gateway_key_missing: app=${app}, ref=${ref}`);
    } else if (gatewayKeys.has(k)) {
      status = 'conflict';
      const apps = [gatewayKeys.get(k), app];
      events?.record('gateway_key_conflict', { apps });
      console.error(`[gateway] gateway_key_conflict: apps=${apps.join(',')}; keeping first entry`);
    } else gatewayKeys.set(k, app);
    keyStates.push({ app, note: entry?.note ?? null, status, masked: status === 'missing' ? null : '…' + k.slice(-4) });
  }
  // 来源(client) 筛选下拉：配置声明的 app 集合（与运行时观测到的取并集）
  const keyApps = () => [...new Set((config.gateway?.keys ?? []).map((k) =>
    typeof k === 'string' ? 'shared' : (k?.app || 'shared'),
  ))];

  /** 熔断器回喂：runFallbackChain 的 attempts（请求路径，唯一口径）。
   *  ok → recordSuccess；失败仅 retriable 类计数（breaker 内部再过滤一次）。 */
  const feedBreaker = (attempts) => {
    if (!breaker || !Array.isArray(attempts)) return;
    for (const a of attempts) {
      if (a.ok) breaker.recordSuccess(a.providerId);
      else breaker.recordFailure(a.providerId, { reason: a.reason, status: a.status });
    }
  };

  function authorized(req) {
    const key = extractKey(req);
    if (!key) return false;
    // 返回匹配的 app（调用方归因）；未命中 → false（拒绝行为与旧 Set 版一致）
    return gatewayKeys.get(key) ?? false;
  }

  // 分层内部端点：ops（运维与看板）/ monitor（用量与密钥）；路径与响应结构不变
  const opsRoute = createOpsRoutes({
    deps, displayCatalog, events, quotaStore, registry, lastSuccess, breaker, pricing,
    activatorStore, modelGuardStore, forecastStore,
  });
  const monitorRoute = createMonitorRoutes({
    config, catalog, displayCatalog, usageLog, pricing, keyStates, keyApps,
    agentEndpoints: deps.agentEndpoints ?? null,
  });

  function listModels() {
    const models = new Map();
    for (const p of catalog.providers) {
      for (const id of p.models) {
        if (!models.has(id)) models.set(id, { id, providers: [] });
        models.get(id).providers.push(p.id);
      }
    }
    for (const id of config.claude?.models ?? []) {
      if (!models.has(id)) models.set(id, { id, providers: ['claude'], displayOnly: true });
    }
    return { object: 'list', data: [...models.values()].map(m => ({
      id: m.id, object: 'model', owned_by: m.displayOnly ? 'claude-subscription' : 'model-gateway',
      providers: m.providers, routable: !m.displayOnly,
    })) };
  }
  const adminRoute = createAdminRoutes({
    auth, config, catalog, configChanges: deps.configChanges, opsRoute, monitorRoute,
    models: listModels, inbox: deps.inboxStore,
  });

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://internal');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let uctx = null;

    try {
      if (path === '/admin/v1' || path.startsWith('/admin/v1/')) return await adminRoute(req, res, url, path);
      if (await auth.handleAuthRoutes(req, res, path)) return;
      const pageGate = auth.gatePage(req, path);
      if (pageGate.redirect) {
        res.writeHead(302, { location: pageGate.redirect, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (!pageGate.ok) return sendJson(res, pageGate.status, { error: 'forbidden' });
      if (servePage(req, res, path)) return;
      if (path.startsWith('/internal/')) {
        const gate = auth.gateInternal(req, path);
        if (!gate.ok) return sendJson(res, gate.status, { error: gate.error });
        if (auth.mode === 'token') req.mgAuthorized = true;
        req.mgDevice = gate.device;
        if (await monitorRoute(req, res, url, path) !== NOT_HANDLED) return;
        if (await opsRoute(req, res, url, path) !== NOT_HANDLED) return;
      }

      // ── Catalog ────────────────────────────────────────────────────────
      if (path === '/v1/models' && req.method === 'GET') {
        if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
        return sendJson(res, 200, listModels());
      }

      // ── Proxy endpoints ────────────────────────────────────────────────
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        const app = authorized(req);
        if (app === false) return sendJson(res, 401, { error: 'unauthorized' });
        uctx = newUctx(path, app, req);
        return await handleProxy(req, res, { uctx });
      }
      if (path === '/v1/responses' && req.method === 'POST') {
        const app = authorized(req);
        if (app === false) return sendJson(res, 401, { error: 'unauthorized' });
        uctx = newUctx(path, app, req);
        return await handleResponses(req, res, { uctx });
      }
      if (path === '/v1/messages' && req.method === 'POST') {
        const app = authorized(req);
        if (app === false) return sendJson(res, 401, { error: 'unauthorized' });
        uctx = newUctx(path, app, req);
        return await handleMessages(req, res, { uctx });
      }
      if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
        if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
        return await handleCountTokens(req, res);
      }
      if (path === '/v1/images/generations' && req.method === 'POST') {
        const app = authorized(req);
        if (app === false) return sendJson(res, 401, { error: 'unauthorized' });
        uctx = newUctx(path, app, req);
        return await handleImages(req, res, { uctx });
      }
      if (path === '/v1/embeddings' && req.method === 'POST') {
        const app = authorized(req);
        if (app === false) return sendJson(res, 401, { error: 'unauthorized' });
        uctx = newUctx(path, app, req);
        return await handleEmbeddings(req, res, { uctx });
      }

      return sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
    } catch (err) {
      // 客户端中断（如用户打断流式生成）不是上游故障：不记 502、不反馈状态。
      if (isClientAbort(err, res)) {
        // 终止标记后断开已在流式 finally 记为成功：不再报 client_abort、不再落失败账
        if (!uctx?.suppressAbortEvent) {
          // 来源归因（client=调用方 app、providerId=管道阶段补挂）：面板事件流直接展示，不再只有裸 path
          events.record('client_abort', {
            path,
            model: err.model,
            ...(err.providerId ? { providerId: err.providerId } : {}),
            ...(uctx?.client ? { client: uctx.client } : {}),
          });
          recordU(uctx, { ok: false, status: null, providerId: err.providerId ?? null, clientAbort: true });
        }
        res.destroy();
        return;
      }
      const status = err instanceof UpstreamError && err.status ? err.status : 502;
      const kind = err instanceof UpstreamError ? err.kind : classifyFailure(err);
      events.record('request_error', {
        path,
        model: err.model,
        status,
        kind,
        error: err.message,
        ...(err.providerId ? { providerId: err.providerId } : {}),
        ...(uctx?.client ? { client: uctx.client } : {}),
      });
      recordU(uctx, { ok: false, status, providerId: err.providerId ?? null });
      if (!res.headersSent) {
        sendJson(res, status, {
          error: { message: err.message, type: err instanceof UpstreamError ? 'upstream_error' : 'gateway_error', code: err.code ?? kind },
        });
      } else {
        res.destroy();
      }
    }
  };

  /**
   * Core proxy path with ordered fallback.
   * One upstream attempt = fetch upstream; on retriable failure the chain advances.
   * SSE: pipe upstream body straight to the client (no buffering). Fallback only
   * before the first byte is forwarded (after that, destroying is the only option).
   */
  async function handleProxy(req, res, { uctx = null }) {
    const rawBody = await readBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    }

    let openaiBody = normalizeUpstreamBody(body);
    let model = openaiBody.model;
    if (uctx) uctx.model = model;
    if (!model || typeof model !== 'string') {
      return sendJson(res, 400, { error: { message: 'missing "model" in request body' } });
    }

    // ── Vision routing（v1 reroute）：text-only 模型收到含图请求 → 改写至视觉 target
    //    模型（历史区图占位/uncertain 全保像素）。此后本函数内一律用 routing 后的
    //    body 与 model：target 自身链生效，链耗尽 502 带 attempts，绝不回落原模型。
    //    uctx.model 记 effective 模型（usage 归 target）；requested 模型记进事件。──
    const { body: routedBody, routing } = applyVisionRouting(openaiBody, catalog);
    openaiBody = routedBody;
    model = openaiBody.model;
    if (uctx) uctx.model = model;
    const visionHeaders = routing?.action === 'reroute'
      ? { 'x-gateway-vision-reroute': `${routing.from}->${routing.to}` }
      : null;
    if (routing) {
      events.record(routing.action === 'reroute' ? 'vision_reroute' : 'vision_placeholder', {
        from: routing.from,
        to: routing.to,
        newImages: routing.newImages,
        placeholderCount: routing.placeholderCount,
        uncertain: routing.uncertain,
        path: 'chat',
      });
    }

    recordQuotaTransitions({
      providers: catalog.providers,
      quotaSnap: quotaStore.snapshot(),
      state: quotaEpisodeState,
      events,
    });

    const chain = orderChainByQuota(buildChain(catalog, model), quotaStore.snapshot(), { breaker });
    if (chain.length === 0) {
      recordU(uctx, { ok: false, status: 503 });
      return sendJson(res, 503, { error: { message: `no provider for model "${model}"` } });
    }

    const attempted = new Set();
    const chainDedup = chain.filter((p) => (attempted.has(p.id) ? false : (attempted.add(p.id), true)));

    let outcome;
    try {
      outcome = await runFallbackChain(chainDedup, async (provider) => {
        if (provider.type === 'codex') return attemptCodex(provider, openaiBody);
        const apiKey = requireApiKey(provider);
        return fetchUpstream(provider, apiKey, injectUsageFlag({ ...openaiBody, model: upstreamModel(provider, model) }, provider));
      }, { model, onEvent: (e) => events.record(e.type, e) });
      feedBreaker(outcome.attempts);
    } catch (err) {
      feedBreaker(err.attempts);
      return sendChainFailure(res, err, model, uctx);
    }

    const { result } = outcome;

    // codex 路径：result 可能是 chat JSON、responses JSON 或 SSE chunk generator
    if (result?.__codex) {
      if (result.stream) {
        const tap = new SseUsageTap();
        let streamOk = true;
        let pipeErr = null;
        const tapped = async function* () {
          for await (const chunk of result.chunks) {
            tap.feed(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
            yield chunk;
          }
        }();
        try {
          await writeCodexStream(res, result.providerId, tapped, visionHeaders);
          markSuccess(model, outcome.provider);
        } catch (e) {
          streamOk = false; pipeErr = e;
          if (e && e.providerId == null) e.providerId = result.providerId; // 事件流来源归因
          throw e;
        } finally {
          // 终止标记已透出后客户端断开（codex CLI 行为）→ 记成功，不算失败/中断
          const closedAfterDone = !streamOk && tap.completed && isClientAbort(pipeErr, res);
          if (closedAfterDone && uctx) uctx.suppressAbortEvent = true;
          recordU(uctx, {
            providerId: result.providerId, upstreamModel: upstreamModel(outcome.provider, model),
            stream: true, status: streamOk || closedAfterDone ? 200 : null, ok: streamOk || closedAfterDone,
            clientAbort: !streamOk && !closedAfterDone && isClientAbort(pipeErr, res),
            usage: tap.usage, reported: tap.reported,
          });
        }
        return;
      }
      markSuccess(model, outcome.provider);
      const outBody = result.chat ?? result.responses;
      const u = extractUsage((result.chat ?? result.responses)?.usage);
      recordU(uctx, {
        providerId: result.providerId, upstreamModel: upstreamModel(outcome.provider, model),
        stream: openaiBody.stream === true, status: 200, ok: true,
        usage: u, reported: u != null,
      });
      return sendJson(res, 200, outBody, visionHeaders);
    }

    return forwardUpstream(res, outcome, { model, uctx, visionHeaders });
  }

  function requireApiKey(provider) {
    const apiKey = resolveRef(provider.apiKeyRef);
    if (!apiKey) {
      const err = new UpstreamError(`missing API key for provider ${provider.id} (ref ${provider.apiKeyRef})`, {
        providerId: provider.id,
        kind: 'client_error',
      });
      err.status = 401;
      throw err;
    }
    return apiKey;
  }

  /** 链失败收口（handleProxy / 原生透传共用）：上游末次可重放响应优先，否则 502/原状态。 */
  function sendChainFailure(res, err, model, uctx) {
    err.model = model;
    recordU(uctx, { ok: false, status: err.exhausted ? 502 : err.status ?? 502, providerId: err.providerId ?? null });
    if (err.finalResponse && !res.headersSent) {
      res.writeHead(err.finalResponse.status, {
        'content-type': err.finalResponse.contentType || 'application/json',
      });
      return res.end(err.finalResponse.body);
    }
    if (!res.headersSent) {
      // Chain exhausted by retriable failures → 502 (gateway-level failure);
      // a non-retriable client error surfaces the upstream status verbatim.
      const status = err.exhausted ? 502 : err.status ?? 502;
      return sendJson(res, status, {
        error: {
          message: `all providers failed for model "${model}": ${err.message}`,
          type: 'upstream_error',
          attempts: err.attempts,
          exhausted: err.exhausted === true,
        },
      });
    }
    res.destroy();
  }

  /**
   * POST /v1/messages：仅原生透传。链中无 anthropicBaseUrl provider → 400（Anthropic 错误形态）。
   * Messages↔Chat 格式转换已删除（2026-10-28 定位方案）：它只支持非流式，原生透传上线后无真实调用方。
   */
  async function handleMessages(req, res, { uctx = null } = {}) {
    const rawBody = await readBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } });
    }
    if (!body.model || typeof body.model !== 'string') {
      return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'missing "model" in request body' } });
    }
    const chain = anthropicNativeChain(body.model);
    if (chain.length === 0) {
      return sendJson(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: `model "${body.model}" has no native Anthropic provider (anthropicBaseUrl); use /v1/chat/completions` },
      });
    }
    return handleAnthropicNative(req, res, body, chain, { uctx, suffix: '/v1/messages' });
  }

  /** /v1/messages 原生透传链：模型链中声明 anthropicBaseUrl 的 provider（链序不变）。 */
  function anthropicNativeChain(model) {
    if (!model || typeof model !== 'string') return [];
    return buildChain(catalog, model).filter((p) => p.type !== 'codex' && p.anthropicBaseUrl);
  }

  /** 原生透传上游头：同一 key 同时给 Bearer 与 x-api-key（兼容 AUTH_TOKEN/API_KEY 两种上游口径），
   *  anthropic-version / anthropic-beta 按客户端原样转发。 */
  function anthropicUpstreamHeaders(req, apiKey) {
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01',
    };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    return headers;
  }

  /**
   * Anthropic 原生透传（Claude Code 等客户端）：请求体原样转发，只改写 model 映射与鉴权；
   * SSE / tool_use / thinking 原样往返，用量由 SseUsageTap 旁路记账。切链语义同 handleProxy
   * （首字节前）。视觉路由不适用：图像由原生上游自行处理或拒收。
   */
  async function handleAnthropicNative(req, res, body, chain, { uctx = null, suffix = '/v1/messages' } = {}) {
    const model = body.model;
    if (uctx) uctx.model = model;
    recordQuotaTransitions({
      providers: catalog.providers,
      quotaSnap: quotaStore.snapshot(),
      state: quotaEpisodeState,
      events,
    });
    const ordered = orderChainByQuota(chain, quotaStore.snapshot(), { breaker });
    let outcome;
    try {
      outcome = await runFallbackChain(ordered, async (provider) => {
        const apiKey = requireApiKey(provider);
        return fetchUpstream(provider, apiKey, { ...body, model: upstreamModel(provider, model) }, {
          url: provider.anthropicBaseUrl + suffix,
          headers: anthropicUpstreamHeaders(req, apiKey),
        });
      }, { model, onEvent: (e) => events.record(e.type, e) });
      feedBreaker(outcome.attempts);
    } catch (err) {
      feedBreaker(err.attempts);
      return sendChainFailure(res, err, model, uctx);
    }
    return forwardUpstream(res, outcome, { model, uctx });
  }

  /** POST /v1/messages/count_tokens：仅原生链；不计用量（非生成请求）。 */
  async function handleCountTokens(req, res) {
    const rawBody = await readBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    }
    const chain = anthropicNativeChain(body.model);
    if (chain.length === 0) {
      return sendJson(res, 404, {
        type: 'error',
        error: { type: 'not_found_error', message: `count_tokens unsupported for model "${body.model}" (no anthropicBaseUrl provider)` },
      });
    }
    return handleAnthropicNative(req, res, body, chain, { suffix: '/v1/messages/count_tokens' });
  }

  /** 非 codex 上游结果回写：非流式 JSON 原样转发或 SSE 透明管道。 */
  async function forwardUpstream(res, outcome, { model, uctx, visionHeaders = null }) {
    const { result } = outcome;
    const upstreamRes = result.response;

    // Non-streaming: forward the JSON body.
    if (!result.isSse) {
      const text = await result.response.text().finally(result.clearTimer);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      markSuccess(model, outcome.provider);
      const u = extractUsage(parsed?.usage);
      recordU(uctx, {
        providerId: outcome.provider.id, upstreamModel: upstreamModel(outcome.provider, model),
        stream: false, status: upstreamRes.status, ok: upstreamRes.status < 400,
        usage: u, reported: u != null,
      });
      return sendJson(res, upstreamRes.status, parsed, visionHeaders);
    }

    // SSE: transparent pipe with fallback-safe headers.
    const headers = {
      'content-type': upstreamRes.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-gateway-provider': outcome.provider.id,
      ...(visionHeaders ?? {}),
    };
    res.writeHead(upstreamRes.status, headers);
    const bodyStream = Readable.fromWeb(upstreamRes.body);
    const tap = new SseUsageTap();
    let sseOk = true;
    let pipeErr = null;
    try {
      await pipeline(bodyStream, tap, res);
      markSuccess(model, outcome.provider);
    } catch (e) {
      sseOk = false;
      pipeErr = e;
      // 网关自身 streamSec 超时掐断上游：换成 kind='timeout' 的上游错误再抛，
      // 让外层错误处理器记 request_error（而非误判客户端中断）
      if (result.isTimedOut?.()) {
        pipeErr = new UpstreamError(
          `upstream ${outcome.provider.id} stream timeout after ${timeouts.streamMs}ms`,
          { providerId: outcome.provider.id, kind: 'timeout' },
        );
      }
      // 真客户端中断（ERR_STREAM_DESTROYED 等）也带上 providerId：事件流来源归因
      if (pipeErr && pipeErr.providerId == null) pipeErr.providerId = outcome.provider.id;
      throw pipeErr;
    } finally {
      result.clearTimer();
      const closedAfterDone = !sseOk && tap.completed && isClientAbort(pipeErr, res);
      if (closedAfterDone && uctx) uctx.suppressAbortEvent = true;
      recordU(uctx, {
        providerId: outcome.provider.id, upstreamModel: upstreamModel(outcome.provider, model),
        stream: true, status: sseOk || closedAfterDone ? upstreamRes.status : null, ok: sseOk || closedAfterDone,
        clientAbort: !sseOk && !closedAfterDone && isClientAbort(pipeErr, res),
        usage: tap.usage, reported: tap.reported,
      });
    }
  }

  /** openai 兼容上游流式请求注入 include_usage：末 chunk 才会带 usage（deepseek 等需要）。
   *  仅 type:openai（glm 原生末 chunk 带 usage，不注入以免未知字段风险；codex 自成体系）。*/
  function injectUsageFlag(body, provider) {
    if (!body || provider.type !== 'openai' || body.stream !== true) return body;
    return { ...body, stream_options: { ...(body.stream_options ?? {}), include_usage: true } };
  }

  /**
   * codex provider 单次尝试：健康检查 + 按形态分派 chatCompletions/responses。
   * 返回 { __codex, chat?|responses?, stream?, chunks?, providerId } 或抛 UpstreamError。
   */
  async function attemptCodex(provider, openaiBody) {
    const codex = registry.get(provider.id);
    if (!codex) {
      const err = new UpstreamError(`no codex runtime for provider ${provider.id}`, {
        providerId: provider.id, kind: 'client_error', retriable: false,
      });
      err.status = 500;
      throw err;
    }
    if (!codex.healthy()) {
      throw new UpstreamError(
        `codex provider ${provider.id} unhealthy: ${codex.status().reason ?? 'unknown'}`,
        { providerId: provider.id, kind: 'unhealthy', retriable: true },
      );
    }
    try {
      // fallbackModelMap 改写与 openai/glm 路径对齐（/v1/responses 路径不改，保持最小面）
      const out = await codex.chatCompletions({ ...openaiBody, model: upstreamModel(provider, openaiBody.model) }, {});
      if (out && typeof out[Symbol.asyncIterator] === 'function') {
        return { __codex: true, stream: true, chunks: out, providerId: provider.id };
      }
      return { __codex: true, stream: false, chat: out, providerId: provider.id };
    } catch (err) {
      throw codexErrorToUpstream(err, provider.id);
    }
  }

  /** POST /v1/responses — responses API 形态（仅 codex；透传 provider 需另定端点语义）*/
  async function handleResponses(req, res, { uctx = null } = {}) {
    const rawBody = await readBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    }
    const model = body.model;
    if (uctx) uctx.model = model;
    if (!model || typeof model !== 'string') {
      return sendJson(res, 400, { error: { message: 'missing "model" in request body' } });
    }
    const chain = orderChainByQuota(
      buildChain(catalog, model).filter((p) => p.type === 'codex' && p.models.includes(model)),
      quotaStore.snapshot(),
      { breaker },
    );
    if (chain.length === 0) {
      return sendJson(res, 503, { error: { message: `no codex provider for model "${model}" (responses form is codex-only)` } });
    }

    let outcome;
    try {
      outcome = await runFallbackChain(chain, async (provider) => {
        const codex = registry.get(provider.id);
        if (!codex) {
          const err = new UpstreamError(`no codex runtime for provider ${provider.id}`, {
            providerId: provider.id, kind: 'client_error', retriable: false,
          });
          err.status = 500;
          throw err;
        }
        if (!codex.healthy()) {
          throw new UpstreamError(
            `codex provider ${provider.id} unhealthy: ${codex.status().reason ?? 'unknown'}`,
            { providerId: provider.id, kind: 'unhealthy', retriable: true },
          );
        }
        try {
          const upstream = await codex.responses(body, { sessionHeaders: req.headers });
          if (!upstream.ok) {
            throw await codexUpstreamError(upstream, provider.id);
          }
          return { __codex: true, stream: Boolean(body.stream), upstream, providerId: provider.id };
        } catch (err) {
          throw codexErrorToUpstream(err, provider.id);
        }
      }, { model, onEvent: (e) => events.record(e.type, e) });
      feedBreaker(outcome.attempts);
    } catch (err) {
      feedBreaker(err.attempts);
      err.model = model;
      recordU(uctx, { ok: false, status: err.exhausted ? 502 : err.status ?? 502, providerId: err.providerId ?? null });
      if (!res.headersSent) {
        const status = err.exhausted ? 502 : err.status ?? 502;
        return sendJson(res, status, {
          error: {
            message: `all providers failed for model "${model}": ${err.message}`,
            type: 'upstream_error',
            attempts: err.attempts,
            exhausted: err.exhausted === true,
          },
        });
      }
      res.destroy();
      return;
    }

    const { result } = outcome;
    // SSE: 逐行透传上游 responses 事件（旁挂 usage 扫描）
    if (result.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-gateway-provider': result.providerId,
      });
      const tap = new SseUsageTap();
      let streamOk = true;
      let pipeErr = null;
      try {
        await pipeline(Readable.fromWeb(result.upstream.body), tap, res);
        markSuccess(model, outcome.provider);
      } catch (e) {
        streamOk = false; pipeErr = e;
        if (e && e.providerId == null) e.providerId = result.providerId; // 事件流来源归因
        throw e;
      } finally {
        const closedAfterDone = !streamOk && tap.completed && isClientAbort(pipeErr, res);
        if (closedAfterDone && uctx) uctx.suppressAbortEvent = true;
        recordU(uctx, {
          providerId: result.providerId, upstreamModel: model,
          stream: true, status: streamOk || closedAfterDone ? 200 : null, ok: streamOk || closedAfterDone,
          clientAbort: !streamOk && !closedAfterDone && isClientAbort(pipeErr, res),
          usage: tap.usage, reported: tap.reported,
        });
      }
      return;
    }
    const json = await result.upstream.json().catch(() => ({ raw: '<unparseable>' }));
    markSuccess(model, outcome.provider);
    const u = extractUsage(json.usage);
    recordU(uctx, {
      providerId: result.providerId, upstreamModel: model,
      stream: false, status: 200, ok: true,
      usage: u, reported: u != null,
    });
    return sendJson(res, 200, json);
  }

  /**
   * POST /v1/images/generations — GPT Image 生成（codex 订阅 OAuth 链）。
   * 路由声明在 config.imageGeneration: { provider, model }（未配置 → 404）；
   * 单 provider 直连不走 fallback 链（无第二图像源可回退）。请求体 OpenAI 形：
   * { prompt 必填, model/n/size/quality/background 可选（model 以 config pin 为准）。}
   */
  async function handleImages(req, res, { uctx = null } = {}) {
    const ig = config.imageGeneration;
    if (!ig) {
      return sendJson(res, 404, { error: { message: 'image generation not configured (set imageGeneration: { provider, model } in config.yaml)' } });
    }
    const rawBody = await readBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    }
    if (!body.prompt || typeof body.prompt !== 'string') {
      return sendJson(res, 400, { error: { message: 'missing "prompt" in request body' } });
    }
    const provider = catalog.providers.find((p) => p.id === ig.provider);
    if (!provider) {
      return sendJson(res, 500, { error: { message: `imageGeneration.provider "${ig.provider}" not found in catalog` } });
    }
    if (uctx) uctx.model = ig.model;
    const codex = registry.get(provider.id);
    if (!codex) {
      recordU(uctx, { ok: false, status: 500, providerId: provider.id });
      return sendJson(res, 500, { error: { message: `no codex runtime for provider ${provider.id}` } });
    }
    if (!codex.healthy()) {
      recordU(uctx, { ok: false, status: 503, providerId: provider.id });
      return sendJson(res, 503, { error: { message: `codex provider ${provider.id} unhealthy: ${codex.status().reason ?? 'unknown'}` } });
    }
    events.record('imagegen', { providerId: provider.id, model: ig.model });
    const payload = {
      prompt: body.prompt,
      model: ig.model, // config pin：请求体 model 字段不透传（防源漂移，同 codex 模型坑教训）
      ...(body.n !== undefined ? { n: body.n } : {}),
      ...(body.size !== undefined ? { size: body.size } : {}),
      ...(body.quality !== undefined ? { quality: body.quality } : {}),
      ...(body.background !== undefined ? { background: body.background } : {}),
    };
    try {
      const json = await codex.images(payload, {});
      markSuccess(ig.model, provider);
      const u = extractUsage(json.usage);
      recordU(uctx, {
        providerId: provider.id, upstreamModel: ig.model,
        stream: false, status: 200, ok: true,
        usage: u, reported: u != null,
      });
      return sendJson(res, 200, json);
    } catch (err) {
      events.record('imagegen_error', { providerId: provider.id, model: ig.model, message: String(err?.message ?? err) });
      const status = err?.status === 429 ? 429 : err?.kind === 'auth' ? 502 : err?.status ?? 502;
      recordU(uctx, { ok: false, status, providerId: provider.id });
      return sendJson(res, status, {
        error: { message: `image generation failed: ${err?.message ?? err}`, type: 'upstream_error' },
      });
    }
  }

  /**
   * POST /v1/embeddings — 文本向量（阿里百炼）。路由声明在 config.embeddings（未配置 → 404）。
   * 请求体 OpenAI 形 + 扩展字段 text_type（query|document）；单上游，不走 fallback 链。
   */
  async function handleEmbeddings(req, res, { uctx = null } = {}) {
    const em = config.embeddings;
    if (!em) {
      return sendJson(res, 404, { error: { message: 'embeddings not configured (set embeddings: { type: dashscope, ... } in config.yaml)' } });
    }
    const rawBody = await readBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    }
    const parsed = parseEmbeddingsRequest(body, em);
    if (parsed.error) return sendJson(res, 400, { error: { message: parsed.error } });
    if (uctx) uctx.model = parsed.model;
    const apiKey = resolveRef(em.apiKeyRef);
    const workspaceId = resolveRef(em.workspaceIdRef);
    if (!apiKey || !workspaceId) {
      recordU(uctx, { ok: false, status: 500, providerId: 'dashscope' });
      return sendJson(res, 500, { error: { message: 'embeddings credentials missing (apiKeyRef/workspaceIdRef resolved empty)' } });
    }
    try {
      const { response, via } = await embed({ fetchFn, cfg: em, apiKey, workspaceId, req: parsed, timeoutMs: timeouts.requestMs });
      if (via !== 'native') events.record('embeddings_degraded', { providerId: 'dashscope', model: parsed.model, via });
      const u = extractUsage(response.usage);
      recordU(uctx, { providerId: 'dashscope', upstreamModel: parsed.model, stream: false, status: 200, ok: true, usage: u, reported: u != null });
      return sendJson(res, 200, response);
    } catch (err) {
      events.record('embeddings_error', { providerId: 'dashscope', model: parsed.model, message: String(err?.message ?? err) });
      const status = err?.status ?? 502;
      recordU(uctx, { ok: false, status, providerId: 'dashscope' });
      return sendJson(res, status, { error: { message: `embeddings failed: ${err?.message ?? err}`, type: 'upstream_error' } });
    }
  }

  /** 单次上游请求。默认 OpenAI chat 端点 + Bearer；原生 Anthropic 透传传入 url 与 headers。 */
  async function fetchUpstream(provider, apiKey, openaiBody, { url = provider.baseUrl, headers = null } = {}) {
    // per-attempt 超时（issue #3）：整个 attempt（含响应体读取）封顶；流式按流式上限。
    // 超时 abort 归 'timeout'（2026-10-26 修订，原 network）：retriable → 切链，
    // 但不计入熔断——上游慢生成≠不可达（非流式大输出 TTFB=全部生成时间）。
    // timer unref：
    // clearTimeout 漏调时也不阻进程退出；已完成的 fetch 上再 abort 是无害 no-op。
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = openaiBody.stream === true ? timeouts.streamMs : timeouts.requestMs;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref?.();
    const clearTimer = () => clearTimeout(timer);
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(headers ?? { authorization: `Bearer ${apiKey}` }),
          accept: openaiBody.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(openaiBody),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = e?.name === 'AbortError' || e?.cause?.name === 'AbortError';
      const err = new UpstreamError(
        aborted
          ? `timeout after ${timeoutMs}ms (provider ${provider.id})`
          : `network error: ${e?.message ?? e} (provider ${provider.id})`,
        { providerId: provider.id, ...(aborted ? { kind: 'timeout' } : {}), cause: e },
      );
      // undici: TypeError with cause.code；abort 时顶层是 DOMException(AbortError)，
      // legacy code=20（truthy）会阻断归类——abort 必须先判，kind='timeout' 让
      // classifyFailure 直接短路：retriable 切链、不喂熔断（e2e 验收4，
      // 2026-10-26 修订）。非 abort 才取真实 errno（network 口径）。
      if (!aborted) err.code = e?.code ?? e?.cause?.code ?? undefined;
      throw err;
    } finally {
      // 连接/首包阶段计时到此为止；body 阶段由调用方读完后 clearTimer
      if (!response) clearTimer();
    }

    const ct = response.headers.get('content-type') ?? '';
    const isSse = openaiBody.stream === true && ct.includes('text/event-stream');

    if (!response.ok) {
      // Read the error body (small) so the client can see the upstream error,
      // then let the fallback chain decide via the thrown status.
      let errText = '';
      try {
        errText = (await response.text()).slice(0, 2048);
      } catch {}
      clearTimer();
      if (isRetriableStatus(response.status)) {
        const err = new UpstreamError(
          `upstream ${provider.id} HTTP ${response.status}: ${errText}`,
          { providerId: provider.id, status: response.status },
        );
        err.retryResponse = { status: response.status, body: errText };
        throw err;
      }
      // Non-retriable: let the chain surface the upstream status verbatim.
      const err = new UpstreamError(
        `upstream ${provider.id} HTTP ${response.status}: ${errText}`,
        { providerId: provider.id, status: response.status, kind: 'client_error' },
      );
      throw err;
    }

    return { response, isSse, providerId: provider.id, clearTimer, isTimedOut: () => timedOut };
  }
}

/** codex CodexProviderError → UpstreamError（retriable 语义：auth/429/5xx → 切链上下一个，不终止链）*/
function codexErrorToUpstream(err, providerId) {
  if (!(err instanceof CodexProviderError)) {
    // 网络层错误等：retriable
    return new UpstreamError(`codex ${providerId}: ${err?.message ?? err}`, { providerId, cause: err });
  }
  const map = {
    auth: { kind: 'auth', retriable: true, status: err.status ?? 401 },
    rate_limited: { kind: 'rate_limited', retriable: true, status: err.status ?? 429 },
    upstream: { kind: 'server_error', retriable: true, status: err.status ?? 502 },
    network: { kind: 'network', retriable: true },
  };
  const m = map[err.kind] ?? map.upstream;
  return new UpstreamError(`codex ${providerId}: ${err.message}`, {
    providerId,
    status: m.status,
    kind: m.kind,
    retriable: m.retriable,
    cause: err,
  });
}

/** codex provider.responses() 的非 2xx 响应 → CodexProviderError 同语义 UpstreamError */
async function codexUpstreamError(upstream, providerId) {
  const text = await upstream.text().catch(() => '');
  const kind = upstream.status === 429 ? 'rate_limited' : upstream.status >= 500 ? 'upstream' : 'upstream';
  return new UpstreamError(`codex ${providerId} HTTP ${upstream.status}: ${text.slice(0, 300)}`, {
    providerId,
    status: upstream.status,
    kind,
    retriable: true,
  });
}

/** SSE chunk generator → 客户端响应（逐 chunk 写，不缓冲）。 */
async function writeCodexStream(res, providerId, chunks, extraHeaders = null) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-gateway-provider': providerId,
    ...(extraHeaders ?? {}),
  });
  for await (const chunk of chunks) {
    res.write(chunk);
  }
  res.end();
}

function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

/** 客户端主动断开（SSE 流中途 destroy）：err 判据为主，res 状态兜底。
 *  错误处理器与三处流式 finally 落账共用，保证 usage 的 clientAbort 口径一致。 */
function isClientAbort(err, res = null) {
  // 先排除网关自身超时掐上游（2026-11-04 线上事故：glm-5.3 长生成被 streamSec 默认 300s
  // 整齐掐断，pipeline 连带 destroy 目标 res，res 兑底判据把上游超时误记成
  // client_abort，误导排查）：转发层换出的 kind='timeout' UpstreamError，以及
  // controller.abort() 的原始 AbortError 错误形态，都不是客户端中断。
  if (err instanceof UpstreamError && err.kind === 'timeout') return false;
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR'
    || err?.cause?.name === 'AbortError' || err?.cause?.code === 'ABORT_ERR') return false;
  return err?.code === 'ERR_STREAM_DESTROYED'
    || /cannot pipe to a closed or destroyed stream/i.test(err?.message ?? '')
    || (res ? (res.destroyed && !res.writableEnded)
      || (res.socket?.destroyed && !res.writableEnded) : false);
}

