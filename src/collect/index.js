// Cross-platform observed usage collector.
import { homedir, hostname } from 'node:os';
import { posix, win32 } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolvePaths } from '../paths.js';
import { SOURCES } from '../monitor/sources/index.js';
import { syncObserved } from '../monitor/observed-push.js';
import { detectAgents, fingerprint, runHook, sendHeartbeat } from './device.js';

// device-agent（MG28）：DEVICE_ENROLL_KEY（未注册时只发心跳）、COLLECT_PRE_HOOK（每轮前置命令，
// 如 git pull + converge.py apply --self）、SKILLS_DISTRIBUTION（agent 检测规则来源）、
// COLLECT_HEARTBEAT=0 关闭心跳、DEVICE_UUID / DEVICE_PLATFORM 覆盖指纹。
const ENV_KEYS = ['MODEL_GATEWAY_URL', 'USAGE_SYNC_KEY', 'CODEX_USAGE_SYNC_KEY', 'CODEX_SESSION_DIR', 'CODEX_USAGE_STATE_FILE', 'CLAUDE_PROJECTS_DIR', 'USAGE_SYNC_STATE_DIR', 'USAGE_SYNC_DEVICE',
  'DEVICE_ENROLL_KEY', 'COLLECT_PRE_HOOK', 'SKILLS_DISTRIBUTION', 'COLLECT_HEARTBEAT', 'DEVICE_UUID', 'DEVICE_PLATFORM'];

export function normalizeDevice(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'device';
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个参数`);
  return value;
}

export async function runCollect({
  argv = [], env = process.env, platform = process.platform, home = homedir(),
  fetchFn = fetch, log = console, defaultDevice = normalizeDevice(hostname()), requireEnvFile = true,
  device: deviceDeps = {},
} = {}) {
  const report = (level, message) => typeof log === 'function' ? log(message) : log[level](message);
  if (argv.includes('--help')) {
    report('log', `用法：model-gateway collect [--env-file <file>] [--once] [--device NAME] [--sources=${[...SOURCES.keys()].join(',')}]（device-agent：DEVICE_ENROLL_KEY / COLLECT_PRE_HOOK / SKILLS_DISTRIBUTION，见 docs/collect.md）`);
    return 0;
  }
  const join = platform === 'win32' ? win32.join : posix.join;
  env = { ...env };
  const explicitFile = option(argv, '--env-file');
  const envFile = explicitFile ?? (requireEnvFile ? join(resolvePaths({ platform, env, home }).configDir, 'collect.env') : null);
  if (envFile && (explicitFile || existsSync(envFile))) {
    if (platform !== 'win32' && (statSync(envFile).mode & 0o777) !== 0o600) {
      throw new Error('请提供权限为 600 的采集器环境文件');
    }
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!match || !ENV_KEYS.includes(match[1])) continue;
      const value = match[2].trim();
      env[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
    }
  }
  let gateway;
  try { gateway = new URL(env.MODEL_GATEWAY_URL); } catch { throw new Error('请设置 MODEL_GATEWAY_URL'); }
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password) throw new Error('网关地址必须为不含凭据的 http(s) URL');
  const key = env.USAGE_SYNC_KEY ?? env.CODEX_USAGE_SYNC_KEY;
  const enrollKey = env.DEVICE_ENROLL_KEY;
  // 未注册设备只持入网 key：只发心跳，不推用量（不落默认设备名）
  if (!key && !enrollKey) throw new Error('请设置 USAGE_SYNC_KEY（或未注册设备的 DEVICE_ENROLL_KEY）');
  // 心跳 opt-in：显式 COLLECT_HEARTBEAT=1，或配置了任一 device-agent 键；旧采集器行为不变
  const heartbeat = env.COLLECT_HEARTBEAT === '1' || (env.COLLECT_HEARTBEAT !== '0' && Boolean(enrollKey || env.SKILLS_DISTRIBUTION || env.COLLECT_PRE_HOOK));
  const device = option(argv, '--device') ?? env.USAGE_SYNC_DEVICE ?? defaultDevice;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(device)) throw new Error('device 必须为最多 32 位的小写字母、数字或连字符');
  const sourcesArg = argv.find((a) => a.startsWith('--sources='));
  const sources = sourcesArg ? sourcesArg.slice('--sources='.length).split(',').filter(Boolean) : [...SOURCES.keys()];
  if (!sources.every((s) => SOURCES.has(s))) throw new Error(`--sources 只支持 ${[...SOURCES.keys()].join(',')}`);
  const { stateDir } = resolvePaths({ platform, env, home });
  // Preserve deployed environment overrides and cursor names; new sources use defaults.
  const legacy = {
    codex: { projectsDir: env.CODEX_SESSION_DIR, stateFile: env.CODEX_USAGE_STATE_FILE },
    'claude-code': { projectsDir: env.CLAUDE_PROJECTS_DIR, cursorName: 'claude-usage.json' },
  };
  const plans = Object.fromEntries([...SOURCES.values()].map((source) => {
    const overrides = legacy[source.id] ?? {};
    const paths = source.defaultPaths({ platform, home });
    if (overrides.projectsDir !== undefined) paths.projectsDir = overrides.projectsDir;
    return [source.id, {
      stateFile: overrides.stateFile ?? join(stateDir, overrides.cursorName ?? `${source.id}-usage.json`),
      collect: (state) => source.collect({ paths, state, now: Date.now() }),
    }];
  }));
  const once = argv.includes('--once');
  let delay = 1000;
  let finger = null;
  for (;;) {
    let failed = false, full = false;
    const converge = await runHook(env.COLLECT_PRE_HOOK, deviceDeps).catch((error) => ({ ok: false, error: error.message }));
    if (converge) report(converge.ok ? 'log' : 'error', `[device-agent] 前置钩子${converge.ok ? '完成' : '失败'}${converge.changed !== undefined ? `，变更 ${converge.changed}` : ''}${converge.error ? `：${converge.error}` : ''}`);
    if (heartbeat) {
      try {
        finger ??= await fingerprint({ platform, env, ...deviceDeps });
        if (!finger.uuid) throw new Error('无法读取硬件 UUID（可设 DEVICE_UUID）');
        const agents = detectAgents({ file: env.SKILLS_DISTRIBUTION, home, ...deviceDeps });
        const ack = await sendHeartbeat({ url: env.MODEL_GATEWAY_URL, key: key ?? enrollKey, payload: { ...finger, agents, ...(converge ? { converge } : {}) }, fetchFn });
        report('log', `[device-agent] 心跳已上报（${ack.enrolled ? `设备 ${ack.device}` : '待注册'}）`);
      } catch (error) {
        // 心跳失败不触发用量退避（旧网关无此端点时只记日志）；仅入网模式下计为失败
        if (!key) failed = true;
        report('error', `[device-agent] ${error.message}`);
      }
    }
    for (const source of key ? sources : []) {
      try {
        const count = await syncObserved({ source, device, url: env.MODEL_GATEWAY_URL, key, fetchFn, ...plans[source] });
        report('log', `[usage-sync] ${source} 已同步 ${count} 条计数`);
        if (count === 500) full = true;
      } catch (error) {
        failed = true;
        report('error', `[usage-sync] ${source} ${error.message}`);
      }
    }
    if (once) {
      if (failed) return 1;
      if (!full) return 0;
      continue;
    }
    delay = failed ? Math.min(Math.max(delay * 2, 30000), 1800000) : full ? 1000 : 300000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
