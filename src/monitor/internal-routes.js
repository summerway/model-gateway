// internal-routes.js — monitor 层内部端点：/internal/usage（聚合查询）、/internal/usage/daily
// （日聚合，可选 groupBy 维度合并）、/internal/usage/activity（热力图与连续天数统计）、
// /internal/usage/devices（采集设备状态）、/internal/keys（应用密钥状态与今日用量）、
// /internal/usage/observed（Mac 采集器推送的 Codex / Claude Code 本地订阅用量；
// /internal/usage/codex 为兼容别名）。

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NOT_HANDLED, extractKey, isInternalRequest, readBody, sendJson } from '../http.js';
import { resolveRef, providerDisplayName } from '../config.js';
import { isCodexClient } from './codex-local.js';
import { sourceById } from './sources/index.js';
import { validateSchema } from '../config-schema.js';
import { isPseudoModelId } from './pricing.js';
import { UNMARKED_CLIENT, localDay, normalizeClient } from './store.js';

/** usage 明细分页白名单 50/100/200；白名单外回退默认。 */
const LOG_LIMITS = [50, 100, 200];
const observedSchema = JSON.parse(readFileSync(new URL('../../docs/schemas/observed-event.json', import.meta.url), 'utf8'));

/** /internal/usage/daily 的 groupBy 维度 → 日聚合行字段（provider 参数对应行的 providerId）。 */
const GROUP_DIMS = { day: 'day', kind: 'kind', client: 'client', provider: 'providerId', model: 'model', device: 'device' };

/** 渠道归并口径：OpenAI（codex）= 经网关流量 + codex-local 订阅直连流量（Claude 的
 * observed 本就记 provider_id=claude，无此拆分）；其余 provider 原样返回，无筛选 → null。 */
function providerScope(provider) {
  if (!provider) return null;
  return provider === 'codex' ? ['codex', 'codex-local'] : provider;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** 本地日历日加减 n 天（Date 日历运算，跨夏令时不漂移；与 localDay 同口径）。 */
function addLocalDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localDay(dt.getTime());
}

/** 统计时间窗：today/yday 按小时桶，7d/30d 按天桶（本地时区）。导出供测试。 */
export function rangeToWindow(range, now = new Date()) {
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  // 24h 滚动窗口（日志›请求明细）：跨零点不断档，区别于 today 的自然日口径
  if (range === '24h') return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: now, unit: 'hour' };
  if (range === 'yday') {
    const to = startOfDay(now);
    return { from: new Date(to.getTime() - 24 * 60 * 60 * 1000), to, unit: 'hour' };
  }
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30;
    return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now, unit: 'day' };
  }
  return { from: startOfDay(now), to: now, unit: 'hour' }; // today（默认）
}

/**
 * @param {object} ctx — { config, catalog, displayCatalog, usageLog, pricing, keyStates, keyApps, agentEndpoints? }
 */
export function createMonitorRoutes(ctx) {
  const { config, catalog, displayCatalog, usageLog, pricing, keyStates, keyApps } = ctx;
  // Agent 映射（distribution.json）；未注入 → 空映射 + 未配置
  const agentSnap = () => ctx.agentEndpoints?.snapshot() ?? { agents: [], source: { configured: false, loadedAt: null, stale: false, error: null } };
  const usageCache = new Map();
  let cachedCatalog = catalog.providers;
  return async function monitorRoute(req, res, url, path) {
    if (path === '/internal/usage/observed' || path === '/internal/usage/codex') {
      if (req.method !== 'POST') return sendJson(res,405,{error:'method not allowed'});
      if (!isInternalRequest(req)) return sendJson(res,403,{error:'internal only'});
      const receiver = config.observedUsage ?? config.codexUsage;
      if (!receiver?.enabled || !usageLog) return sendJson(res,404,{error:'订阅用量接收未启用'});
      let boundDevice = req.mgDevice;
      if (req.mgAuthorized !== true && boundDevice === undefined) {
        const actual = extractKey(req);
        const digest = v => createHash('sha256').update(v).digest();
        const matches = (ref) => {
          const expected = resolveRef(ref);
          return expected && actual && timingSafeEqual(digest(expected), digest(actual));
        };
        const device = receiver.devices?.find((entry) => matches(entry.keyRef));
        if (!device && !matches(receiver.apiKeyRef)) return sendJson(res,401,{error:'unauthorized'});
        boundDevice = device?.name;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) return sendJson(res,415,{error:'expected application/json'});
      // 批次仍使用各来源的旧格式；/internal/usage/codex 固定 source=codex。
      let rows;
      try {
        const body = JSON.parse(await readBody(req,512*1024));
        const source = sourceById(path === '/internal/usage/codex' ? 'codex' : body?.source);
        if (!source) return sendJson(res,400,{error:'unknown_source'});
        const device = boundDevice ?? body?.device ?? 'mac';
        if (typeof device !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(device)) throw new Error('device');
        rows = source.validateBatch(body, { now: Date.now(), device }).map((row) => ({ ...row, device }));
        if (rows.some((row) => validateSchema(observedSchema, row).length)) throw new Error('schema');
      } catch { return sendJson(res,400,{error:'无效的用量批次'}); }
      try { const imported = usageLog.importSubscription(rows); return sendJson(res,200,{accepted:rows.length,imported}); }
      catch { return sendJson(res,503,{error:'用量持久化失败，请稍后重试'}); }
    }
    if (path === '/internal/keys' && req.method === 'GET') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      const clients = groupCodexClients(usageLog?.queryClients(rangeToWindow('today')) ?? []);
      const byClient = new Map(clients.map((c) => [c.client, c]));
      const apps = new Set(keyApps());
      const { agents, source } = agentSnap();
      const agentOf = new Map(agents.map((a) => [a.app, a]));
      return sendJson(res, 200, {
        agents,
        agentSource: source,
        topology: {
          appGroups: (config.topology?.appGroups ?? []).map(({ id, label, icon, apps }) => ({ id, label, ...(icon === undefined ? {} : { icon }), apps })),
          collectors: (config.topology?.collectors ?? []).map(({ id, label }) => ({ id, label })),
          directConnections: (config.topology?.directConnections ?? []).map(({ app, device, providerId, collectorId }) => ({ app, device, providerId, ...(collectorId === undefined ? {} : { collectorId }) })),
        },
        keys: keyStates.map((k) => ({
          ...k, agent: agentOf.get(k.app) ?? null, lastSeen: byClient.get(k.app)?.lastSeen ?? null,
          today: byClient.get(k.app)?.today ?? { requests: 0, tokens: 0 },
        })),
        extraClients: clients.filter((c) => !apps.has(c.client)).map((c) => ({
          client: c.client, lastSeen: c.lastSeen, today: c.today,
        })),
      });
    }
/** 展示口径判定（models.dev 为模型唯一权威）：名录内 / image 型（按张计价）/ 可计价的模型
 *  才进展示位与筛选选项；伪 id（<synthetic>）与未收录 id（拼写错误/已下架，如误配期的
 *  gpt-image-1.5）剔除。pricing 缺失或无 namesSnapshot（旧版/测试桩）时不过滤。 */
function displayModelFilter(pricing) {
  const names = pricing?.namesSnapshot?.();
  // 空名录（启动拉取失败且无缓存）同样不过滤：2026-10-30 事故 —— 空对象 truthy
  // 穿过 !names 守卫，几乎全部模型被判「未收录」从展示位剔除，只剩 config 覆盖定价的一个
  if (!names || !Object.keys(names).length) return () => true;
  return (m) => m == null || (!isPseudoModelId(m) && (names[m] != null || pricing.typeFor?.(m) === 'image' || !!pricing.costFor(m, m)));
}
// 日聚合（长期保留）：from/to 本地日期 YYYY-MM-DD（缺省最近 370 天，含今天）；
    // 维度筛选 kind/client/provider/model/device；每行附按当前定价折算的 cost（未知定价 null）。
    // 可选 groupBy=day,kind,client,provider,model,device（逗号分隔子集，未知值 400）：按所选维度
    // 合并原始日聚合行——records/requests/usage 相加；cost 先按行折算再只累加已知定价部分，
    // 未知行的 records 计入 costUnknownRecords。返回行只含所选维度字段（字段名与 groupBy 值
    // 同名，provider 即行的 providerId）+ records/requests/usage/tokens/cost/costUnknownRecords，
    // tokens = input+output+cacheRead+cacheWrite；按 day（如有）升序，其次 tokens 降序。
    // 不给 groupBy → 原始行原样返回（向后兼容）。
    if (path === '/internal/usage/daily' && req.method === 'GET') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      if (!usageLog?.queryDaily) return sendJson(res, 200, { enabled: false });
      const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? v : null);
      const nowMs = Date.now();
      const to = day(url.searchParams.get('to')) ?? localDay(nowMs);
      const from = day(url.searchParams.get('from')) ?? localDay(nowMs - 369 * 24 * 60 * 60 * 1000);
      if (from > to) return sendJson(res, 400, { error: 'from 晚于 to' });
      const p = (k) => url.searchParams.get(k) || null;
      const rows = usageLog.queryDaily({ from, to, kind: p('kind'), client: p('client'), provider: providerScope(p('provider')), model: p('model'), device: p('device') });
      const costOf = pricing ? (r) => pricing.costOf(r.usage, r.model, r.upstreamModel) : () => null;
      // 展示口径：未收录 id（如误配期的 gpt-image-1.5）与伪 id 不进任何展示位；
      // 可计价或 image 型（按张计价）保留；真异常仍由 /internal/usage 的 pricingMissing 上报。
      const modelOk = displayModelFilter(pricing);
      const shown = rows.filter((r) => modelOk(r.model)); // 注意：谓词接模型 id，不是整行
      const groupByRaw = url.searchParams.get('groupBy');
      if (groupByRaw !== null) {
        const dims = [...new Set(groupByRaw.split(','))];
        if (dims.some((d) => !GROUP_DIMS[d])) return sendJson(res, 400, { error: '未知的 groupBy 维度' });
        const merged = mergeDailyBy(shown, dims, costOf);
        // 模型维度：零 token 行（纯失败请求，如误配期 gpt-image-1.5 的两次 403）不进用量展示
        const rowsOut = dims.includes('model') ? merged.filter((r) => (r.tokens ?? 0) > 0) : merged;
        return sendJson(res, 200, { from, to, rows: rowsOut }, { 'cache-control': 'no-store' });
      }
      return sendJson(res, 200, { from, to, rows: shown.map((r) => ({ ...r, cost: costOf(r) })) }, { 'cache-control': 'no-store' });
    }
    // Activity（热力图与统计卡）：与 daily 相同的日期窗口默认与维度筛选。响应：
    //   { from, to, days:[{ day, tokens, cost, requests, records }], stats }
    // days 只含有记录（records>0）的日期、升序；stats = { activeDays（tokens>0 天数）,
    //   currentStreak（从 to 往回数，to 当天还没用量时从前一天起算——今天尚未开始不算中断）,
    //   longestStreak, peakDay:{day,tokens}|null, totalTokens, totalCost }；连续天数按本地
    // 日历日计算、以 tokens>0 为活跃；cost 只累加已知定价部分。
    if (path === '/internal/usage/activity' && req.method === 'GET') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      if (!usageLog?.queryDaily) return sendJson(res, 200, { enabled: false });
      const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? v : null);
      const nowMs = Date.now();
      const to = day(url.searchParams.get('to')) ?? localDay(nowMs);
      const from = day(url.searchParams.get('from')) ?? localDay(nowMs - 369 * 24 * 60 * 60 * 1000);
      if (from > to) return sendJson(res, 400, { error: 'from 晚于 to' });
      const p = (k) => url.searchParams.get(k) || null;
      const rows = usageLog.queryDaily({ from, to, kind: p('kind'), client: p('client'), provider: providerScope(p('provider')), model: p('model'), device: p('device') });
      const costOf = pricing ? (r) => pricing.costOf(r.usage, r.model, r.upstreamModel) : () => null;
      return sendJson(res, 200, activityResponse(from, to, rows, costOf), { 'cache-control': 'no-store' });
    }
    // 设备状态条：每采集设备最近一条数据的时间 + 近 7 天记录数（store.queryDevices）。
    // 响应：{ devices: [{ device, kind, lastSeen, records7d }] }，按 lastSeen 降序。
    if (path === '/internal/usage/devices' && req.method === 'GET') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      if (!usageLog?.queryDevices) return sendJson(res, 200, { enabled: false });
      return sendJson(res, 200, { devices: usageLog.queryDevices() }, { 'cache-control': 'no-store' });
    }
    if (path === '/internal/usage') {
      if (!isInternalRequest(req)) return sendJson(res, 403, { error: 'forbidden: internal only' });
      if (!usageLog) return sendJson(res, 200, { enabled: false });
      const provider = url.searchParams.get('provider') || null;
      const providers = providerScope(provider);
      const model = url.searchParams.get('model') || null;
      const client = url.searchParams.get('client') || null;
      // kind 白名单：served（经网关）/ observed（订阅旁观导入）；其余值 = 全部
      const kind = ['served', 'observed'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : null;
      // status 白名单：仅 'abort'（客户端中断明细筛选），其余值忽略
      const status = url.searchParams.get('status') === 'abort' ? 'abort' : null;
      const range = url.searchParams.get('range') ?? 'today';
      const logLimitRaw = Number(url.searchParams.get('logLimit'));
      const logLimit = LOG_LIMITS.includes(logLimitRaw) ? logLimitRaw : 50;
      const { from, to, unit } = rangeToWindow(range);
      if (cachedCatalog !== catalog.providers) { usageCache.clear(); cachedCatalog = catalog.providers; }
      const cacheKey = JSON.stringify([usageLog.revision,pricing?.fetchedAt,provider,model,client,kind,status,range,logLimit,new Date(from).toDateString()]);
      const cached = usageCache.get(cacheKey);
      if (typeof usageLog.revision === 'number' && cached && cached.until > Date.now()) return sendUsageJson(res,cached.body);
      const priceOf = pricing ? (r) => pricing.costOf(r.usage, r.model, r.upstreamModel) : () => null;
      const data = usageLog.query({ provider: providers, model, client, kind, status, from, to, unit, logLimit, priceOf });
      // 来源分布：每调用方当日/累计汇总 + 窗口趋势桶（旧 UsageLog 无此方法 → null，页面降级隐藏）
      const clients = typeof usageLog.queryClients === 'function'
        ? usageLog.queryClients({ provider: providers, model, from, to, unit }) : null;
      // 无效名称过滤（models.dev 为名称/属性唯一权威）：①尖括号伪 id（如
      // <synthetic>，Claude Code 合成消息透传）一律剔除；②models.dev 已收录但
      // type:image（按张计价，无 token 价格）不算「缺定价」。两者之外的未收录
      // id（拼写错误/已下架/目录漂移）仍保留上报 —— 那才是真异常。
      const pricingMissing = pricing
        ? [...new Set(data.models)]
            .filter((m) => !isPseudoModelId(m))
            .filter((m) => pricing.typeFor?.(m) !== 'image')
            .filter((m) => !pricing.costFor(m, m))
        : [];
      // ── 联动筛选 ──
      // ① kind 选定 → 渠道下拉只列窗口内该 kind 有记录的渠道（订阅直连 → OpenAI/Claude；
      // 窗口无记录时回退全量，避免下拉被清空）；OpenAI（codex）按归并口径含 codex-local。
      // ② provider 选定 → 模型下拉只列该渠道模型（目录模型 ∪ 窗口实际出现）。
      const dailyRows = typeof usageLog.queryDaily === 'function'
        ? usageLog.queryDaily({ from: localDay(Date.now() - 29 * 864e5), to: localDay(Date.now()), kind }) : [];
      // 有真实用量的模型（近 30 天，tokens>0）：失败/零 token 请求的模型（如误配期
      // gpt-image-1.5 的两次 403）不进模型下拉；窗口无任何用量时回退全量
      const hasTok = (u) => u && (u.input || u.output || u.cacheRead || u.cacheWrite);
      const usedModels = dailyRows.some((r) => hasTok(r.usage))
        ? new Set(dailyRows.filter((r) => hasTok(r.usage)).map((r) => r.upstreamModel ?? r.model)) : null;
      const modelsAll = new Set(
        data.models
          .filter(displayModelFilter(pricing)) // 未收录 id 不进选项
          .filter((m) => !usedModels || usedModels.has(m)), // 纯失败请求的模型也不进选项
      );
      // 模型筛选下拉：路由目录 + 展示位（claude 监控位模型有直连用量记录；dashscope
      // 向量请求按 providerId=dashscope 落账，筛选器同源展示）
      for (const p of displayCatalog().providers) for (const m of p.models) modelsAll.add(m);
      const provModels = new Map(); // providerId -> Set(model)：窗口内该 kind 出现过的模型
      for (const r of dailyRows) {
        if (!r.providerId || !r.records) continue;
        if (!provModels.has(r.providerId)) provModels.set(r.providerId, new Set());
        if (r.model && (!usedModels || usedModels.has(r.model))) provModels.get(r.providerId).add(r.model);
      }
      const catList = displayCatalog().providers;
      // 渠道下拉不列 codex-local 伪渠道：选「OpenAI」即按归并口径（codex + codex-local）统计；
      // 要隔离本地会话用「来源」筛选（codex-local-app 等）。
      let providerOptions = catList.map((p) => ({ id: p.id, name: providerDisplayName(p) }));
      if (kind && provModels.size) {
        // kind 限定：渠道仅需窗口内有该 kind 记录（OpenAI 按 codex ∨ codex-local 判定）
        providerOptions = providerOptions.filter((o) => o.id === 'codex'
          ? (provModels.has('codex') || provModels.has('codex-local'))
          : provModels.has(o.id));
      }
      let modelOptions = [...modelsAll].filter(displayModelFilter(pricing)); // 目录声明的未收录 id 同样不进选项
      if (provider && provModels.size) {
        const scope = provider === 'codex' ? ['codex', 'codex-local'] : [provider];
        const set = new Set();
        for (const pid of scope) {
          for (const m of provModels.get(pid) ?? []) set.add(m);
          const cat = catList.find((p) => p.id === pid);
          if (cat) for (const m of cat.models) set.add(m);
        }
        modelOptions = [...set].filter(displayModelFilter(pricing));
      }
      // 来源(client) 下拉：配置声明的 app ∪ 观测到的来源；历史无 client 行 → 哨兵选项。
      // 用 totalAll（全保留期）而非窗口 total，保证切换时间筛选时下拉项稳定
      const observed = (clients ?? [])
        .filter((c) => c.totalAll?.requests > 0 || c.totalAll?.usageOnly)
        .map((c) => (c.client ? normalizeClient(c.client) : UNMARKED_CLIENT));
      const clientOptions = [...new Set([...keyApps(), ...observed])].sort();
      const response = {
        range, unit, from: from.toISOString(), to: to.toISOString(),
        filters: {
          providers: providerOptions,
        models: modelOptions.map((m) => ({ id: m, name: pricing?.nameFor?.(m) ?? m })),
          clients: clientOptions,
        },
        clients: !isCodexClient(client) ? groupCodexClients(clients) : clients,
        pricingMissing,
        pricingFetchedAt: pricing?.fetchedAt ?? null,
        // 全局模型标准展示名（models.dev name）：前端所有展示位单点取用，避免各处自行拼装
        modelNames: pricing?.namesSnapshot?.() ?? null, // 测试桩/旧版可能不带 namesSnapshot
        agents: agentSnap().agents,
        ...data,
      };
      const body = JSON.stringify(response);
      // Bounded serialized snapshots: at most 16 × 128 KiB, no retained object graph.
      if (typeof usageLog.revision === 'number' && Buffer.byteLength(body) <= 128*1024) {
        if (usageCache.size >= 16) usageCache.delete(usageCache.keys().next().value);
        usageCache.set(cacheKey,{body,until:Date.now()+5000});
      }
      return sendUsageJson(res,body);
    }
    return NOT_HANDLED;
  };
}

/** /internal/usage/daily?groupBy=：按所选维度合并日聚合行（cost 先按行折算，只累加已知部分）。 */
function mergeDailyBy(rows, dims, costOf) {
  const groups = new Map(); // 维度值 JSON → 合并行
  for (const r of rows) {
    const key = JSON.stringify(dims.map((d) => r[GROUP_DIMS[d]]));
    let g = groups.get(key);
    if (!g) {
      g = {
        ...Object.fromEntries(dims.map((d) => [d, r[GROUP_DIMS[d]]])),
        records: 0, requests: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0, costUnknownRecords: 0,
      };
      groups.set(key, g);
    }
    g.records += r.records;
    g.requests += r.requests;
    g.usage.input += r.usage.input;
    g.usage.output += r.usage.output;
    g.usage.cacheRead += r.usage.cacheRead;
    g.usage.cacheWrite += r.usage.cacheWrite;
    const c = costOf(r);
    if (typeof c === 'number') g.cost += c;
    else g.costUnknownRecords += r.records; // 未知定价行的 records 数
  }
  const byDay = dims.includes('day') ? (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) : () => 0;
  return [...groups.values()]
    .map((g) => ({
      ...g,
      tokens: g.usage.input + g.usage.output + g.usage.cacheRead + g.usage.cacheWrite,
      cost: round6(g.cost),
    }))
    .sort((a, b) => byDay(a, b) || b.tokens - a.tokens);
}

/** /internal/usage/activity 响应：按日合并 + activeDays / 连续天数（本地日历日，tokens>0 为活跃）/ 峰值日。 */
function activityResponse(from, to, rows, costOf) {
  const byDay = new Map();
  for (const r of rows) {
    let d = byDay.get(r.day);
    if (!d) { d = { day: r.day, tokens: 0, cost: 0, requests: 0, records: 0 }; byDay.set(r.day, d); }
    d.tokens += r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
    d.requests += r.requests;
    d.records += r.records;
    const c = costOf(r);
    if (typeof c === 'number') d.cost += c;
  }
  const days = [...byDay.values()]
    .filter((d) => d.records > 0)
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((d) => ({ ...d, cost: round6(d.cost) }));
  const active = days.filter((d) => d.tokens > 0);
  const activeSet = new Set(active.map((d) => d.day));
  let longest = 0, run = 0, prev = null;
  for (const d of active) {
    run = prev !== null && addLocalDays(prev, 1) === d.day ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d.day;
  }
  // 从 to 往回数；to 当天还没用量 → 从前一天开始（今天尚未开始不算中断）
  let cursor = activeSet.has(to) ? to : addLocalDays(to, -1);
  let current = 0;
  while (activeSet.has(cursor)) { current++; cursor = addLocalDays(cursor, -1); }
  const peak = active.reduce((best, d) => (!best || d.tokens > best.tokens ? d : best), null);
  return {
    from, to, days,
    stats: {
      activeDays: active.length,
      currentStreak: current,
      longestStreak: longest,
      peakDay: peak ? { day: peak.day, tokens: peak.tokens } : null,
      totalTokens: days.reduce((a, d) => a + d.tokens, 0),
      totalCost: round6(days.reduce((a, d) => a + d.cost, 0)),
    },
  };
}

function groupCodexClients(clients) {
  if (!clients) return clients;
  const local = clients.filter(c => isCodexClient(c.client));
  if (!local.length) return clients;
  const group = structuredClone(local[0]); group.client = 'codex-local';
  for (const c of local.slice(1)) {
    if (Date.parse(c.lastSeen) > Date.parse(group.lastSeen)) group.lastSeen = c.lastSeen;
    for (const key of ['today','total','totalAll']) { group[key].tokens += c[key].tokens; group[key].requests += c[key].requests; }
    for (let i = 0; i < group.buckets.length; i++) { group.buckets[i].tokens += c.buckets[i]?.tokens ?? 0; group.buckets[i].requests += c.buckets[i]?.requests ?? 0; }
  }
  return [...clients.filter(c => !isCodexClient(c.client)),group];
}

function sendUsageJson(res,body) {
  res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body),'cache-control':'no-store'});
  return res.end(body);
}
