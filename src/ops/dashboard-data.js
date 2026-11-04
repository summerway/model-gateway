// dashboard-data.js — /internal/dashboard 聚合：provider 卡片（模型、逐模型备用链、额度、
// 熔断相位、激活/守护装饰）+ 最新事件。纯函数，读取各层快照，不产生动作。

import { buildChain, orderChainByQuota, upstreamModel } from '../gateway/chain.js';
import { providerDisplayName } from '../config.js';

// Probe errors can contain upstream bodies, URLs, or credentials. Display only
// known failure categories; detailed diagnostics remain in the server logs.
export function dashboardError(error) {
  if (!error) return null;
  const message = String(error);
  const status = message.match(/\b(?:HTTP\s*|status[:= ]+)([45]\d{2})\b/i)?.[1];
  if (status) return `额度查询返回 HTTP ${status}`;
  if (/timeout|timed out|abort/i.test(message)) return '额度查询超时';
  if (/credentials|api.?key|token|env|unauthori[sz]ed/i.test(message)) return '凭据不可用，请检查服务端认证配置';
  if (/network|fetch failed|ECONN|ENOTFOUND/i.test(message)) return '额度查询网络连接失败';
  return '额度查询失败，请查看服务端日志';
}

const SUCCESS_SAMPLE_TTL_MS = 10 * 60 * 1000; // old traffic is not proof of current routing

/** GLM quota snapshot → dashboard tier shape (usedPercent + resetsAt only). */
function dashTier(tier) {
  if (!tier || typeof tier.usedPercent !== 'number') return null;
  return { usedPercent: tier.usedPercent, resetsAt: tier.resetsAt ?? null };
}

/** 动态分页白名单：dashboard 事件 10/30/50；白名单外回退默认。 */
const EVENTS_LIMITS = [10, 30, 50];

/**
 * Build the /internal/dashboard aggregate: one call returns everything the
 * page renders — provider cards (models + per-model fallback chains + quota)
 * plus the newest 30 events (eventsLimit 白名单 10/30/50）。
 * breaker（可选）注入后：expected 排序反映熔断降级，provider 卡片附 circuit 相位。
 * Pure function over deps; exported for tests.
 */
export function buildDashboardData({ catalog, events, quotaStore, registry, lastSuccess, breaker, eventsLimit = 30, pricing = null, activator = null, modelGuard = null, forecast = null }) {
  const eventsTake = EVENTS_LIMITS.includes(eventsLimit) ? eventsLimit : 30;
  const quotaSnap = quotaStore?.snapshot?.() ?? {};
  const regSnap = registry?.snapshot?.() ?? {};
  const circuitSnap = breaker ? breaker.snapshot() : null;
  // 装饰联动（可选注入）：激活器 per-provider active（⚡ 图标）、model-guard 配置态（🛡 图标）
  const actSnap = activator?.snapshot?.() ?? null;
  const mgSnap = modelGuard?.snapshot?.() ?? null;
  // codex-reset.com 全局重置预测（可选注入；仅 codex 卡片消费）
  const fcSnap = forecast?.snapshot?.() ?? null;

  const providers = catalog.providers.map((p) => {
    const models = p.models.map((m) => {
      // 监控位模型（claude 订阅展示位）：无调用链，只报 id 与输入能力；
      // 能力优先 config 覆盖，其次 models.dev（modalities.input，与定价同源），缺省 text
      if (p.monitor) {
        return { id: m, modalities: p.modelDefs?.[m] ?? pricing?.modalitiesFor?.(m) ?? ['text'], monitor: true };
      }
      const chain = buildChain(catalog, m);
      const idx = chain.findIndex((c) => c.id === p.id);
      const fallbacks = chain.slice(idx + 1).map((c) => ({ providerId: c.id, provider: providerDisplayName(c), model: upstreamModel(c, m) }));
      const sample = lastSuccess?.get(m);
      const active = sample && Date.now() - Date.parse(sample.at) < SUCCESS_SAMPLE_TTL_MS &&
        chain.some((c) => c.id === sample.providerId && upstreamModel(c, m) === sample.model)
        ? sample : null;
      return {
        id: m,
        modalities: p.modelDefs?.[m] ?? ['text'],
        chainIndex: idx,
        fallbacks,
        chain: chain.map((c) => ({ providerId: c.id, provider: providerDisplayName(c), model: upstreamModel(c, m) })),
        active,
        expected: orderChainByQuota(chain, quotaSnap, { breaker })[0]?.id ?? null,
      };
    });

    // provider 级备用链：各模型 fallback 链展开成 厂商·模型 对（去重；监控位无 fallbacks）
    const fallbacks = [];
    const seen = new Set();
    for (const m of models) {
      for (const f of m.fallbacks ?? []) {
        const key = `${f.provider}/${f.model}`;
        if (!seen.has(key)) {
          seen.add(key);
          fallbacks.push(f);
        }
      }
    }

    let healthy = true;
    let statusReason = null;
    // display-only 伪 provider（向量端点展示位）自带静态健康口径（凭据解析结果）；
    // 真实 provider 仍以 registry 快照为准（后者覆盖）
    if (typeof p.healthy === 'boolean') {
      healthy = p.healthy;
      statusReason = p.statusReason ?? null;
    }
    const reg = regSnap[p.id];
    if (reg && typeof reg.healthy === 'boolean') {
      healthy = reg.healthy;
      statusReason = reg.reason ?? null;
    }

    const q = quotaSnap[p.id];
    let quota = null;
    if (q && q.ok && q.tiers) {
      // GLM monitor / codex usage / claude oauth usage — all produce tiers (fiveHour/weekly).
      quota = {
        fiveHour: dashTier(q.tiers.fiveHour),
        weekly: dashTier(q.tiers.weekly),
        // claude 周额度分模型明细（scoped 窗口；无则不出现）
        ...(Array.isArray(q.tiers.weeklyModels) && q.tiers.weeklyModels.length
          ? { weeklyModels: q.tiers.weeklyModels }
          : {}),
        stale: q.stale === true,
        fetchedAt: q.fetchedAt ?? null,
        level: q.level ?? null,
      };
    } else if (q && q.ok && q.balance) {
      // DeepSeek prepaid balance (or any probe with a balance payload).
      quota = {
        balance: q.balance,
        isAvailable: q.isAvailable ?? null,
        stale: q.stale === true,
        fetchedAt: q.fetchedAt ?? null,
      };
    }

    // 套餐标签展示口径（前端直接渲染，不再拼装）：订阅档位优先（lite/pro/plus →
    // 首字母大写，不带厂商前缀）；否则 badge 取「·」分段末段
    // （"Coding Plan · Lite" → "Lite"）；无分段的按量计费类 badge 原样透传。
    const plan = quota?.level
      ? quota.level[0].toUpperCase() + quota.level.slice(1)
      : (typeof p.badge === 'string' && p.badge.includes('·') ? p.badge.split('·').pop().trim() : p.badge ?? null);

    return {
      id: p.id,
      displayName: providerDisplayName(p),
      type: p.type,
      monitor: p.monitor === true,
      badge: p.badge ?? null,
      plan,
      ...(p.desc ? { desc: p.desc } : {}),
      healthy,
      statusReason,
      // 健康依据：有凭据验证记录 → credentials；否则配置静态判定 → configuration（不再上报 unknown）
      healthBasis: reg && typeof reg.healthy === 'boolean' ? 'credentials' : 'configuration',
      probe: {
        supported: quotaStore?.probeIds?.().includes(p.id) ?? Object.hasOwn(quotaSnap, p.id),
        ok: q?.ok === true,
        stale: q?.stale === true,
        fetchedAt: q?.fetchedAt ?? null,
        lastError: dashboardError(q?.lastError),
        lastErrorAt: q?.lastErrorAt ?? null,
      },
      // 百炼展示位：维度信息在模型行渲染（卡片主体只保留 desc）
      ...(p.type === 'dashscope' && p.defaultDimensions ? { defaultDimensions: p.defaultDimensions } : {}),
      // monitor 位但流量经网关（/v1/embeddings）：拓扑卡需要这条标记来连线
      ...(p.routable === true ? { routable: true } : {}),
      models,
      fallbacks,
      quota,
      // codex-reset.com 全局重置预测（未注入/拉取失败也是显式字段，前端自渲染）
      ...(p.type === 'codex' && fcSnap ? { resetForecast: fcSnap } : {}),
      circuit: circuitSnap ? (circuitSnap[p.id] ?? { providerId: p.id, phase: 'closed', failures: 0 }) : null,
      // ⚡ 联动：未注入 activator → null（前端退回不渲染）；snapshot 缺该 provider → active:false
      activation: actSnap ? { active: actSnap[p.id]?.active === true } : null,
      // claude token 哨兵可观测（未注入/非 claude → 不出现）：排障 401 空窗时看这里
      ...(p.type === 'claude' && actSnap?.[p.id]?.tokenRefresh ? { tokenRefresh: actSnap[p.id].tokenRefresh } : {}),
    };
  });

  // 今日接力切换次数：额度降级（智谱用完切智谱2 这类）+ 请求级 fallback。
  // 不能只靠 events 列表（默认 30 条，会被 vision_placeholder 等高频事件冲掉）
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const todayCount = (t) => events.list({ type: t, limit: 500 }).filter((e) => new Date(e.ts).valueOf() >= dayStart.valueOf()).length;

  return {
    providers,
    events: events.list({ limit: eventsTake }),
    fallbacksToday: todayCount('quota_demoted') + todayCount('fallback'),
    ...(mgSnap ? { features: { modelGuard: mgSnap } } : {}),
  };
}
