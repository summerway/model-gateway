// agent-endpoints.js — 设备 / agent / 端点注册表的只读视图：skills 仓 distribution.json（唯一数据源）。
// v2（docs/plan/2026-11-06-device-registry.md §3）：agents（名称/图标/检测规则）、devices（设备 Tag、
// platform、指纹）、endpoints（agent + devices[] + dir）；页面名称、图标、设备 Tag 全部取自文件。
// v1（过渡期双读，MG30 删除）：endpoints 只有 type，mac-symlink → 本地（Mac）、nas-dist-dir → 云端（NAS）。
// endpoint id 与 gateway.keys[].app 对应；agent key 另带 device（agent × 设备）。
// 启动读一次、之后定时重读；文件缺失/解析失败/约束违例 → 保留上次结果并标 stale（首读失败 → 空映射）。
// skills-admin 服务只跑在 Mac 127.0.0.1，NAS 上的网关访问不到，所以读文件而不是调它的 API。

import { readFileSync } from 'node:fs';

const LOCATION = { 'mac-symlink': 'local', 'nas-dist-dir': 'cloud' };
const PLATFORM_LOCATION = { mac: 'local', nas: 'cloud' };
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** endpoint id → 官方应用名（两套系统统一规则：应用图标 + 端点角标 + 官方名称；未知 → id 原样）。 */
const OFFICIAL_NAME = [
  [/claude/, 'Claude Code'],
  [/codex/, 'Codex'],
  [/openclaw/, 'OpenClaw'],
  [/(^|-)pi(-|$)/, 'Pi'],
];

/** v1 兜底：endpoint id → 页面图标类型（未识别 → null，页面只显示名称）。 */
export function iconKindOf(id) {
  if (/claude/.test(id)) return 'claudecode';
  if (/codex/.test(id)) return 'codex';
  if (/openclaw/.test(id)) return 'openclaw';
  if (/(^|-)pi(-|$)/.test(id)) return 'pi';
  return null;
}

/** v1 兜底：endpoint id → 官方应用名（未识别 → id 原样）；v2 取 agents[agent].label。 */
export function officialNameOf(id) {
  return OFFICIAL_NAME.find(([re]) => re.test(id))?.[1] ?? id;
}

const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function parseV1(endpoints) {
  const rank = { local: 0, cloud: 1, unknown: 2 };
  const agents = Object.entries(endpoints)
    .map(([app, ep]) => ({ app, iconKind: iconKindOf(app), location: LOCATION[ep?.type] ?? 'unknown', label: officialNameOf(app) }))
    .sort((a, b) => rank[a.location] - rank[b.location]);
  return { version: 1, agents, devices: [] };
}

function parseV2(doc) {
  const { agents: catalog, devices: rawDevices, endpoints } = doc;
  if (!isMap(catalog)) throw new Error('distribution.json: agents 不是映射');
  if (!isMap(rawDevices)) throw new Error('distribution.json: devices 不是映射');
  const devices = Object.entries(rawDevices).map(([id, d]) => {
    if (!SLUG.test(id)) throw new Error(`distribution.json: 设备 id 非法 ${id}`);
    if (!isMap(d) || typeof d.platform !== 'string' || !d.platform) throw new Error(`distribution.json: 设备 ${id} 缺 platform`);
    return { id, label: typeof d.label === 'string' && d.label ? d.label : id, platform: d.platform, uuid: d.match?.uuid || null };
  });
  const byId = new Map(devices.map((d) => [d.id, d]));
  const agents = Object.entries(endpoints).map(([app, ep]) => {
    if (!isMap(ep) || !isMap(catalog[ep.agent])) throw new Error(`distribution.json: 端点 ${app} 的 agent 未在 agents 中声明`);
    if (!Array.isArray(ep.devices)) throw new Error(`distribution.json: 端点 ${app} 缺 devices`);
    const unknown = ep.devices.filter((d) => !byId.has(d));
    if (unknown.length) throw new Error(`distribution.json: 端点 ${app} 引用未知设备 ${unknown.join(',')}`);
    const platforms = new Set(ep.devices.map((d) => byId.get(d).platform));
    if (platforms.size > 1) throw new Error(`distribution.json: 端点 ${app} 绑定的设备 platform 不一致`);
    const platform = [...platforms][0] ?? null;
    const a = catalog[ep.agent];
    return {
      app, agent: ep.agent, label: typeof a.label === 'string' && a.label ? a.label : ep.agent,
      iconKind: typeof a.icon === 'string' && a.icon ? a.icon : null,
      platform, devices: [...ep.devices], location: PLATFORM_LOCATION[platform] ?? 'unknown',
    };
  });
  // 设备顺序 = 文件顺序；端点按首个绑定设备的顺序排，未绑定设备的最后（同组保持文件顺序）
  const order = new Map(devices.map((d, i) => [d.id, i]));
  const rank = (a) => (a.devices.length ? Math.min(...a.devices.map((d) => order.get(d))) : devices.length);
  agents.sort((a, b) => rank(a) - rank(b));
  return { version: 2, agents, devices };
}

/** distribution.json 文本 → { version, agents, devices }。 */
export function parseRegistry(text) {
  const doc = JSON.parse(text);
  const endpoints = doc?.endpoints;
  if (!isMap(endpoints)) throw new Error('distribution.json: endpoints 不是映射');
  if (doc.version === 2) return parseV2(doc);
  if (doc.version !== undefined && doc.version !== 1) throw new Error(`distribution.json: 不支持的 version ${doc.version}`);
  return parseV1(endpoints);
}

/** 兼容旧调用：只返回 agents 列表。 */
export function parseAgentEndpoints(text) {
  return parseRegistry(text).agents;
}

/**
 * key 设备绑定交叉校验（MG26）：只在 v2 下检查 —— app 是端点的 key 必须带 device、device 必须已注册、
 * 端点必须绑定了该设备；业务应用 key（app 不是端点）device 可选，写了也必须已注册。
 * @returns {{ app, device, reason }[]}
 */
export function keyDeviceMismatches(keys, registry) {
  if (registry?.version !== 2) return [];
  const endpoints = new Map(registry.agents.map((a) => [a.app, a]));
  const devices = new Set(registry.devices.map((d) => d.id));
  const out = [];
  for (const k of keys ?? []) {
    const app = k?.app;
    if (!app || app === 'shared') continue;
    const device = k.device ?? null;
    const ep = endpoints.get(app);
    if (device !== null && !devices.has(device)) out.push({ app, device, reason: 'device_unregistered' });
    else if (ep && device === null) out.push({ app, device, reason: 'device_missing' });
    else if (ep && !ep.devices.includes(device)) out.push({ app, device, reason: 'endpoint_not_bound' });
  }
  return out;
}

export class AgentEndpoints {
  constructor({ file = null, intervalMs = 600_000, now = Date.now, onLoad = null } = {}) {
    this.file = file;
    this.intervalMs = intervalMs;
    this.now = now;
    this.onLoad = onLoad;
    this.version = null;
    this.agents = [];
    this.devices = [];
    this.loadedAt = null;
    this.error = null;
    this.timer = null;
    this.inline = false;
  }

  load() {
    if (!this.file) return this;
    let text;
    try { text = readFileSync(this.file, 'utf8'); } catch (err) { return this.#fail(err); }
    return this.loadText(text);
  }

  /** 从文本装载（load 的解析半段；demo 模式直接注入内置注册表）。 */
  loadText(text) {
    try {
      const reg = parseRegistry(text);
      this.version = reg.version;
      this.agents = reg.agents;
      this.devices = reg.devices;
      this.loadedAt = new Date(this.now()).toISOString();
      this.error = null;
      this.inline ||= !this.file;
      try { this.onLoad?.(this.registry()); } catch (err) { console.error(`[agent-endpoints] onLoad failed: ${err.message}`); }
    } catch (err) { return this.#fail(err); }
    return this;
  }

  #fail(err) {
    // 只保留错误类别，不回显文件内容
    this.error = err.code === 'ENOENT' ? '文件不存在' : err instanceof SyntaxError ? 'JSON 解析失败' : (err.message ?? '读取失败');
    console.error(`[agent-endpoints] load failed (${this.file ?? 'inline'}): ${this.error}`);
    return this;
  }

  start() {
    if (!this.file || this.timer) return this;
    this.load();
    this.timer = setInterval(() => this.load(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  registry() {
    return { version: this.version, agents: this.agents, devices: this.devices };
  }

  snapshot() {
    return {
      agents: this.agents,
      // 硬件 UUID 只在服务端用于心跳匹配，不下发页面（看板可能免登录公开）
      devices: this.devices.map(({ uuid, ...d }) => d),
      source: { configured: Boolean(this.file || this.inline), version: this.version, loadedAt: this.loadedAt, stale: Boolean(this.error), error: this.error },
    };
  }
}
