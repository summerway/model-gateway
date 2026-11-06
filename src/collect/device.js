// device.js — device-agent 的设备侧能力（MG28）：硬件指纹、agent 检测、前置钩子、心跳上报。
// 由 `model-gateway collect` 每轮调用：前置钩子（如 git pull + converge.py apply --self）→ 心跳 → 用量推送。
// 网关仓不感知 skills 仓：钩子是任意命令，agent 检测规则读 distribution.json（v2 agents[*].detect）。

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname as osHostname, release, type } from 'node:os';
import { posix } from 'node:path';

const run = (file, args, { timeout = 10_000 } = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(error?.killed) });
  });
});

/** 本机硬件指纹：DEVICE_UUID 覆盖 > Mac IOPlatformUUID > Linux machine-id。 */
export async function fingerprint({ platform = process.platform, env = process.env, exec = run, readFile = readFileSync } = {}) {
  let uuid = env.DEVICE_UUID || null;
  let model = null;
  if (platform === 'darwin') {
    if (!uuid) {
      const r = await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout)?.[1] ?? null;
    }
    const m = await exec('/usr/sbin/sysctl', ['-n', 'hw.model']);
    model = m.code === 0 ? m.stdout.trim() || null : null;
  } else if (!uuid) {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { uuid = readFile(file, 'utf8').trim() || null; } catch { /* next */ }
      if (uuid) break;
    }
  }
  const PLATFORM = { darwin: 'mac', linux: 'linux', win32: 'windows' };
  return {
    uuid, model,
    hostname: osHostname(),
    platform: env.DEVICE_PLATFORM || PLATFORM[platform] || platform,
    os: `${type()} ${release()}`.slice(0, 64),
  };
}

/** distribution.json v2 的 agents[*].detect：任一路径存在 → 检测到该 agent。读不到文件 → []。 */
export function detectAgents({ file, home, exists = existsSync, readFile = readFileSync }) {
  if (!file) return [];
  let agents;
  try { agents = JSON.parse(readFile(file, 'utf8'))?.agents; } catch { return []; }
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return [];
  const out = [];
  for (const [agent, def] of Object.entries(agents)) {
    for (const raw of Array.isArray(def?.detect) ? def.detect : []) {
      if (typeof raw !== 'string' || !raw) continue;
      const path = raw === '~' ? home : raw.startsWith('~/') ? posix.join(home, raw.slice(2)) : raw;
      if (exists(path)) { out.push({ agent, path }); break; }
    }
  }
  return out;
}

/**
 * 前置钩子：`sh -c <hook>`，超时 120s；失败不阻断心跳与用量。
 * stdout 末尾若是 converge.py 的 JSON 报告，提取 ok / changed 进心跳 converge 字段。
 */
export async function runHook(hook, { exec = run, now = () => new Date() } = {}) {
  if (!hook) return null;
  const r = await exec('/bin/sh', ['-c', hook], { timeout: 120_000 });
  const result = { ok: r.code === 0, at: now().toISOString() };
  const start = r.stdout.search(/^\{/m);
  if (start >= 0) {
    try {
      const rep = JSON.parse(r.stdout.slice(start));
      if (typeof rep.ok === 'boolean') result.ok = r.code === 0 && rep.ok;
      const changed = Object.values(rep.endpoints ?? {}).reduce((n, e) => n + (Number.isInteger(e?.changed) ? e.changed : 0), 0);
      result.changed = changed;
    } catch { /* not a converge report */ }
  }
  if (!result.ok) result.error = (r.timedOut ? '钩子超时' : (r.stderr.trim() || r.stdout.trim()).split('\n').at(-1) || `退出码 ${r.code}`).slice(0, 200);
  return result;
}

/** POST /internal/devices/heartbeat；返回网关响应 { ok, device, enrolled }。 */
export async function sendHeartbeat({ url, key, payload, fetchFn = fetch }) {
  const res = await fetchFn(new URL('/internal/devices/heartbeat', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`心跳失败 HTTP ${res.status}`);
  return res.json();
}
