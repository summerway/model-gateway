// config.js — config directory loader + validation + env secret refs.
// Layout (see config/config.example.yaml):
//   providers[]: {id, type, baseUrl, apiKeyRef, models[], anthropicBaseUrl?}
//   gateway:     {host, port, keys[]} — keys 条目为字符串或 {key, app, note?}（per-app 归因）
//   jobs:        {probe{...}, activate{...}}
//   notify:      {smtpUrl, from?, to?}
// apiKeyRef resolves at runtime: "env:VAR" / "env:VAR:default".

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseYaml } from './yaml.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Resolve a secret reference at runtime.
 * Supported forms:
 *   "env:VAR_NAME"         — required env var; missing → null
 *   "env:VAR_NAME:default" — fallback default when var missing/empty
 *   "plain"                — treated as a warning-worthy literal (returned as-is)
 */
export function resolveRef(ref, env = process.env) {
  if (typeof ref !== 'string') return null;
  if (ref.startsWith('env:')) {
    const rest = ref.slice(4);
    const first = rest.indexOf(':');
    const name = first === -1 ? rest : rest.slice(0, first);
    const fallback = first === -1 ? null : rest.slice(first + 1);
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    return fallback;
  }
  return ref; // literal — discouraged for keys, fine for model names etc.
}

const PROVIDER_TYPES = new Set(['openai', 'glm', 'anthropic', 'codex']);

/** Display-only topology declarations; credentials and routing never come from this section. */
function normalizeTopology(raw, { apps, providers }) {
  if (raw === undefined) raw = {};
  const mapping = (value, where) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`${where}: expected a mapping`);
  };
  mapping(raw, 'topology');
  const list = (key) => {
    const value = raw[key] === undefined ? [] : raw[key];
    if (!Array.isArray(value)) throw new ConfigError(`topology.${key}: expected a list`);
    return value;
  };
  const slug = (value, where) => {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new ConfigError(`${where}: expected a lowercase slug`);
    return value;
  };
  const label = (value, where) => {
    if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`${where}: expected a non-empty label`);
    return value.trim();
  };
  const unique = (set, value, where) => {
    if (set.has(value)) throw new ConfigError(`${where}: duplicate ${value}`);
    set.add(value);
  };
  const collectorIds = new Set();
  const collectors = list('collectors').map((entry, i) => {
    const where = `topology.collectors[${i}]`;
    mapping(entry, where);
    const id = slug(entry.id, `${where}.id`);
    unique(collectorIds, id, `${where}.id`);
    return { id, label: label(entry.label, `${where}.label`) };
  });
  const connections = new Set();
  const directConnections = list('directConnections').map((entry, i) => {
    const where = `topology.directConnections[${i}]`;
    mapping(entry, where);
    const app = slug(entry.app, `${where}.app`);
    const device = slug(entry.device, `${where}.device`);
    if (device.length > 32) throw new ConfigError(`${where}.device: must have at most 32 characters`);
    const providerId = entry.providerId;
    if (typeof providerId !== 'string' || !providerId) throw new ConfigError(`${where}.providerId: expected a provider id`);
    if (!providers.has(providerId)) throw new ConfigError(`${where}.providerId: unknown provider ${providerId}`);
    unique(connections, JSON.stringify([app, device, providerId]), where);
    let collectorId;
    if (entry.collectorId !== undefined) {
      collectorId = slug(entry.collectorId, `${where}.collectorId`);
      if (!collectorIds.has(collectorId)) throw new ConfigError(`${where}.collectorId: unknown collector ${collectorId}`);
    }
    apps.add(app); // Official direct clients need no gateway key.
    return { app, device, providerId, ...(collectorId === undefined ? {} : { collectorId }) };
  });
  const groupIds = new Set(), members = new Set();
  const appGroups = list('appGroups').map((entry, i) => {
    const where = `topology.appGroups[${i}]`;
    mapping(entry, where);
    const id = slug(entry.id, `${where}.id`);
    unique(groupIds, id, `${where}.id`);
    if (!Array.isArray(entry.apps) || !entry.apps.length) throw new ConfigError(`${where}.apps: expected a non-empty list`);
    const groupApps = entry.apps.map((value, j) => {
      const app = slug(value, `${where}.apps[${j}]`);
      if (!apps.has(app)) throw new ConfigError(`${where}.apps[${j}]: unknown app ${app}`);
      unique(members, app, `${where}.apps[${j}]`);
      return app;
    });
    const icon = entry.icon === undefined ? undefined : slug(entry.icon, `${where}.icon`);
    return { id, label: label(entry.label, `${where}.label`), ...(icon === undefined ? {} : { icon }), apps: groupApps };
  });
  return { appGroups, collectors, directConnections };
}

/**
 * Normalize providers[].models entries: "name" strings or {id, modalities,
 * visionRouting} objects → { ids, defs, routing } (modalities default ['text'];
 * routing: modelId → {strategy, target}，仅形状校验，交叉校验在 validateConfig 主流程).
 */
function normalizeModels(rawModels, where, errors) {
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    errors.push(`${where}.models: required non-empty list`);
    return null;
  }
  const ids = [];
  const defs = {};
  const routing = {};
  for (const m of rawModels) {
    if (typeof m === 'string') {
      ids.push(m);
      defs[m] = ['text'];
    } else if (m && typeof m === 'object' && typeof m.id === 'string' && m.id) {
      let mods = ['text'];
      if (m.modalities !== undefined && m.modalities !== null) {
        if (Array.isArray(m.modalities) && m.modalities.every((x) => typeof x === 'string' && x)) {
          mods = [...m.modalities];
        } else {
          errors.push(`${where}.models[${m.id}].modalities: must be a list of strings`);
        }
      }
      if (m.visionRouting !== undefined && m.visionRouting !== null) {
        const vr = m.visionRouting;
        if (!vr || typeof vr !== 'object' || Array.isArray(vr)) {
          errors.push(`${where}.models[${m.id}].visionRouting: must be a mapping {strategy, target}`);
        } else if (vr.strategy !== 'reroute') {
          errors.push(`${where}.models[${m.id}].visionRouting.strategy: only 'reroute' is supported (v1)`);
        } else if (typeof vr.target !== 'string' || !vr.target) {
          errors.push(`${where}.models[${m.id}].visionRouting.target: required non-empty string`);
        } else if (vr.uncertain !== undefined && vr.uncertain !== null && vr.uncertain !== 'pixels' && vr.uncertain !== 'consumed') {
          errors.push(`${where}.models[${m.id}].visionRouting.uncertain: only 'pixels' or 'consumed' are supported (v1.1)`);
        } else {
          // uncertain 缺省即 'pixels'（v1 行为）；仅显式 'consumed' 才写入规则，保持目录归一形态最小
          routing[m.id] = vr.uncertain === 'consumed'
            ? { strategy: vr.strategy, target: vr.target, uncertain: 'consumed' }
            : { strategy: vr.strategy, target: vr.target };
        }
      }
      ids.push(m.id);
      defs[m.id] = mods;
    } else {
      errors.push(`${where}.models: entries must be strings or {id, modalities} objects`);
    }
  }
  return { ids, defs, routing };
}

function coerceJobNumbers(job, { intervalSec, cacheTtlSec, backoffStartSec, backoffMaxSec, timeoutSec }) {
  const out = { ...job };
  for (const [key, def] of Object.entries({
    intervalSec,
    cacheTtlSec,
    backoffStartSec,
    backoffMaxSec,
    timeoutSec,
  })) {
    if (out[key] === undefined || out[key] === null) out[key] = def;
    if (typeof out[key] !== 'number' || !Number.isFinite(out[key]) || out[key] <= 0) {
      throw new ConfigError(`jobs: ${key} must be a positive number`);
    }
  }
  return out;
}

export function validateConfig(raw, { source = 'config' } = {}) {
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${source}: root must be a mapping`);
  const errors = [];
  const normalizedModels = new Map(); // provider idx → {ids, defs}
  const providers = raw.providers ?? [];
  if (!Array.isArray(providers) || providers.length === 0) {
    errors.push('providers: at least one provider required');
  } else {
    const ids = new Set();
    providers.forEach((p, idx) => {
      const where = `providers[${idx}]`;
      if (!p || typeof p !== 'object') return errors.push(`${where}: must be a mapping`);
      if (!p.id || typeof p.id !== 'string') errors.push(`${where}.id: required string`);
      else if (ids.has(p.id)) errors.push(`${where}.id: duplicate id "${p.id}"`);
      else ids.add(p.id);
      if (!PROVIDER_TYPES.has(p.type)) errors.push(`${where}.type: must be one of ${[...PROVIDER_TYPES].join('/')}`);
      if (p.displayName !== undefined && p.displayName !== null && typeof p.displayName !== 'string') {
        errors.push(`${where}.displayName: optional string (dashboard 展示名；缺省用 id)`);
      }
      if (p.badge !== undefined && p.badge !== null && typeof p.badge !== 'string') {
        errors.push(`${where}.badge: optional string (dashboard 套餐标签，如 "Coding Plan · Max")`);
      }
      if (p.type === 'codex') {
        // codex: OAuth 凭据在 secrets 目录，不经 baseUrl/apiKeyRef；baseUrl 可选覆盖 backend
        if (p.baseUrl !== undefined && p.baseUrl !== null &&
            (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl))) {
          errors.push(`${where}.baseUrl: optional http(s) URL override for codex (not the chat/completions form)`);
        }
        // originator: 可选，上游遥测标识（对齐 pi 原生流量指纹用，如 "pi"）
        if (p.originator !== undefined && p.originator !== null && typeof p.originator !== 'string') {
          errors.push(`${where}.originator: optional string (upstream telemetry label, e.g. "pi")`);
        }
      } else {
        if (!p.baseUrl || typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) {
          errors.push(`${where}.baseUrl: required http(s) URL`);
        }
        if (!p.baseUrl.endsWith('/chat/completions')) return errors.push(`${where}: baseUrl must end with /chat/completions`);
        // anthropicBaseUrl：可选，上游原生 Anthropic Messages 端点根（如智谱
        // https://open.bigmodel.cn/api/anthropic）；声明后 /v1/messages 原样透传（含流式/工具）
        if (p.anthropicBaseUrl !== undefined && p.anthropicBaseUrl !== null &&
            (typeof p.anthropicBaseUrl !== 'string' || !/^https?:\/\//.test(p.anthropicBaseUrl) ||
             /\/v1\/messages\/?$/.test(p.anthropicBaseUrl))) {
          errors.push(`${where}.anthropicBaseUrl: optional http(s) base URL (without /v1/messages)`);
        }
      }
      const norm = normalizeModels(p.models, where, errors);
      if (norm) normalizedModels.set(idx, norm);
      if (p.fallbackModelMap !== undefined) {
        // codex 同样支持（生产止血：gpt-6-sol→gpt-6-luna 这类账号拒收改写）；
        // source 允许是本 provider 已有模型（legacy 别名自映射：目录保留旧名、
        // 请求时改写至新模型）；target 必须仍是本 provider owned 模型
        if (!p.fallbackModelMap || typeof p.fallbackModelMap !== 'object' || Array.isArray(p.fallbackModelMap)) {
          errors.push(`${where}.fallbackModelMap: must be a mapping of requested model to this provider's model`);
        } else for (const [requested, target] of Object.entries(p.fallbackModelMap)) {
          if (!requested || !target || typeof target !== 'string' || !norm?.ids.includes(target)) {
            errors.push(`${where}.fallbackModelMap[${requested}]: target must be an owned model`);
          }
        }
      }
    });
  }

  for (const [idx, p] of (Array.isArray(providers) ? providers : []).entries()) {
    if (p?.fallbackModelMap && typeof p.fallbackModelMap === 'object' && !Array.isArray(p.fallbackModelMap)) {
      for (const source of Object.keys(p.fallbackModelMap)) {
        if (!providers.some((owner) => Array.isArray(owner?.models) &&
            owner.models.some((m) => (typeof m === 'string' ? m : m?.id) === source))) {
          errors.push(`providers[${idx}].fallbackModelMap[${source}]: source model is not advertised by any provider`);
        }
      }
    }
  }

  // imageGeneration（可选）：图像生成路由声明 — provider 必须存在且 type:codex
  //（图像生成走 ChatGPT 订阅 OAuth 链；config 未配则 /v1/images/generations 返回 404）
  let imageGeneration = null;
  if (raw.imageGeneration !== undefined && raw.imageGeneration !== null) {
    const ig = raw.imageGeneration;
    if (!ig || typeof ig !== 'object' || Array.isArray(ig)) {
      errors.push('imageGeneration: must be a mapping { provider, model }');
    } else {
      const owner = providers.find((p) => p?.id === ig.provider);
      if (!owner) errors.push(`imageGeneration.provider: "${ig.provider}" is not declared by any provider`);
      else if (owner.type !== 'codex') errors.push(`imageGeneration.provider: "${ig.provider}" must be type codex`);
      if (!ig.model || typeof ig.model !== 'string') {
        errors.push('imageGeneration.model: required string (e.g. "gpt-image-2")');
      } else {
        imageGeneration = { provider: ig.provider, model: ig.model };
      }
    }
  }

  // embeddings（可选）：/v1/embeddings 路由声明 — 目前仅 dashscope（阿里百炼）。
  // 独立于 providers 链（无 fallback 链、无额度探测）；config 未配则路由返回 404。
  let embeddings = null;
  if (raw.embeddings !== undefined && raw.embeddings !== null) {
    const em = raw.embeddings;
    if (!em || typeof em !== 'object' || Array.isArray(em)) {
      errors.push('embeddings: must be a mapping { type, apiKeyRef, workspaceIdRef, models }');
    } else {
      const before = errors.length;
      if (em.type !== 'dashscope') errors.push('embeddings.type: only "dashscope" is supported');
      if (typeof em.apiKeyRef !== 'string' || !em.apiKeyRef) errors.push('embeddings.apiKeyRef: required (e.g. env:DASHSCOPE_API_KEY)');
      if (typeof em.workspaceIdRef !== 'string' || !em.workspaceIdRef) errors.push('embeddings.workspaceIdRef: required (e.g. env:DASHSCOPE_WORKSPACE_ID)');
      if (!Array.isArray(em.models) || em.models.length === 0 || !em.models.every((m) => typeof m === 'string' && m)) {
        errors.push('embeddings.models: required non-empty list of model ids');
      }
      if (em.defaultDimensions !== undefined && !(Number.isInteger(em.defaultDimensions) && em.defaultDimensions > 0)) {
        errors.push('embeddings.defaultDimensions: must be a positive integer');
      }
      // 余额探测凭据（可选）：阿里云 BSS 只读 RAM 子账号 AK —— 配齐才探测百炼
      // 「API 按量付费」可用余额；缺失时展示位维持静态声明（无余额区块）。
      // ⚠ 与其他 ref 同法：值必须是 "env:VAR" 引用，绝不落真实凭据
      for (const k of ['balanceAccessKeyIdRef', 'balanceAccessKeySecretRef']) {
        if (em[k] !== undefined && em[k] !== null && (typeof em[k] !== 'string' || !em[k])) {
          errors.push(`embeddings.${k}: optional non-empty ref string (e.g. env:ALIBABA_CLOUD_ACCESS_KEY_ID)`);
        }
      }
      if (errors.length === before) {
        embeddings = {
          type: em.type,
          apiKeyRef: em.apiKeyRef,
          workspaceIdRef: em.workspaceIdRef,
          region: typeof em.region === 'string' && em.region ? em.region : 'cn-beijing',
          models: [...em.models],
          defaultDimensions: em.defaultDimensions ?? null,
          balanceAccessKeyIdRef: em.balanceAccessKeyIdRef ?? null,
          balanceAccessKeySecretRef: em.balanceAccessKeySecretRef ?? null,
        };
      }
    }
  }

  // visionRouting 交叉校验（v1 reroute）：target 必须由某 provider 声明且其所有
  // owner 均声明 image 模态；配了 visionRouting 的模型自己不得声明 image（仅
  // text-only 模型可配）；同一模型跨 provider 声明必须完全一致
  //（运行时 findVisionRouting 取第一个声明，此处校验保证无歧义）。
  {
    const ownersOf = new Map(); // modelId → [{idx, norm}]（所有声明方）
    for (const [idx, norm] of normalizedModels) {
      for (const mid of norm.ids) {
        if (!ownersOf.has(mid)) ownersOf.set(mid, []);
        ownersOf.get(mid).push({ idx, norm });
      }
    }
    const seenRules = new Map(); // modelId → 首个声明
    for (const [idx, norm] of normalizedModels) {
      for (const [mid, rule] of Object.entries(norm.routing)) {
        const where = `providers[${idx}].models[${mid}].visionRouting`;
        const prev = seenRules.get(mid);
        if (prev) {
          if (prev.strategy !== rule.strategy || prev.target !== rule.target
            || (prev.uncertain ?? 'pixels') !== (rule.uncertain ?? 'pixels')) {
            errors.push(`${where}: model "${mid}" visionRouting declarations differ across providers`);
          }
          continue;
        }
        seenRules.set(mid, rule);
        const targetOwners = ownersOf.get(rule.target);
        if (!targetOwners?.length) {
          errors.push(`${where}.target: "${rule.target}" is not declared by any provider`);
        } else {
          const lacking = targetOwners
            .filter(({ norm: on }) => !(on.defs[rule.target] ?? []).includes('image'))
            .map(({ idx: oi }) => providers[oi]?.id ?? `providers[${oi}]`);
          if (lacking.length) {
            errors.push(`${where}.target: "${rule.target}" must declare image modality (missing on ${lacking.join(', ')})`);
          }
        }
        const selfImage = (ownersOf.get(mid) ?? [])
          .filter(({ norm: on }) => (on.defs[mid] ?? []).includes('image'))
          .map(({ idx: oi }) => providers[oi]?.id ?? `providers[${oi}]`);
        if (selfImage.length) {
          errors.push(`${where}: model "${mid}" already declares image modality (${selfImage.join(', ')}); visionRouting is for text-only models`);
        }
      }
    }
  }

  const gateway = raw.gateway ?? {};
  const secretRef = /^env:[A-Z_][A-Z0-9_]*$/;
  if (gateway.adminKeyRef !== undefined && (typeof gateway.adminKeyRef !== 'string' || !secretRef.test(gateway.adminKeyRef))) errors.push('gateway.adminKeyRef: expected env:VARIABLE');
  if (gateway.host !== undefined && typeof gateway.host !== 'string') errors.push('gateway.host: must be string');
  if (gateway.port !== undefined && !Number.isInteger(gateway.port)) errors.push('gateway.port: must be integer');
  const rawKeys = gateway.keys ?? [];
  // per-app key 归因（2026-10-26 方案）：条目两种形态，归一化为 {key, app} 列表 ——
  //   - 裸字符串 "env:VAR" / "literal" → { key, app: 'shared' }（兼容旧配置）
  //   - { key: <value-or-env-ref>, app: <slug> } → 结构化（app 缺省 'shared'）
  // 归一化白名单同步新结构（防「配置归一化丢新键」旧坑）：router/usage 只消费
  // 归一化后的 {key, app, note?}；app 进 usage 记录的 client 维度与 /usage 来源筛选。
  const keys = [];
  const seenApps = new Set();
  const seenRefs = new Set();
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    errors.push('gateway.keys: required non-empty list');
  } else {
    rawKeys.forEach((k, i) => {
      if (typeof k === 'string' && k.length > 0) {
        keys.push({ key: k, app: 'shared' });
      } else if (k && typeof k === 'object' && !Array.isArray(k) &&
        typeof k.key === 'string' && k.key.length > 0) {
        keys.push({ key: k.key, app: k.app === undefined ? 'shared' : k.app,
          ...(k.note !== undefined ? { note: k.note } : {}) });
      } else {
        errors.push(`gateway.keys[${i}]: must be non-empty string or {key, app, note?}`);
        return;
      }
      const entry = keys.at(-1);
      const where = `gateway.keys[${i}]`;
      if (typeof entry.app !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.app)) {
        errors.push(`${where}.app: must match ^[a-z0-9][a-z0-9-]*$`);
      } else if (seenApps.has(entry.app)) errors.push(`${where}.app: duplicate app "${entry.app}"`);
      seenApps.add(entry.app);
      if (entry.note !== undefined && typeof entry.note !== 'string') errors.push(`${where}.note: must be string`);
      // env:VAR 与 env:VAR:default 均引用同一变量；报错不泄露字面量 key。
      const refId = entry.key.startsWith('env:') ? entry.key.split(':').slice(0, 2).join(':') : entry.key;
      if (seenRefs.has(refId)) errors.push(`${where}.key: duplicate key reference`);
      seenRefs.add(refId);
    });
  }

  // per-attempt 超时（issue #3）：流式/非流式各自上限（秒）；超时归 network 类失败
  const timeouts = {
    requestSec: num(gateway.timeouts?.requestSec, 120),
    streamSec: num(gateway.timeouts?.streamSec, 300),
  };
  for (const [k, v] of Object.entries(timeouts)) {
    if (!Number.isFinite(v) || v <= 0) errors.push(`gateway.timeouts.${k}: must be a positive number (seconds)`);
  }
  // provider 熔断器（issue #3）：连续 N 次请求路径 retriable 失败 → 冷却降级到链尾
  const circuit = {
    enabled: gateway.circuit?.enabled ?? true,
    failureThreshold: num(gateway.circuit?.failureThreshold, 3),
    cooldownSec: num(gateway.circuit?.cooldownSec, 120),
  };
  if (typeof circuit.enabled !== 'boolean') errors.push('gateway.circuit.enabled: must be boolean');
  if (!Number.isInteger(circuit.failureThreshold) || circuit.failureThreshold < 1) {
    errors.push('gateway.circuit.failureThreshold: must be an integer >= 1');
  }
  if (!Number.isFinite(circuit.cooldownSec) || circuit.cooldownSec <= 0) {
    errors.push('gateway.circuit.cooldownSec: must be a positive number (seconds)');
  }

  // pricing：可选模型定价覆盖（$/Mtok），用于使用统计成本折算；缺省从 models.dev 取
  const pricingRaw = raw.pricing ?? {};
  if (typeof pricingRaw !== 'object' || Array.isArray(pricingRaw)) {
    errors.push('pricing: optional mapping of modelId -> {input, output, cacheRead, cacheWrite} ($/Mtok)');
  } else for (const [mid, p] of Object.entries(pricingRaw)) {
    if (!p || typeof p !== 'object') { errors.push(`pricing[${mid}]: must be {input, output, cacheRead, cacheWrite}`); continue; }
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (p[k] === undefined) continue; // 缺省顶 0
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) {
        errors.push(`pricing[${mid}].${k}: must be a non-negative number ($/Mtok)`);
      }
    }
  }

  // claude 订阅监控（可选，只读）：Claude 消费级订阅（Pro/Max）的额度探测 +
  // 5h 窗口激活 + Claude Code 会话用量同步。不进路由 catalog —— claude 模型
  // 不可经 /v1/chat/completions 寻址。credentialFile/sessionDir 为容器内路径
  // （compose 只读挂载）；网关永不刷新 token（由 Claude Code CLI 在别处轮换）。
  let claude = null;
  if (raw.claude !== undefined && raw.claude !== null) {
    const c = raw.claude;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push('claude: must be a mapping { enabled, credentialFile, sessionDir, displayName?, badge? }');
    } else {
      const enabled = c.enabled ?? true;
      if (typeof enabled !== 'boolean') {
        errors.push('claude.enabled: must be boolean');
      } else if (enabled) {
        if (typeof c.credentialFile !== 'string' || !c.credentialFile) {
          errors.push('claude.credentialFile: required non-empty string when enabled (Claude Code .credentials.json, read-only mount)');
        }
        if (typeof c.sessionDir !== 'string' || !c.sessionDir) {
          errors.push('claude.sessionDir: required non-empty string when enabled (Claude Code projects dir for usage sync)');
        }
      }
      for (const k of ['displayName', 'badge']) {
        if (c[k] !== undefined && c[k] !== null && typeof c[k] !== 'string') {
          errors.push(`claude.${k}: optional string`);
        }
      }
      // 展示位模型（display-only）：/v1/models 露出 + dashboard 卡片展开，不进路由链
      if (c.models !== undefined && c.models !== null) {
        if (!Array.isArray(c.models) || c.models.length === 0 ||
            c.models.some((m) => typeof m !== 'string' || !m)) {
          errors.push('claude.models: optional non-empty array of model id strings (display-only, not routed)');
        }
      }
      if (enabled === true && typeof c.credentialFile === 'string' && c.credentialFile &&
          typeof c.sessionDir === 'string' && c.sessionDir) {
        claude = {
          enabled: true,
          credentialFile: c.credentialFile,
          sessionDir: c.sessionDir,
          displayName: typeof c.displayName === 'string' ? c.displayName : null,
          badge: typeof c.badge === 'string' ? c.badge : null,
          // 展示位模型经 /v1/models 露出；normalize 保证总是数组（路由层免判空）
          models: Array.isArray(c.models) ? c.models : [],
        };
      }
    }
  }

  if (errors.length > 0) {
    const err = new ConfigError(`${source}: invalid config — ${errors.join('; ')}`);
    err.errors = errors;
    throw err;
  }

  const probe = coerceJobNumbers(raw.jobs?.probe ?? {}, {
    intervalSec: 300,
    cacheTtlSec: 300,
    backoffStartSec: 60,
    backoffMaxSec: 3600,
    timeoutSec: 15,
  });
  const activate = {
    enabled: raw.jobs?.activate?.enabled ?? true,
    model: raw.jobs?.activate?.model ?? null,
    // codex(ChatGPT) 激活用模型：未配置 → null（activator 跳过 codex）。
    // 2026-09-25 修复：此前归一化白名单漏掉该字段，config.yaml 里的 codexModel
    // 被静默丢弃 → codex 5h 窗口激活从未运行（GLM 正常，事件零记录）。
    codexModel: raw.jobs?.activate?.codexModel ?? null,
    // claude(Claude 消费级订阅) 激活用模型：未配置 → null（activator 跳过 claude）。
    // 2026-09-25 codexModel 白名单丢键事故的同型预防：加激活模型键必须同步本
    // 归一化白名单 + window-activator DEFAULTS，否则 config.yaml 静默丢弃。
    claudeModel: raw.jobs?.activate?.claudeModel ?? null,
    // claude 激活执行方式：host-cli = 委托真 Claude Code CLI 执行器（唯一形态；
    // 2026-10-14 实测订阅 OAuth /v1/messages 客户端指纹门控，进程内直发 429）
    claudeRunner: raw.jobs?.activate?.claudeRunner ?? 'host-cli',
    // 真 CLI 执行器超时（冷启动含插件装载；领取回合 TTL = 本值 + 30s）
    claudeCliTimeoutSec: num(raw.jobs?.activate?.claudeCliTimeoutSec, 180),
    // token-refresh 哨兵提前量（秒）：凭据 expiresAt 距今 <= 本值时发放
    // token-refresh 回合（真 CLI 启动即轮换 OAuth token；8h TTL × CLI 惰性
    // 刷新 → 不补则每 ~10h 有 ~2h40m 的 401 空窗）。0 = 关闭主动哨兵。
    claudeTokenRefreshMarginSec: num(raw.jobs?.activate?.claudeTokenRefreshMarginSec, 900),
    // 订阅级额度（周/月上限）用完 → 跳过 5h 窗口激活（不发请求、不告警）
    skipWhenExhausted: raw.jobs?.activate?.skipWhenExhausted ?? true,
    delaySec: num(raw.jobs?.activate?.delaySec, 60),
    giveUpAfterSec: num(raw.jobs?.activate?.giveUpAfterSec, 900),
    maxTokens: num(raw.jobs?.activate?.maxTokens, 1),
    timeoutSec: num(raw.jobs?.activate?.timeoutSec, 30),
    backoffStartSec: num(raw.jobs?.activate?.backoffStartSec, 120),
    backoffMaxSec: num(raw.jobs?.activate?.backoffMaxSec, 3600),
  };
  // prompt 仅在显式配置时透传（键缺省保持 activator 内置默认，不用 null 覆盖）
  if (typeof raw.jobs?.activate?.prompt === 'string' && raw.jobs?.activate?.prompt) {
    activate.prompt = raw.jobs.activate.prompt;
  }
  if (typeof activate.enabled !== 'boolean') {
    throw new ConfigError('jobs.activate.enabled: must be boolean');
  }
  if (typeof activate.skipWhenExhausted !== 'boolean') {
    throw new ConfigError('jobs.activate.skipWhenExhausted: must be boolean');
  }
  if (activate.codexModel !== null && typeof activate.codexModel !== 'string') {
    throw new ConfigError('jobs.activate.codexModel: optional string (codex/ChatGPT 激活用模型)');
  }
  if (activate.claudeModel !== null && typeof activate.claudeModel !== 'string') {
    throw new ConfigError('jobs.activate.claudeModel: optional string (claude 订阅 5h 窗口激活用模型)');
  }
  if (activate.claudeRunner !== 'host-cli') {
    throw new ConfigError("jobs.activate.claudeRunner: only 'host-cli' is supported (direct in-process requests are fingerprint-gated 429)");
  }
  if (!Number.isFinite(activate.claudeCliTimeoutSec) || activate.claudeCliTimeoutSec <= 0) {
    throw new ConfigError('jobs.activate.claudeCliTimeoutSec: must be a positive number');
  }
  if (!Number.isFinite(activate.claudeTokenRefreshMarginSec) || activate.claudeTokenRefreshMarginSec < 0) {
    throw new ConfigError('jobs.activate.claudeTokenRefreshMarginSec: must be a number >= 0 (seconds)');
  }
  if (activate.enabled && !activate.model) {
    throw new ConfigError('jobs.activate.model: required when activation enabled');
  }

  // codex 全局重置预测（codex-reset.com，纯展示）：dashboard codex 卡片
  // 展示 24h/48h 重置概率并外链原站；不参与路由/激活决策。
  const forecastRaw = raw.codexResetForecast ?? {};
  if (typeof forecastRaw !== 'object' || Array.isArray(forecastRaw)) {
    throw new ConfigError('codexResetForecast: optional mapping { enabled, url, intervalSec }');
  }
  const codexResetForecast = {
    enabled: forecastRaw.enabled ?? true,
    ...(typeof forecastRaw.url === 'string' && forecastRaw.url ? { url: forecastRaw.url } : {}),
    ...(Number.isFinite(forecastRaw.intervalSec) ? { intervalSec: forecastRaw.intervalSec } : {}),
  };
  if (typeof codexResetForecast.enabled !== 'boolean') {
    throw new ConfigError('codexResetForecast.enabled: must be boolean');
  }

  const modelGuard = {
    enabled: raw.jobs?.modelGuard?.enabled ?? false,
    dryRun: raw.jobs?.modelGuard?.dryRun ?? true,
    intervalHours: num(raw.jobs?.modelGuard?.intervalHours, 24),
    modelsDevUrl: raw.jobs?.modelGuard?.modelsDevUrl ?? 'https://models.dev/api.json',
    threshold: num(raw.jobs?.modelGuard?.threshold, 1.3),
    notifyOnNoChange: raw.jobs?.modelGuard?.notifyOnNoChange ?? false,
  };
  if (typeof modelGuard.enabled !== 'boolean') throw new ConfigError('jobs.modelGuard.enabled: must be boolean');
  if (typeof modelGuard.dryRun !== 'boolean') throw new ConfigError('jobs.modelGuard.dryRun: must be boolean');
  if (typeof modelGuard.notifyOnNoChange !== 'boolean') throw new ConfigError('jobs.modelGuard.notifyOnNoChange: must be boolean');
  if (!Number.isFinite(modelGuard.intervalHours) || modelGuard.intervalHours <= 0) {
    throw new ConfigError('jobs.modelGuard.intervalHours: must be a positive number');
  }
  if (!Number.isFinite(modelGuard.threshold) || modelGuard.threshold < 1) {
    throw new ConfigError('jobs.modelGuard.threshold: must be >= 1');
  }

  for (const key of ['observedUsage','codexUsage','modelInbox','agentEndpoints','dashboard']) if (raw[key] !== undefined && (!raw[key] || typeof raw[key] !== 'object' || Array.isArray(raw[key]))) throw new ConfigError(`${key}: expected a mapping`);
  const dashboard = {};
  if (raw.dashboard?.accessKeyRef !== undefined) {
    if (typeof raw.dashboard.accessKeyRef !== 'string' || !secretRef.test(raw.dashboard.accessKeyRef)) throw new ConfigError('dashboard.accessKeyRef: expected env:VARIABLE');
    dashboard.accessKeyRef = raw.dashboard.accessKeyRef;
  }
  if (raw.dashboard?.public !== undefined) {
    if (typeof raw.dashboard.public !== 'boolean') throw new ConfigError('dashboard.public: expected boolean');
    dashboard.public = raw.dashboard.public;
  }
  // Mac 采集器推送的订阅用量接收端（Codex + Claude Code）；codexUsage 为旧名，两者同义
  const receiverRaw = raw.observedUsage ?? raw.codexUsage;
  const observedUsage = { enabled: receiverRaw?.enabled ?? false, apiKeyRef: receiverRaw?.apiKeyRef ?? null };
  if (receiverRaw?.apiKeyRef !== undefined && (typeof receiverRaw.apiKeyRef !== 'string' || !secretRef.test(receiverRaw.apiKeyRef))) throw new ConfigError('observedUsage.apiKeyRef: expected env:VARIABLE');
  if (receiverRaw?.devices !== undefined) {
    if (!Array.isArray(receiverRaw.devices)) throw new ConfigError('observedUsage.devices: expected an array');
    const names = new Set();
    observedUsage.devices = receiverRaw.devices.map((device) => {
      if (!device || typeof device.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(device.name) || names.has(device.name)) throw new ConfigError('observedUsage.devices: expected unique device names');
      if (typeof device.keyRef !== 'string' || !secretRef.test(device.keyRef)) throw new ConfigError('observedUsage.devices.keyRef: expected env:VARIABLE');
      names.add(device.name);
      return { name: device.name, keyRef: device.keyRef };
    });
  }
  if (typeof observedUsage.enabled !== 'boolean' || (observedUsage.enabled && !observedUsage.apiKeyRef && !observedUsage.devices?.length)) throw new ConfigError('observedUsage: enabled requires apiKeyRef: env:VARIABLE or devices');
  const codexUsage = observedUsage;
  // Agent 端点映射来源：skills 仓 distribution.json（只读挂载）；缺省 = 不读取，页面全部归为业务应用
  const agentEndpoints = { file: raw.agentEndpoints?.file ?? null, intervalSec: raw.agentEndpoints?.intervalSec ?? 600 };
  if (agentEndpoints.file !== null && (typeof agentEndpoints.file !== 'string' || !agentEndpoints.file)) throw new ConfigError('agentEndpoints.file: expected a file path');
  if (!Number.isInteger(agentEndpoints.intervalSec) || agentEndpoints.intervalSec < 30) throw new ConfigError('agentEndpoints.intervalSec: integer >= 30');
  const modelInbox = { publicUrl: raw.modelInbox?.publicUrl ?? null };
  if (modelInbox.publicUrl !== null) {
    let url; try { url = new URL(modelInbox.publicUrl); } catch { throw new ConfigError('modelInbox.publicUrl: expected http(s) URL'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new ConfigError('modelInbox.publicUrl: expected http(s) URL without credentials');
  }
  const topologyProviders = new Set(providers.map((p) => p.id));
  if (claude?.enabled || observedUsage.enabled) topologyProviders.add('claude');
  if (observedUsage.enabled || providers.some((p) => p.type === 'codex')) topologyProviders.add('codex-local');
  const topology = normalizeTopology(raw.topology, { apps: new Set(keys.map((k) => k.app)), providers: topologyProviders });
  return {
    source,
    gateway: {
      host: gateway.host ?? '0.0.0.0',
      port: gateway.port ?? 8080,
      keys,
      ...(gateway.adminKeyRef === undefined ? {} : { adminKeyRef: gateway.adminKeyRef }),
      timeouts,
      circuit,
    },
    providers: providers.map((p, idx) => {
      const norm = normalizedModels.get(idx) ?? { ids: [...(p.models ?? [])].filter((m) => typeof m === 'string'), defs: {}, routing: {} };
      const base = {
        id: p.id,
        displayName: typeof p.displayName === 'string' ? p.displayName : null,
        badge: typeof p.badge === 'string' ? p.badge : null,
        models: norm.ids,
        modelDefs: norm.defs,
        visionRouting: norm.routing,
        fallbackModelMap: p.fallbackModelMap ?? {},
      };
      return p.type === 'codex'
        ? {
            ...base,
            type: p.type,
            baseUrl: p.baseUrl ?? null, // backend base override (optional; default chatgpt.com)
            originator: p.originator ?? null, // upstream telemetry label (e.g. "pi"; null → client default)
            apiKeyRef: null,
          }
        : {
            ...base,
            type: p.type,
            baseUrl: p.baseUrl,
            anthropicBaseUrl: typeof p.anthropicBaseUrl === 'string' ? p.anthropicBaseUrl.replace(/\/+$/, '') : null,
            apiKeyRef: p.apiKeyRef ?? null,
          };
    }),
    imageGeneration,
    embeddings,
    claude,
    codexResetForecast,
    observedUsage,
    dashboard,
    codexUsage,
    modelInbox,
    agentEndpoints,
    topology,
    jobs: {
      probe: { enabled: raw.jobs?.probe?.enabled ?? true, ...probe },
      activate,
      modelGuard,
    },
    pricing: normalizePricing(pricingRaw),
    notify: {
      smtpUrl: raw.notify?.smtpUrl ?? null,
      from: raw.notify?.from ?? null,
      to: raw.notify?.to ?? null,
    },
  };
}

function num(v, def) {
  return v === undefined || v === null ? def : v;
}

/** pricing 覆盖归一化：非负数缺省顶 0（$/Mtok）。 */
function normalizePricing(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [mid, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    out[mid] = {
      input: num(p.input, 0), output: num(p.output, 0),
      cacheRead: num(p.cacheRead, 0), cacheWrite: num(p.cacheWrite, 0),
    };
  }
  return out;
}

const CONFIG_BASENAMES = ['config'];
const CONFIG_EXTS = ['.yaml', '.yml', '.json'];

/** 找到配置目录下的 config 文件路径（loadConfig 同规则；找不到抛 ConfigError）。 */
export function findConfigFile(dir = 'config') {
  let found = null;
  const names = readdirSync(dir);
  for (const base of CONFIG_BASENAMES) {
    for (const ext of CONFIG_EXTS) {
      if (names.includes(base + ext)) {
        found = join(dir, base + ext);
        break;
      }
    }
    if (found) break;
  }
  if (!found) {
    throw new ConfigError(`no config file found in ${dir} (expected config.yaml|config.yml|config.json)`);
  }
  return found;
}

/**
 * Load config from a directory: config.{yaml,yml,json} (first match wins).
 * YAML parsed by the in-repo subset parser; JSON natively.
 * Throws ConfigError on missing dir/file, unreadable file, or validation failure.
 */
export function loadConfig(dir = 'config') {
  let found;
  try {
    found = findConfigFile(dir);
  } catch {
    throw new ConfigError(`config dir not readable: ${dir}`);
  }

  let text;
  try {
    text = readFileSync(found, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read ${found}: ${e.message}`);
  }

  let raw;
  try {
    raw = extname(found) === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ConfigError(`cannot parse ${found}: ${e.message}`);
  }
  return validateConfig(raw, { source: found });
}

/** provider 展示名：displayName 非空用之，否则 id。 */
export function providerDisplayName(p) {
  return typeof p.displayName === 'string' && p.displayName ? p.displayName : p.id;
}
