// pricing.js — 定价查询：models.dev 原始条目（FAMILIES 跟踪的 provider 全量，含无版本别名）
// + 计价专用补充 provider + config pricing 覆盖。与 model-guard 同源（同一 api.json），
// 但不走 classifyModel 版本过滤——比价视图只收带版本号条目，计价需要覆盖 deepseek-flash 等无版本别名。
// 同时捕获模型输入能力（modalities.input）与模型类型（info.type，如
// 'image'）：监控位（claude 订阅）展示用前者；后者用于计价口径 —— 图像模型
// 按张计价、无 token 价格，属于「非 token 计费」而非「缺定价」，两者都不在
// 代码里硬编码。模型名称与属性的单一权威 = models.dev（AGENTS.md 约定），
// 无效名称的校验/过滤见 router.js pricingMissing。
// claude 只做用量折价（Claude Code 会话日志同步的记录），不参与 model-guard
// 版本阶梯比对，故不进 FAMILIES、在此单列数据源。
// 成本在查询时计算（不落盘），定价更新对历史记录追溯生效。
// 价格单位 $/Mtok（与 models.dev / config.pricing 一致）。

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { FAMILIES, MODELS_DEV_URL } from '../ops/jobs/model-guard.js';

const REFRESH_MS = 24 * 60 * 60 * 1000;
// 拉取失败后的快速重试间隔（主定时器仍是 24h）：2026-10-30 事故 —— 启动时
// models.dev 瞬时不可达，空名录剔掉了几乎全部展示模型，而下次重试要等 24h。
const RETRY_MS = 10 * 60 * 1000;

// 计价专用补充 provider：FAMILIES 之外、只取价格不做升级守护的 models.dev provider。
const EXTRA_PRICING_PROVIDERS = ['anthropic'];

/** 伪模型 id（非真实可计费模型）：形如 "<synthetic>" 的尖括号占位符 ——
 *  Claude Code 会话日志里 CLI 合成消息的 model 字段，经 claude-usage-sync
 *  透传进用量记录。不是定价缺口，统计口径一律过滤。 */
export function isPseudoModelId(id) {
  return typeof id === 'string' && /^<.+>$/.test(id);
}

export class PricingStore {
  constructor({
    url = process.env.MODELS_DEV_URL ?? MODELS_DEV_URL,
    overrides = {},
    fetchFn = globalThis.fetch,
    intervalMs = REFRESH_MS,
    cacheFile = null,
  } = {}) {
    this.url = url;
    this.fetchFn = fetchFn;
    this.intervalMs = intervalMs;
    this.cacheFile = cacheFile;
    this.overrides = normalizeOverrides(overrides);
    this.byModel = new Map(); // models.dev 精确条目：model id → {input,output,cacheRead,cacheWrite}
    this.names = new Map(); // models.dev 展示名：model id → 'Claude Sonnet 4.5'（全局标准名称单一权威）
    this.modalities = new Map(); // models.dev modalities.input：model id → ['text','image','pdf'...]
    this.types = new Map(); // models.dev info.type：model id → 'chat'|'image'|...（全量收录，含无价条目）
    this.fetchedAt = null;
    this.lastError = null;
    this.ready = Promise.resolve();
    this._timer = null;
    this._retryTimer = null;
    this._refreshing = false;
    this.#loadCache(); // 落盘快照优先：重启 + 上游瞬时故障不再清空名录（仅内存态的缺口）
  }

  /** 启动：立即拉取一次（失败不致命，24h 后重试），并按 interval 定期刷新。
   *  ready 是首次拉取的 Promise，测试/需要定价就绪时可 await。*/
  start() {
    this.ready = this.#refresh();
    this._timer = setInterval(() => this.#refresh(), this.intervalMs);
    this._timer.unref();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._timer = null;
    this._retryTimer = null;
  }

  /** 启动时加载落盘快照（存在则填充四张表 + fetchedAt）。只影响冷启动：
   * 首次 refresh 成功后内存与磁盘都被新数据覆盖；损坏/不存在 → 静默冷启动。 */
  #loadCache() {
    if (!this.cacheFile) return;
    try {
      const j = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
      if (!j || typeof j !== 'object') return;
      const asMap = (v) => new Map(Array.isArray(v) ? v : Object.entries(v ?? {}));
      this.byModel = asMap(j.byModel);
      this.names = asMap(j.names);
      this.modalities = asMap(j.modalities);
      this.types = asMap(j.types);
      if (typeof j.fetchedAt === 'string' && j.fetchedAt) this.fetchedAt = j.fetchedAt;
      console.log(`[usage] pricing cache loaded: ${this.byModel.size} models from ${this.cacheFile}`);
    } catch { /* 无缓存/损坏 → 冷启动 */ }
  }

  /** 成功刷新后原子落盘（tmp + rename），失败不致命。 */
  #persist() {
    if (!this.cacheFile) return;
    try {
      const tmp = this.cacheFile + '.tmp';
      writeFileSync(tmp, JSON.stringify({
        fetchedAt: this.fetchedAt,
        byModel: [...this.byModel],
        names: [...this.names],
        modalities: [...this.modalities],
        types: [...this.types],
      }));
      renameSync(tmp, this.cacheFile);
    } catch (err) {
      console.error(`[usage] pricing cache write failed: ${err.message}`);
    }
  }

  async #refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const res = await this.fetchFn(this.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const apiJson = await res.json();
      const flat = new Map();
      const mods = new Map();
      const types = new Map();
      const names = new Map();
      // FAMILIES 跟踪的 provider + 计价专用补充 provider 直取原始 models：
      // 带 cost 的条目全收，不做版本/档次归类（deepseek-flash 等别名也是真实计价对象）。
      const provIds = new Set([...Object.values(FAMILIES).map((c) => c.modelsdev), ...EXTRA_PRICING_PROVIDERS]);
      for (const provId of provIds) {
        const models = apiJson?.[provId]?.models ?? {};
        for (const [mid, info] of Object.entries(models)) {
          // 输入能力与计费独立：无价条目也可能带 modalities
          const inputMods = info?.modalities?.input;
          if (Array.isArray(inputMods) && inputMods.length) mods.set(mid, inputMods.slice());
          // 模型类型全量收录（无价图像模型也要可识别为「按张计费」）
          if (typeof info?.type === 'string' && info.type) types.set(mid, info.type);
          // 展示名全量收录（与类型同口径：无价条目也要能叫出名字）
          if (typeof info?.name === 'string' && info.name) names.set(mid, info.name);
          const cost = info?.cost ?? {};
          if (!cost.input && !cost.output) continue; // 无 token 计费信息（如按张计价的图像模型）
          flat.set(mid, {
            input: cost.input || 0,
            output: cost.output || 0,
            cacheRead: cost.cache_read || 0,
            cacheWrite: cost.cache_write || 0,
          });
        }
      }
      this.byModel = flat;
      this.modalities = mods;
      this.types = types;
      this.names = names;
      this.fetchedAt = new Date().toISOString();
      this.lastError = null;
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      this.#persist();
      console.log(`[usage] pricing loaded: ${flat.size} models from ${this.url}`);
    } catch (err) {
      this.lastError = err.message;
      console.error(`[usage] pricing refresh failed: ${err.message}`);
      // 失败快速重试（不等下一个 24h 周期）；有落盘快照时展示不受影响，仅数据变陈旧
      if (!this._retryTimer) {
        this._retryTimer = setTimeout(() => { this._retryTimer = null; this.#refresh(); }, RETRY_MS);
        this._retryTimer.unref();
      }
    } finally {
      this._refreshing = false;
    }
  }

  /** 模型定价：config 覆盖优先，其次 models.dev（先 upstream 实际模型，再请求模型）。 */
  costFor(model, upstreamModel = model) {
    return this.overrides.get(upstreamModel)
      ?? this.overrides.get(model)
      ?? this.byModel.get(upstreamModel)
      ?? this.byModel.get(model)
      ?? null;
  }

  /** usage 四元组 → 美元成本；无定价返回 null。 */
  costOf(usage, model, upstreamModel = model) {
    if (!usage) return null;
    const p = this.costFor(model, upstreamModel);
    if (!p) return null;
    const cost = usage.input * p.input + usage.output * p.output
      + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite;
    return round6(cost / 1e6);
  }

  /** 模型标准展示名（models.dev name）；未收录返回 null。前端全局模型名称的单一数据源。 */
  nameFor(model) {
    return this.names.get(model) ?? null;
  }

  /** 全量展示名快照（id → name 普通对象），一次性下发给前端。 */
  namesSnapshot() {
    return Object.fromEntries(this.names);
  }

  /** 模型输入能力（models.dev modalities.input，如 ['text','image','pdf']）；未收录返回 null。 */
  modalitiesFor(model) {
    return this.modalities.get(model) ?? null;
  }

  /** 模型类型（models.dev info.type，如 'chat'/'image'）；未收录返回 null。
   *  消费方：pricingMissing 口径（image = 按张计价，不算缺 token 定价）、
   *  imageGeneration.model 配置守卫（应为 'image'）。 */
  typeFor(model) {
    return this.types.get(model) ?? null;
  }
}

/** config pricing 覆盖归一化：{modelId: {input,output,cacheRead,cacheWrite}}（$/Mtok，缺项 0）。 */
export function normalizeOverrides(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object') return out;
  for (const [mid, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    out.set(mid, {
      input: num(p.input), output: num(p.output),
      cacheRead: num(p.cacheRead), cacheWrite: num(p.cacheWrite),
    });
  }
  return out;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}
