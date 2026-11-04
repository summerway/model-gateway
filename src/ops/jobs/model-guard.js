/**
 * model-guard.js — 模型自动升级守护（网关内置 Job 3）。
 *
 * 移植自 pi-agent 的 model_upgrade_guard.py（决策核心对齐，
 * 落地架构塌缩为“只改网关 config 一处”）：
 *
 *   生产：发现 → 比价建议 → 退役检测 → 持久化 Inbox → 人工决定 → 摘要邮件。
 *   server 始终注入 Inbox，后台不会自动修改配置。无 Inbox 的旧嵌入接口仍兼容，
 *   applyToConfig 是旧辅助函数；页面操作走 ModelInbox 的预览与配置事务。
 *
 * 决策核心（与 python 版对齐）：
 *  1. 发现：models.dev API（价格/上下文/计费）为数据源，按 FAMILIES 正则匹配
 *  2. 升级护栏：对比基准是网关目录（deployed 模型清单），不是 state 快照——
 *     目录已部署模型，上游同 family 同 tier 出现更高版本即升级候选；价格涨幅
 *     ≤ threshold（输入/输出任一超限即否；免费→收费也视为超限）→ 推荐替换
 *     （改网关目录）；超限或旧价未知 → parallel（人工决策）；全新系列 → 报告。
 *     各 family 语义统一，账号可用性（订阅状态等）不阻碍目录升级（用户裁决
 *     2026-10-01：不能因为暂时用不了模型就不升级模型）
 *  3. 退役检测：
 *     - deepseek：官方 /v1/models 列表为权威（不在列表即退役）
 *     - glm：列表不可靠（退役模型仍列出但静默重映射），对目录中已部署模型发
 *       1-token 探测，响应 model 字段漂移（请求 glm-4.7 实回 glm-5.3-flash）即退役
 *     - gpt/codex：不检测（原生 OAuth，models.dev 目录与实际可用性脱钩）
 *  4. state.json 持久化：models 降级为纯“已见过”去重集合（notify_new_family
 *     只报告一次）+ retired 名单（models.dev 目录滞后条目防重复报告）。
 *     statePath 可注入（构造参数；server 侧 MODEL_GUARD_STATE_FILE 优先，
 *     否则 EVENT_LOG_FILE 同目录）——避免写进容器镜像层随重建丢失
 *  5. dryRun 默认 true：生产后台只报告；人工提交不需要关闭 dryRun
 *  6. 动作记入 events.js（model_guard 事件）；邮件通知复用 notify.js
 *
 * 丢弃的 python 版逻辑（网关架构下不需要）：
 *  - apply_pi / apply_openclaw / apply_newapi 三套落地（网关目录是唯一权威源）
 *  - new-api 管理会话（409 自愈等）
 *  - pi/openclaw 配置文件读写与备份
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveRef } from '../../config.js';
import { sendMail } from '../notify.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const DEFAULT_THRESHOLD = 1.3;

// 跟踪的模型系列：family → 品牌匹配 + 定位键（与 python 版 FAMILIES 对齐）
// modelsdev: models.dev API 的 provider 名；pattern 捕获组 1=版本、2=tier 变体
export const FAMILIES = {
  gpt: {
    modelsdev: 'openai',
    pattern: /^gpt-(\d+(?:\.\d+)?)-?(sol|luna|astra|terra|pro|mini)?$/,
    tiers: { sol: 'sol', luna: 'luna', astra: 'astra', terra: 'terra' },
  },
  glm: {
    modelsdev: 'zai',
    pattern: /^glm-(\d+(?:\.\d+)?)(?:-(flash|flashx|air|turbo|v))?$/,
    tiers: { '': 'base', flash: 'flash' },
  },
  deepseek: {
    modelsdev: 'deepseek',
    pattern: /^deepseek-(v[\d.]+-pro|v[\d.]+-flash|flash|chat|reasoner)$/,
    tiers: { pro: 'pro', flash: 'flash' },
    // 单捕获组家族：v4-pro / v4-flash → 版本与档次分离
    splitGroup: /^v([\d.]+)-(pro|flash)$/,
  },
};

/** 模型 id → {family, version, tier}；未跟踪系列/变体返回 null。 */
export function classifyModel(modelId, families = FAMILIES) {
  for (const [fam, cfg] of Object.entries(families)) {
    const m = cfg.pattern.exec(modelId);
    if (!m) continue;
    const groups = m.slice(1).filter((g) => g !== undefined && g !== '');
    if (groups.length === 0) continue;
    let version = groups[0];
    let tname = groups.length > 1 ? groups[1] : '';
    if (cfg.splitGroup && groups.length === 1) {
      const vm = cfg.splitGroup.exec(groups[0]);
      if (vm) [, version, tname] = vm;
    }
    if (!/^[\d.]+$/.test(version)) continue; // 官方稳定名（deepseek-flash 等 evergreen id）无版本号，
    // 不参与版本阶梯比对：升级在同名下由上游完成，目录无需变更；
    // 其退役检测由 detectRetired 按官方 /models 全量比对覆盖
    const tier = cfg.tiers[tname];
    if (tier === undefined) continue; // 未跟踪变体（flashx/air/v/pro/mini）
    return { family: fam, version: Number(version), tier };
  }
  return null;
}

/** models.dev api.json → {family: {model_id: info}}（价格单位 美元/百万 Token）。 */
export function buildUniverse(apiJson, families = FAMILIES) {
  const out = {};
  for (const [fam, cfg] of Object.entries(families)) {
    const found = {};
    const prov = apiJson?.[cfg.modelsdev]?.models ?? {};
    for (const [mid, info] of Object.entries(prov)) {
      const cls = classifyModel(mid, { [fam]: cfg });
      if (!cls || cls.family !== fam) continue;
      const cost = info?.cost ?? {};
      if (!cost.input && !cost.output) continue; // 无计费信息无法比价
      found[mid] = {
        family: cls.family,
        version: cls.version,
        tier: cls.tier,
        cost: {
          input: cost.input || 0,
          output: cost.output || 0,
          cacheRead: cost.cache_read || 0,
          cacheWrite: cost.cache_write || 0,
        },
        modalities: info?.modalities ?? null,
        type: info?.type ?? null,
        ctx: info?.limit?.context ?? info?.limit_context ?? null,
        maxout: info?.limit?.output ?? info?.limit_output ?? null,
      };
    }
    out[fam] = found;
  }
  return out;
}

/** 新价格 ≤ 旧价 × threshold 视为可自动替换（输入输出任一超限即否；免费→收费也否）。 */
export function priceOk(oldInfo, newInfo, threshold = DEFAULT_THRESHOLD) {
  for (const k of ['input', 'output']) {
    const o = oldInfo.cost[k];
    const n = newInfo.cost[k];
    if (o > 0 && n > o * threshold) return false;
    if (o === 0 && n > 0) return false;
  }
  return true;
}

/**
 * 对比 universe 与网关目录（deployed 模型 id 清单），产出 actions。
 *  - replace:      目录已部署模型，上游同 family 同 tier 存在更高版本且价格护栏
 *                  通过 → 自动替换网关目录
 *  - parallel:     版本更新但涨幅超限、或旧模型价格未知（无法比价）
 *                  → 报告人工决策
 *  - notify_new_family: 上游模型其 family+tier 在目录中无部署对应、且未见过
 *                  （state.models 去重）→ 报告一次
 * 对比基准是目录而非 state 快照：state.models 只是“已见过”集合，基线吸收新版本
 * 不会致盲升级发现——空 state + 非空 deployed 也产出 replace/parallel（首跑）。
 * retired 名单中的模型不作为升级候选/新模型（models.dev 目录滞后条目）。
 */
export function planChanges(universe, state, { threshold = DEFAULT_THRESHOLD, deployed = [] } = {}) {
  const actions = [];
  const firstRun = !state?.models || Object.keys(state.models).length === 0;
  const retiredKnown = new Set(state?.retired ?? []);
  const snap = state?.models ?? {};

  // 目录 deployed 条目分类；同 family 同 tier 多版本取最高者为升级基准 old
  const groups = new Map(); // `family|tier` → { id, cls }
  for (const id of new Set(deployed)) {
    const cls = classifyModel(id);
    if (!cls) continue;
    const key = `${cls.family}|${cls.tier}`;
    const cur = groups.get(key);
    if (!cur || cls.version > cur.cls.version) groups.set(key, { id, cls });
  }

  // ── replace / parallel：遍历目录，找上游同 family 同 tier 最高版本升级候选 ──
  for (const { id: old, cls } of groups.values()) {
    const upstream = Object.entries(universe[cls.family] ?? {})
      .filter(([mid, info]) =>
        info.tier === cls.tier
        && info.version > cls.version
        && !retiredKnown.has(mid) && !retiredKnown.has(`${cls.family}/${mid}`))
      .map(([mid, info]) => ({ mid, info }));
    if (upstream.length === 0) continue;
    const { mid: newId, info } = upstream.reduce((a, b) => (a.info.version >= b.info.version ? a : b));
    // 旧价格：上游目录优先，state 快照兜底；两处都无 → 无法比价 → parallel
    const oldInfo = universe[cls.family]?.[old] ?? snap[cls.family]?.[old] ?? null;
    let action;
    if (!oldInfo) {
      action = { type: 'parallel', reason: '旧模型价格未知，无法比价' };
    } else if (priceOk(oldInfo, info, threshold)) {
      action = { type: 'replace' };
    } else {
      action = { type: 'parallel' }; // 涨幅超限 → 默认文案
    }
    actions.push({ ...action, family: cls.family, old, new: newId, info, oldinfo: oldInfo });
  }

  // ── notify_new_family：上游 family+tier 无部署对应，且未见过（报告一次）──
  const deployedTiers = new Set(groups.keys());
  const deployedSet = new Set(deployed);
  for (const [fam, models] of Object.entries(universe)) {
    const famSeen = snap[fam] ?? {};
    for (const [mid, info] of Object.entries(models)) {
      if (deployedSet.has(mid)) continue;
      if (retiredKnown.has(mid) || retiredKnown.has(`${fam}/${mid}`)) continue;
      if (mid in famSeen) continue;
      if (deployedTiers.has(`${fam}|${info.tier}`)) continue; // 同 family 同 tier 已部署 → 非新系列
      if (firstRun) continue; // 首跑只建基线（runOnce 写 state.models 供后续去重）
      actions.push({ type: 'notify_new_family', family: fam, model: mid, info });
    }
  }
  return actions;
}

/**
 * 退役检测。
 *  - providers 中 type:openai/glm 的条目按各自官方端点检测：
 *    openai 兼容（deepseek 等）：GET {base}/../models 官方列表权威
 *    glm：对目录中已部署 glm 模型发 1-token 探测，响应 model 字段漂移即退役
 *  - gpt/codex：跳过（原生 OAuth 豁免）
 * 返回 [{family, model, providerId, evidence}]
 */
export async function detectRetired({ providers, universe, fetchImpl = fetch, events, retiredKnown = [] }) {
  const retired = [];
  const skip = new Set(retiredKnown); // 已确认退役名单 —— 不再探测，防目录滞后重复报告
  // ── deepseek：官方 /models 列表为权威 ──
  for (const provider of providers) {
    if (provider.type !== 'openai') continue;
    const fams = Object.keys(universe).filter((f) => FAMILIES[f].modelsdev === 'deepseek');
    if (fams.length === 0) continue;
    // 官方 /models 列表为权威：目录全部模型 id 都比对，不按 classifyModel 过滤——
    // 官方稳定名（deepseek-flash）无版本号解析为 null，按 id 过滤会漏掉主力模型
    const deployed = provider.models.map((m) => m);
    if (deployed.length === 0) continue;
    const apiKey = resolveRef(provider.apiKeyRef);
    if (!apiKey) continue;
    const modelsUrl = provider.baseUrl.replace(/\/chat\/completions$/, '/models');
    let liveIds;
    try {
      const resp = await fetchImpl(modelsUrl, { headers: { authorization: `Bearer ${apiKey}` } });
      if (!resp.ok) continue;
      const json = await resp.json();
      liveIds = new Set((json.data ?? []).map((m) => m.id));
    } catch {
      continue; // 探测失败不影响其他检测
    }
    for (const m of deployed) {
      if (skip.has(m) || skip.has(`deepseek/${m}`)) continue;
      if (!liveIds.has(m)) {
        retired.push({ family: 'deepseek', model: m, providerId: provider.id, evidence: `absent from official /models (${modelsUrl})` });
      }
    }
  }

  // ── glm：1-token 探测响应 model 字段漂移（官方列表不可靠）──
  for (const provider of providers) {
    if (provider.type !== 'glm') continue;
    const glmModels = provider.models.filter((m) => {
      const cls = classifyModel(m);
      return cls && cls.family === 'glm';
    });
    if (glmModels.length === 0) continue;
    const apiKey = resolveRef(provider.apiKeyRef);
    if (!apiKey) continue;
    for (const mid of glmModels) {
      if (skip.has(mid) || skip.has(`glm/${mid}`)) continue;
      try {
        const resp = await fetchImpl(provider.baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: mid, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
        });
        if (resp.status === 400 || resp.status === 404 || resp.status === 410 || resp.status === 503) {
          retired.push({ family: 'glm', model: mid, providerId: provider.id, evidence: `probe HTTP ${resp.status}` });
          continue;
        }
        if (!resp.ok) continue; // 其他状态（429/5xx）不算退役证据
        const json = await resp.json().catch(() => null);
        const served = json?.model ?? mid;
        if (served !== mid) {
          retired.push({ family: 'glm', model: mid, providerId: provider.id, evidence: `silently remapped to ${served}` });
          events?.record('model_guard_retired', { family: 'glm', model: mid, served });
        }
      } catch {
        continue;
      }
    }
  }
  return retired;
}

/**
 * 决策结果落地：只改网关 config（providers[].models）。
 * state 目录：configDir/model-guard-state.json
 */
export async function applyToConfig({ actions, retired, providers, configPath }) {
  let raw = await fs.readFile(configPath, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    cfg = null;
  }
  if (!cfg && configPath.endsWith('.json')) throw new Error(`cannot parse ${configPath}`);

  // YAML 配置：用文本级替换（保留注释与结构）— models 列表项都是 "  - name" 形态
  if (!cfg) {
    for (const action of actions) {
      if (action.type !== 'replace') continue;
      raw = replaceYamlModel(raw, action.old, action.new);
    }
    for (const r of retired) {
      raw = removeYamlModel(raw, r.model);
    }
    await fs.writeFile(configPath, raw, 'utf8');
    return { changed: summarizeChanges(actions, retired) };
  }

  // JSON 配置：结构化修改（models 条目兼容 string 与 {id:...} 两种形态）
  for (const action of actions) {
    if (action.type !== 'replace') continue;
    for (const p of cfg.providers ?? []) {
      p.models = p.models.map((m) => {
        if (m === action.old) return action.new; // string 条目
        if (m?.id === action.old) return { ...m, id: action.new }; // 结构化条目：换 id 保留其余字段
        return m;
      });
    }
  }
  for (const r of retired) {
    for (const p of cfg.providers ?? []) {
      p.models = p.models.filter((m) => m !== r.model && m?.id !== r.model);
    }
  }
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { changed: summarizeChanges(actions, retired) };
}

/** YAML 文本中 "  - old-model" / "  - id: old-model" → 换新 id（全局，保留注释与缩进）。 */
export function replaceYamlModel(text, oldModel, newModel) {
  const re = new RegExp(`^(\\s*-\\s*(?:id:\\s*)?)${escapeRegExp(oldModel)}(\\s*(?:#.*)?)$`, 'gm');
  return text.replace(re, `$1${newModel}$2`);
}

/**
 * YAML 文本中删除 "  - model" / "  - id: model" 行。
 * 结构化 `- id:` 条目连同其后缩进更深的从属行（modalities 子块等）整块删除，不留孤儿。
 */
export function removeYamlModel(text, model) {
  const esc = escapeRegExp(model);
  const plainRe = new RegExp(`^\\s*-\\s*${esc}\\s*(?:#.*)?$`);
  const idRe = new RegExp(`^(\\s*)-\\s*id:\\s*${esc}\\s*(?:#.*)?$`);
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (plainRe.test(line)) continue; // 简单条目：只删本行
    const m = idRe.exec(line);
    if (m) {
      const indent = m[1].replace(/\t/g, '  ').length; // 该条目行的缩进宽度
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === '') break; // 空行保守终止（不吞后续条目）
        const nextIndent = next.match(/^\s*/)[0].replace(/\t/g, '  ').length;
        if (nextIndent > indent) { i += 1; continue; } // 从属行 → 一并删除
        break;
      }
      i -= 1; // 抵消外层循环自增
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarizeChanges(actions, retired) {
  const out = [];
  for (const a of actions) {
    if (a.type === 'replace') out.push(`gateway: ${a.old} → ${a.new}`);
  }
  for (const r of retired) out.push(`gateway: -${r.model} (${r.evidence})`);
  return out;
}

/**
 * ModelGuard job：周期（默认 24h）发现 → 决策 → 退役检测 → 落地 → 报告。
 */
export class ModelGuard {
  /**
   * @param {object} opts
   * @param {Array} opts.providers - 目录 providers
   * @param {object} opts.jobs - config.jobs.modelGuard
   * @param {string} opts.configPath - 网关 config 文件路径（落地写入）
   * @param {string} [opts.statePath] - state 持久化路径覆盖；缺省 config 同目录
   * @param {object} opts.events - EventLog
   * @param {object} [opts.notifyCfg] - {smtpUrl, from, to}
   * @param {Function} [opts.fetch]
   * @param {() => number} [opts.now]
   * @param {Function} [opts.onChange] - 目录变更后回调（server 传 reload）
   */
  constructor({ providers, jobs = {}, configPath, statePath, events, notifyCfg, fetch: fetchFn, now, onChange, inbox } = {}) {
    this.cfg = {
      enabled: jobs.modelGuard?.enabled ?? jobs.enabled ?? false,
      dryRun: jobs.modelGuard?.dryRun ?? jobs.dryRun ?? true,
      intervalHours: jobs.modelGuard?.intervalHours ?? jobs.intervalHours ?? 24,
      modelsDevUrl: jobs.modelGuard?.modelsDevUrl ?? MODELS_DEV_URL,
      threshold: jobs.modelGuard?.threshold ?? DEFAULT_THRESHOLD,
      notifyOnNoChange: jobs.modelGuard?.notifyOnNoChange ?? false,
    };
    this.providers = providers;
    this.configPath = configPath;
    // state 持久化路径可注入（server 按 MODEL_GUARD_STATE_FILE / EVENT_LOG_FILE 指向持久卷）；
    // 缺省 config 同目录（容器内若 config 在镜像层则随重建丢失——生产由注入规避）
    this.statePath = statePath ?? path.join(path.dirname(configPath), 'model-guard-state.json');
    this.events = events;
    this.notifyCfg = notifyCfg ?? null;
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.now = now ?? Date.now;
    this.onChange = onChange ?? null;
    this.timer = null;
    this.inbox = inbox ?? null;
    // 最近一次 models.dev universe（family → {modelId: info}）；审批校验的兜底数据源
    // （pricing 与 guard 各自拉 api.json，pricing 可能滞后 → 候选已在 guard 快照里即可审批）
    this.universe = null;
  }

  /** 审批校验兕底：模型是否在 guard 自己的 models.dev 快照里（含启动时从 state 恢复）。
 *  server.js 的 inbox validateModel 用它做 pricing.typeFor 的并集，消除双副本竞态。 */
  catalogHas(model) {
    if (!this.universe || typeof model !== 'string') return false;
    for (const fam of Object.values(this.universe)) {
      if (fam && typeof fam === 'object' && Object.hasOwn(fam, model)) return true;
    }
    return false;
  }

  /** /internal/dashboard 数据：配置态（enabled/dryRun），UI 🛡 装饰图标据此联动。 */
  snapshot() {
    return { enabled: this.cfg.enabled === true, dryRun: this.inbox ? true : this.cfg.dryRun !== false, ...(this.inbox ? { manual: true } : {}) };
  }

  start() {
    // 启动即恢复上次 models.dev 快照：首轮巡检在 +30s，期间审批校验兜底（catalogHas）也可用
    this.loadState().then((s) => { if (!this.universe && s?.models) this.universe = s.models; }).catch(() => {});
    if (!this.cfg.enabled || this.timer) return this;
    const firstDelayMs = 30 * 1000; // 启动 30s 后首轮
    const t = setTimeout(() => {
      this.runOnce().catch(() => {});
      this.timer = setInterval(() => this.runOnce().catch(() => {}), this.cfg.intervalHours * 3600 * 1000);
      this.timer.unref?.();
    }, firstDelayMs);
    t.unref?.();
    this._startTimer = t;
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this._startTimer) clearTimeout(this._startTimer);
    this.timer = null;
    this._startTimer = null;
    return this;
  }

  async loadState() {
    try {
      return JSON.parse(await fs.readFile(this.statePath, 'utf8'));
    } catch {
      return {};
    }
  }

  async saveState(state) {
    const tmp = `${this.statePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
    await fs.rename(tmp, this.statePath);
  }

  /** 目录中已部署模型 id 清单（providers[].models 兼容 string 与 {id} 条目），去重。 */
  deployedModels() {
    const ids = (this.providers ?? []).flatMap((p) => (p.models ?? [])
      .map((m) => (typeof m === 'string' ? m : m?.id)));
    return [...new Set(ids.filter(Boolean))];
  }

  /** 单轮巡检。返回 {report, actions, retired, applied}。 */
  runOnce() {
    if (!this.running) this.running = this.inspect().finally(() => { this.running = null; });
    return this.running;
  }

  async inspect() {
    const state = await this.loadState();
    if (!this.universe && state?.models) this.universe = state.models; // 启动恢复：上次巡检的目录
    const universe = await this.discover();
    if (this.discoveryOk === false) return { report:'模型目录暂时不可用，保留原待办与配置。', actions:[], retired:[], applied:[] };
    this.universe = universe;
    let actions = planChanges(universe, this.inbox ? { ...state, models:{ gpt:{},glm:{},deepseek:{} } } : state, { threshold: this.cfg.threshold, deployed: this.deployedModels() });
    if (this.inbox) {
      state.retired = [...new Set([...(state.retired ?? []),...this.inbox.items.filter(i => i.status === 'removed').map(i => `${i.family}/${i.model}`)])];
      actions = (this.providers ?? []).flatMap(p => planChanges(universe,{ ...state,models:{gpt:{},glm:{},deepseek:{}} },{threshold:this.cfg.threshold,deployed:p.models.map(m => typeof m === 'string' ? m : m.id)}).map(a => ({...a,providerId:p.id})));
    }
    const retiredKnown = [...(state.retired ?? [])];
    const retired = await detectRetired({ providers: this.providers, universe, fetchImpl: this.fetchFn, events: this.events, retiredKnown });

    if (this.inbox) {
      const candidates = [];
      // 新系列（无 old）：取同渠道首个非监控且在 models.dev 目录有完整属性的模型作参照，
      // 附 ref/refinfo 供对比表展示（旧建议缺此字段，reconcile 的 Object.assign 会自动补上）
      const refFor = (p, newId) => {
        for (const m of p.models ?? []) {
          const id = typeof m === 'string' ? m : m.id;
          if (!id || id === newId || m.monitor) continue;
          const fam = classifyModel(id)?.family;
          const info = fam ? universe[fam]?.[id] : null;
          if (info) return { ref: id, refinfo: info };
        }
        return {};
      };
      for (const a of actions) for (const p of this.providers ?? []) {
        const familyMatch = p.type === 'codex' ? a.family === 'gpt' : p.type === 'glm' ? a.family === 'glm' : (p.models ?? []).some(m => (typeof m === 'string' ? m : m.id).startsWith(a.family + '-'));
        if (a.providerId !== p.id || !familyMatch || (a.old && !p.models.some(m => (typeof m === 'string' ? m : m.id) === a.old))) continue;
        const { ref, refinfo } = a.old ? {} : refFor(p, a.new ?? a.model);
        candidates.push({ kind:'upgrade',providerId:p.id,family:a.family,old:a.old ?? null,model:a.new ?? a.model,info:a.info,oldinfo:a.oldinfo ?? null,...(ref ? { ref, refinfo } : {}),reason:a.reason ?? (a.type === 'parallel' ? '价格涨幅需要评估' : a.old ? '发现同系列新版本' : '发现新系列') });
      }
      for (const r of retired) candidates.push({kind:'retire',providerId:r.providerId,family:r.family,old:r.model,model:r.model,reason:'疑似退役，需人工确认',evidence:r.evidence});
      // 新系列只保留同档次最高版本，避免把旧历史版本当作全新选择。
      const latest = candidates.filter(c => c.old || !candidates.some(other => !other.old && other.providerId === c.providerId && other.info?.tier === c.info?.tier && other.info?.version > c.info?.version));
      await this.inbox.reconcile(latest);
    }
    let applied = [];
    // 旧的无 Inbox 嵌入使用保留兼容；server 始终注入 Inbox，后台只生成建议。
    if (!this.inbox && !this.cfg.dryRun && (actions.some((a) => a.type === 'replace') || retired.length > 0)) {
      try {
        const { changed } = await applyToConfig({ actions, retired, providers: this.providers, configPath: this.configPath });
        applied = changed;
        // 内存目录就地同步（config 已改；不依赖外部 onChange 重注入 providers）：
        // replace 换 id（string/{id} 两形态）、retired 删条目 —— 保证下一轮 deployed 基线一致
        for (const action of actions) {
          if (action.type !== 'replace') continue;
          for (const p of this.providers ?? []) {
            p.models = (p.models ?? []).map((m) =>
              (m === action.old || m?.id === action.old)
                ? (typeof m === 'string' ? action.new : { ...m, id: action.new })
                : m);
          }
        }
        for (const r of retired) {
          for (const p of this.providers ?? []) {
            p.models = (p.models ?? []).filter((m) => m !== r.model && m?.id !== r.model);
          }
        }
        // state 推进：退役模型移出快照并入 retired 名单；快照整体刷新
        for (const r of retired) {
          delete (state.models ??= {})[r.family]?.[r.model];
          (state.retired ??= []).push(`${r.family}/${r.model}`);
        }
        state.retired = [...new Set(state.retired)].sort();
        state.models = universe;
        state.updated = new Date(this.now()).toISOString();
        await this.saveState(state);
        this.onChange?.();
      } catch (e) {
        // 落地失败可见化：记错误事件、applied 置空；报告/事件/邮件照常，不向上抛
        this.events?.record('model_guard_error', { stage: 'apply', error: String(e?.message ?? e) });
        applied = [];
      }
    } else if (this.cfg.dryRun && (actions.length > 0 || retired.length > 0)) {
      // dry-run：不写 config；state 也不推进（下轮重新评估同一批）— 但退役名单
      // 在人工确认前不写入，避免 dry-run 结果污染生产 state
    }

    // 首跑建基线（无动作时也持久化，否则每次首跑都重复报告）。
    // 持久化失败不中断本轮报告（如目录不可写）：记错误事件，下轮重试
    if (!state.models && Object.keys(universe).length > 0) {
      const next = { ...state, models: universe, updated: new Date(this.now()).toISOString() };
      try {
        await this.saveState(next);
      } catch (e) {
        this.events?.record('model_guard_error', { stage: 'state_persist', error: String(e?.message ?? e) });
      }
    }

    const report = buildReport({ universe, actions, retired, applied, dryRun: this.inbox ? true : this.cfg.dryRun });
    this.events?.record('model_guard', {
      dryRun: this.inbox ? true : this.cfg.dryRun,
      newModels: actions.length,
      retired: retired.map((r) => `${r.family}/${r.model}`),
      applied,
    });

    // 邮件：有退役 / 有需人工决策项（parallel / new family）/ dry-run 发现可替换项
    const needHuman = retired.length > 0 || actions.some((a) => a.type !== 'replace');
    const dryRunFindings = this.cfg.dryRun && actions.some((a) => a.type === 'replace');
    if (!this.inbox && (needHuman || dryRunFindings || this.cfg.notifyOnNoChange) && this.notifyCfg?.smtpUrl) {
      const url = resolveRef(this.notifyCfg.smtpUrl);
      if (url) {
        sendMail(
          { smtpUrl: url, from: this.notifyCfg.from, to: this.notifyCfg.to },
          { subject: `[model-gateway] model-guard 巡检报告 ${this.cfg.dryRun ? '(dry-run)' : ''}`, text: report },
        ).catch(() => {});
      }
    }
    return { report, actions, retired, applied };
  }

  /** 发现：models.dev API → universe（失败返回空 universe，本轮跳过）。 */
  async discover() {
    let apiJson;
    this.discoveryOk = true;
    try {
      const resp = await this.fetchFn(this.cfg.modelsDevUrl, { headers: { 'user-agent': 'model-gateway-model-guard' } });
      if (!resp.ok) throw new Error(`models.dev HTTP ${resp.status}`);
      apiJson = await resp.json();
    } catch (e) {
      this.discoveryOk = false;
      this.events?.record('model_guard_error', { stage: 'discover', error: String(e?.message ?? e) });
      return { gpt: {}, glm: {}, deepseek: {} };
    }
    return buildUniverse(apiJson);
  }
}

/** 巡检报告文本（与 python 版 write_report 结构对齐）。 */
export function buildReport({ universe, actions, retired = [], applied = [], dryRun = false }) {
  const lines = ['NAS 模型自动升级巡检报告（model-gateway 内置）', new Date().toISOString(), ''];
  if (dryRun) lines.push('⚠ dry-run：本轮建议尚未执行，当前模型配置未变更。请在 Message Inbox 选择操作；巡检仍可能产生最小真实探测用量。', '');
  for (const r of retired) {
    lines.push(`[疑似退役] ${r.family}/${r.model} (${r.evidence})`);
  }
  for (const a of actions) {
    if (a.type === 'replace') {
      lines.push(`[建议替换] ${a.family}: ${a.old} → ${a.new}`);
      lines.push(`       价格 in: ${a.oldinfo.cost.input} → ${a.info.cost.input} 美元/百万 Token, out: ${a.oldinfo.cost.output} → ${a.info.cost.output}`);
    } else if (a.type === 'parallel') {
      const why = a.reason ?? '涨幅超限';
      lines.push(`[新版待决定] ${a.family}: 新 ${a.new} ${why}，保留 ${a.old}; 如需启用请手动`);
      lines.push(`       价格 in: ${a.oldinfo?.cost?.input ?? '?'} → ${a.info.cost.input}, out: ${a.oldinfo?.cost?.output ?? '?'} → ${a.info.cost.output}`);
    } else if (a.type === 'notify_new_family') {
      lines.push(`[发现新型号] ${a.family}: ${a.model} (全新系列,无旧模型可比,请人工评估)`);
    }
  }
  if (actions.length === 0 && retired.length === 0) {
    lines.push('无新模型,配置未变化。');
  }
  if (applied.length > 0) {
    lines.push('', '已应用: ' + applied.join('; '));
  }
  return lines.join('\n');
}
