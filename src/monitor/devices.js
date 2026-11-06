// devices.js — 设备在场视图（MG27，monitor 只读观测）：distribution.json 注册表（期望）⨝ 心跳 presence（实际）。
// 匹配：注册设备有 match.uuid → 按 UUID；没有（v2 迁移后 uuid 待补）→ 按设备 token 绑定名。
// 在线 = 距最近一次心跳 ≤ offlineAfterSec。未匹配的心跳列为 unregistered（注册在 skills-admin Inbox 完成）。
// detail=false（看板 /internal，可能免登录公开）：不含硬件 UUID 与本机路径；detail=true（/admin/v1）全量。

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/** 心跳载荷校验与裁剪：未知字段丢弃；非法 → throw。 */
export function normalizeHeartbeat(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body');
  const uuid = str(body.uuid, 128);
  if (!uuid || !/^[A-Za-z0-9-]{8,128}$/.test(uuid)) throw new Error('uuid');
  const agents = Array.isArray(body.agents) ? body.agents.slice(0, 32).flatMap((a) => {
    const agent = str(a?.agent, 32);
    return agent && SLUG.test(agent) ? [{ agent, ...(str(a.path, 512) ? { path: a.path } : {}) }] : [];
  }) : [];
  const c = body.converge;
  const converge = c && typeof c === 'object' && !Array.isArray(c) ? {
    ...(str(c.rev, 64) ? { rev: c.rev } : {}),
    ...(typeof c.ok === 'boolean' ? { ok: c.ok } : {}),
    ...(Number.isInteger(c.changed) && c.changed >= 0 ? { changed: c.changed } : {}),
    ...(str(c.at, 40) && !Number.isNaN(Date.parse(c.at)) ? { at: c.at } : {}),
    ...(str(c.error, 200) ? { error: c.error } : {}),
  } : null;
  return {
    uuid,
    hostname: str(body.hostname, 255),
    model: str(body.model, 64),
    platform: str(body.platform, 16),
    os: str(body.os, 64),
    agents,
    ...(converge ? { converge } : {}),
  };
}

// 精简视图（看板，可能公开）：不含 UUID、本机路径、os、钩子错误文本；hostname 只给未注册设备（卡片标题）
function presenceView(p, { offlineMs, now, detail, showHost = detail }) {
  if (!p) return { online: false, lastSeen: null };
  const { payload } = p;
  const c = payload.converge;
  return {
    online: now - p.lastMs <= offlineMs,
    lastSeen: p.lastSeen,
    firstSeen: p.firstSeen,
    boundDevice: p.device,
    hostname: showHost ? payload.hostname ?? null : null,
    model: payload.model ?? null,
    ...(detail ? { os: payload.os ?? null } : {}),
    detected: (payload.agents ?? []).map((a) => (detail ? a : { agent: a.agent })),
    converge: !c ? null : detail ? c : { ...(c.ok !== undefined ? { ok: c.ok } : {}), ...(c.changed !== undefined ? { changed: c.changed } : {}), ...(c.at ? { at: c.at } : {}) },
    ...(detail ? { uuid: p.uuid } : {}),
  };
}

/**
 * @param {object} o
 * @param {{ version, agents, devices }} o.registry   AgentEndpoints.registry()（含 uuid）
 * @param {object[]} o.presence                         UsageLog.listPresence()
 * @param {number} o.offlineAfterSec
 * @param {Map<string, number>} [o.tokens30d]           device → 近 30 天 tokens（可选）
 * @returns {{ devices: object[], unregistered: object[] }}
 */
export function buildDeviceView({ registry, presence = [], offlineAfterSec = 900, now = Date.now(), detail = false, tokens30d = null }) {
  const offlineMs = offlineAfterSec * 1000;
  const used = new Set();
  const regDevices = registry?.devices ?? [];
  const endpoints = registry?.agents ?? [];
  const devices = regDevices.map((d) => {
    // UUID 命中但心跳由另一台设备的 token 发来（冒用）→ 不匹配
    const p = presence.find((x) => !used.has(x.uuid) && (d.uuid ? x.uuid === d.uuid && (x.device === null || x.device === d.id) : x.device === d.id)) ?? null;
    if (p) used.add(p.uuid);
    const bound = endpoints.filter((e) => e.devices?.includes(d.id));
    const boundAgents = new Set(bound.map((e) => e.agent));
    const view = presenceView(p, { offlineMs, now, detail });
    return {
      id: d.id, label: d.label, platform: d.platform,
      endpoints: bound.map((e) => ({ app: e.app, agent: e.agent, label: e.label, iconKind: e.iconKind })),
      unboundAgents: (view.detected ?? []).filter((a) => !boundAgents.has(a.agent)),
      ...view,
      // v2 迁移后 uuid 待补：按 token 名匹配上的心跳给出建议值（只在 detail 下发）
      ...(detail ? { uuid: d.uuid, heartbeatUuid: p?.uuid ?? null, uuidPending: !d.uuid && Boolean(p) } : {}),
      ...(tokens30d ? { tokens30d: tokens30d.get(d.id) ?? 0 } : {}),
    };
  });
  const unregistered = presence.filter((p) => !used.has(p.uuid)).map((p) => ({ ...presenceView(p, { offlineMs, now, detail, showHost: true }), platform: p.payload.platform ?? null }));
  return { devices, unregistered };
}
