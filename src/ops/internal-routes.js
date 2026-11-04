// internal-routes.js — ops 层内部端点：/internal/dashboard、quota、events、providers、
// activator（含 claude 真 CLI 执行器 claim/result）、inbox。全部仅限内网访问。

import { NOT_HANDLED, isInternalRequest, readBody, sendJson } from '../http.js';
import { buildDashboardData, dashboardError } from './dashboard-data.js';

/**
 * @param {object} ctx — { deps, displayCatalog, events, quotaStore, registry, lastSuccess, breaker,
 *   pricing, activatorStore, modelGuardStore, forecastStore }
 */
export function createOpsRoutes(ctx) {
  const { deps, displayCatalog, events, quotaStore, registry, lastSuccess, breaker, pricing,
    activatorStore, modelGuardStore, forecastStore } = ctx;
  return async function opsRoute(req, res, url, path) {
    if (path === '/internal/inbox' || path === '/internal/inbox/preview' || path === '/internal/inbox/apply' || path === '/internal/inbox/rollback' || path === '/internal/inbox/read') {
      if (!isInternalRequest(req)) return sendJson(res,403,{error:'forbidden: internal only'});
      const inbox = deps.inboxStore;
      if (!inbox || inbox.loadError) return sendJson(res,503,{error:'收件箱状态暂不可用，请检查持久化文件'});
      if (path === '/internal/inbox' && req.method === 'GET') {
        const snap = inbox.snapshot(url.searchParams.has('summary'));
        // 页面渠道展示（图标+名称）需要渠道类型与展示名；summary 供导航角标，不附带
        if (!url.searchParams.has('summary')) {
          snap.providers = {};
          for (const p of deps.catalog?.providers ?? []) snap.providers[p.id] = { type: p.type, name: p.displayName || p.id };
        }
        return sendJson(res,200,snap,{ 'cache-control':'no-store' });
      }
      if (req.method !== 'POST' || path === '/internal/inbox') return sendJson(res,405,{error:'method not allowed'});
      let origin; try { origin = new URL(req.headers.origin); } catch {}
      if (!origin || !['http:','https:'].includes(origin.protocol) || origin.host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site' || req.headers['x-inbox-csrf'] !== inbox.csrf) return sendJson(res,403,{error:'页面会话已失效，请刷新页面后重试'});
      if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res,415,{error:'expected application/json'});
      try {
        const body = JSON.parse(await readBody(req,8192));
        if (path.endsWith('/preview')) return sendJson(res,200,inbox.preview(body.id,body.action));
        if (path.endsWith('/rollback')) return sendJson(res,200,await inbox.rollback());
        if (path.endsWith('/read')) { await inbox.serial(() => { const item = inbox.items.find(i => i.id === body.id); if (item) { item.read = true; inbox.save(); } }); return sendJson(res,200,{ok:true}); }
        return sendJson(res,200,await inbox.apply(body.token));
      } catch (err) { return sendJson(res,err.status ?? 400,{error:err.status ? err.message : '操作失败，请刷新后重试'}); }
    }

    if (path === '/internal/dashboard') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      // ?force=<providerId|all> — 强制向上游探测（绕过 cacheTtl），再返回数据。
      // 这是卡片/全局刷新按钮的「真刷新」路径；无 force 时只读缓存。
      const force = url.searchParams.get('force');
      const refreshErrors = [];
      if (url.searchParams.has('force')) {
        // known = 展示层全集（含 claude 监控位与 dashscope 向量展示位）；dashscope
        // 不在 probeIds → 单卡 force 会如实报「不支持用量探测」（前端不渲染其刷新按钮）
        const known = new Set(displayCatalog().providers.map((p) => p.id));
        if (!force || (force !== 'all' && !known.has(force))) {
          return sendJson(res, 400, { error: 'unknown provider' });
        }
        const probeIds = quotaStore.probeIds?.() ?? [];
        const ids = force === 'all' ? probeIds : [force];
        if (force !== 'all' && !probeIds.includes(force)) {
          refreshErrors.push({ providerId: force, error: '该渠道不支持用量探测' });
        } else {
          await Promise.all(ids.map(async (id) => {
            try {
              const result = await quotaStore.refresh(id);
              // QuotaProbe.refresh returns null on failure and a raw result on
              // success; its cached snapshot may still be ok:true but stale.
              if (!result?.ok) throw new Error(quotaStore.snapshot()?.[id]?.lastError ?? '探测失败');
            } catch (err) {
              refreshErrors.push({ providerId: id, error: err.message ?? '探测失败' });
            }
          }));
          // codex 卡片刷新顺带拉一次重置预测（非额度探测，低频缓存；失败不拦卡片）
          if (forecastStore && (force === 'all' || force === 'codex')) {
            await forecastStore.refresh?.({ force: true }).catch?.(() => {});
          }
        }
      }
      return sendJson(res, 200, { ...buildDashboardData({ catalog: displayCatalog(), events, quotaStore, registry, lastSuccess, breaker, eventsLimit: Number(url.searchParams.get('eventsLimit')), pricing, activator: activatorStore, modelGuard: modelGuardStore, forecast: forecastStore }), refreshErrors: refreshErrors.map(e => ({ ...e, error: dashboardError(e.error) })) });
    }
    if (path === '/internal/quota') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      return sendJson(res, 200, quotaStore.snapshot());
    }
    if (path === '/internal/events') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      const type = url.searchParams.get('type') ?? undefined;
      const limit = Number(url.searchParams.get('limit') ?? 200);
      return sendJson(res, 200, { events: events.list({ type, limit }) });
    }
    if (path === '/internal/providers') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      return sendJson(res, 200, { providers: registry.snapshot() });
    }
    if (path === '/internal/activator') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      return sendJson(res, 200, activatorStore.snapshot());
    }
    // 真 Claude Code CLI 执行器（compose sidecar claude-activator）领取/回报
    // claude 5h 窗口激活回合。订阅 OAuth /v1/messages 客户端指纹门控：激活
    // 请求必须由真客户端发出（2026-10-14 实测），网关只做状态机与记账。
    if (path === '/internal/activator/claude/claim' && req.method === 'POST') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      if (typeof activatorStore.claim !== 'function') return sendJson(res, 501, { error: 'claude activation not wired' });
      return sendJson(res, 200, activatorStore.claim());
    }
    if (path === '/internal/activator/claude/result' && req.method === 'POST') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      if (typeof activatorStore.report !== 'function') return sendJson(res, 501, { error: 'claude activation not wired' });
      let body;
      try {
        body = JSON.parse(await readBody(req, 8 * 1024));
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      if (typeof body?.claimId !== 'string' || !body.claimId) {
        return sendJson(res, 400, { error: 'claimId required' });
      }
      return sendJson(res, 200, activatorStore.report(body.claimId, body));
    }
    return NOT_HANDLED;
  };
}
