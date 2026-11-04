#!/usr/bin/env node
// bin/model-gateway.js — npm/npx 分发入口（MG16）。
// 子命令：init / start / config check|migrate / api / collect。
// start 只预设 env（配置目录 + 数据文件路径）后动态 import src/server.js，
// 不重构 server.js 顶层逻辑。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../src/paths.js';
import { normalizeDevice, runCollect } from '../src/collect/index.js';
import { servicePlan } from '../src/collect/service.js';

const CLI = 'model-gateway';
const HERE = dirname(fileURLToPath(import.meta.url));

function help() {
  console.log(`${CLI} — 薄 LLM 网关

用法：${CLI} <command> [options]

命令：
  init [--config-dir D] [--data-dir D] [--force]   初始化配置与数据目录（生成最小可用配置）
  start [--config-dir D] [--data-dir D]            启动网关
  config check [path]                              校验配置文件（缺省 <配置目录>/config.json）
  config migrate [dir]                             YAML 配置迁移为 JSON（Admin API 写配置需要 JSON）
  api <METHOD> <path> [--data @file|-|<json>]      调用 Admin API（path 缺省补 /admin/v1，输出原始 JSON）
  collect [--once] [--device N] [--env-file F] [--sources=codex,claude-code]
                                                   采集本机 Claude Code / Codex 订阅用量
  collect install|uninstall [--print] [--interval N] 安装/卸载当前用户的定时采集服务

选项：
  --config-dir D   配置目录（缺省见下）
  --data-dir D     数据目录（缺省见下）
  --force          init 时覆盖已存在的文件
  --help           显示本帮助

默认目录（未显式指定时）：
  Linux/macOS   $XDG_CONFIG_HOME|~/.config 下的 model-gateway
                $XDG_DATA_HOME|~/.local/share 下的 model-gateway
  Windows       %APPDATA%\\model-gateway 与 %LOCALAPPDATA%\\model-gateway
  可用环境变量 MODEL_GATEWAY_CONFIG_DIR / MODEL_GATEWAY_DATA_DIR 覆盖。

详见 docs/install.md。`);
}

/** 极简 argv 解析：--config-dir/--data-dir 取值，--force 布尔，其余按位收进 rest。 */
function parseArgs(argv) {
  const opts = { force: false, configDir: null, dataDir: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--config-dir' || a === '--data-dir') {
      const v = argv[++i];
      if (v === undefined || v === '') die(`${a} 需要一个目录参数`);
      if (a === '--config-dir') opts.configDir = v; else opts.dataDir = v;
    } else opts.rest.push(a);
  }
  return opts;
}

function die(msg, code = 1) { console.error(`✖ ${msg}`); process.exit(code); }

/** 目录决策：--config-dir/--data-dir 显式参数 > env > 平台默认。 */
function dirs(opts) {
  const env = { ...process.env };
  if (opts.configDir) env.MODEL_GATEWAY_CONFIG_DIR = opts.configDir;
  if (opts.dataDir) env.MODEL_GATEWAY_DATA_DIR = opts.dataDir;
  return resolvePaths({ env });
}

/** init 产出的最小合法配置（必须能过 validateConfig；测试有断言）。 */
function minimalConfig() {
  return {
    gateway: {
      host: '127.0.0.1',
      port: 8080,
      keys: [{ key: 'env:MODEL_GATEWAY_KEY', app: 'shared' }],
      // token 模式（MG13）：/internal/* 与 Admin API 凭 admin key；看板仅 loopback
      adminKeyRef: 'env:MODEL_GATEWAY_ADMIN_KEY',
    },
    providers: [
      {
        id: 'openai',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        apiKeyRef: 'env:OPENAI_API_KEY',
        models: ['gpt-6-luna'],
      },
    ],
    // activate 缺省 enabled 且必填 activate model（订阅 5h 窗口激活）；最小配置
    // 是纯 API key 的 OpenAI provider，无订阅可激活 → 显式关闭才是合法配置
    jobs: { activate: { enabled: false } },
  };
}

/** 简单 KEY=VALUE 解析：忽略空行与 # 注释；值去掉成对引号。 */
function parseEnvText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let value = s.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    out.push([key, value]);
  }
  return out;
}

function cmdInit(opts) {
  const { configDir, dataDir } = dirs(opts);
  const configPath = join(configDir, 'config.json');
  const envPath = join(configDir, '.env');
  const examplePath = join(configDir, '.env.example');
  const targets = [configPath, envPath, examplePath];
  const existing = targets.filter(existsSync);
  if (existing.length && !opts.force) {
    console.error(`✖ 已存在，未写入任何文件（--force 可覆盖）：\n  ${existing.join('\n  ')}`);
    process.exit(1);
  }
  const config = minimalConfig();
  // 自检：生成的最小配置必须过 validateConfig（失败属本 CLI 的 bug，不落盘）
  return import('../src/config.js').then(({ validateConfig }) => {
    validateConfig(config); // throws on invalid
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const gatewayKey = randomBytes(32).toString('hex');
    const adminKey = randomBytes(32).toString('hex');
    writeFileSync(envPath, [
      `# model-gateway 运行密钥（init 生成，权限 600）`,
      `MODEL_GATEWAY_KEY=${gatewayKey}`,
      `MODEL_GATEWAY_ADMIN_KEY=${adminKey}`,
      ``,
      `# 填入你的 OpenAI API key 后再 start`,
      `OPENAI_API_KEY=`,
      ``,
    ].join('\n'));
    try { chmodSync(envPath, 0o600); } catch { /* Windows / 受限文件系统上忽略 */ }
    writeFileSync(examplePath, 'MODEL_GATEWAY_KEY=\nMODEL_GATEWAY_ADMIN_KEY=\nOPENAI_API_KEY=\n');
    console.log(`✔ 配置目录  ${configPath}`);
    console.log(`✔ 数据目录  ${dataDir}`);
    console.log(`✔ 密钥文件  ${envPath}（已生成随机 MODEL_GATEWAY_KEY / MODEL_GATEWAY_ADMIN_KEY）`);
    console.log(`\n下一步：编辑 ${envPath} 填入 OPENAI_API_KEY，然后运行 ${CLI} start`);
  });
}

async function cmdStart(opts) {
  const { configDir, dataDir } = dirs(opts);
  const hasConfig = ['config.json', 'config.yaml', 'config.yml'].some((n) => existsSync(join(configDir, n)));
  if (!hasConfig) {
    console.error(`✖ 配置目录 ${configDir} 里没有配置文件（config.yaml|config.yml|config.json）。`);
    console.error(`  先运行：${CLI} init`);
    process.exit(1);
  }
  // .env：已有 process.env 优先，不覆盖（容器/CI 注入的值赢）
  const envFile = join(configDir, '.env');
  if (existsSync(envFile)) {
    for (const [k, v] of parseEnvText(readFileSync(envFile, 'utf8'))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
  // 数据文件默认落 dataDir（未显式设置时）；pricing 缓存、model-guard、claude-sync
  // 状态文件由 server.js 兜底为 EVENT_LOG_FILE 同目录，无需逐个设置
  const defaults = {
    MODEL_GATEWAY_CONFIG_DIR: configDir,
    EVENT_LOG_FILE: join(dataDir, 'events.jsonl'),
    USAGE_LOG_FILE: join(dataDir, 'usage.jsonl'),
    USAGE_DB_FILE: join(dataDir, 'usage.db'),
    MODEL_INBOX_STATE_FILE: join(dataDir, 'model-inbox.json'),
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
  await import('../src/server.js'); // import 即启动；进程由 server 持有
  return undefined; // server 常驻，不主动退出
}

function cmdConfigCheck(opts) {
  const { configDir } = dirs(opts);
  const explicit = opts.rest.slice(2).find((a) => !a.startsWith('--')) ?? null;
  // 缺省 <configDir>/config.json；目录里实际是 yaml 时取第一个存在的候选
  const candidates = ['config.json', 'config.yaml', 'config.yml'].map((n) => join(configDir, n));
  const path = explicit ?? candidates.find(existsSync) ?? candidates[0];
  const checker = join(HERE, '..', 'scripts', 'config-check.js');
  const res = spawnSync(process.execPath, [checker, path], { stdio: 'inherit' });
  if (res.error) die(`无法运行 ${checker}：${res.error.message}`);
  const code = res.status ?? 1;
  if (code !== 0) process.exit(code);
  return code;
}

async function cmdConfigMigrate(opts) {
  const configDir = opts.rest[2] ?? dirs(opts).configDir;
  const { migrateConfig } = await import('../scripts/config-migrate.js');
  try { migrateConfig(configDir); return 0; }
  catch (err) { console.error(`✖ ${err.message}`); return 1; }
}

async function cmdCollect(opts) {
  const argv = opts.rest.slice(1);
  const action = argv[0];
  const { configDir, stateDir } = dirs(opts);
  const defaultDevice = normalizeDevice(hostname());
  if (!['install', 'uninstall'].includes(action)) {
    return runCollect({ argv, env: { ...process.env, MODEL_GATEWAY_CONFIG_DIR: configDir }, defaultDevice });
  }
  const value = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} 需要一个参数`);
    return argv[index + 1];
  };
  const envFile = resolve(value('--env-file') ?? join(configDir, 'collect.env'));
  const intervalMin = Number(value('--interval') ?? 5);
  const binPath = fileURLToPath(import.meta.url);
  // npx 缓存目录会被清理，服务指向它会在之后失效：提示先全局安装
  if (action === 'install' && /[\\/]_npx[\\/]/.test(binPath)) console.error('⚠ 当前从 npx 缓存运行；常驻采集请先 npm i -g @maplesnow/model-gateway，再执行 collect install');
  const plan = servicePlan({
    platform: process.platform, nodePath: stableNodePath(process.execPath), binPath,
    envFile, home: homedir(), intervalMin, stateDir: resolve(stateDir),
  });
  const commands = plan[action];
  if (argv.includes('--print')) {
    for (const file of plan.files) console.log(`FILE ${file.path}\n${file.content}`);
    for (const [index, command] of commands.entries()) {
      console.log(command.map((arg) => JSON.stringify(arg)).join(' '));
      if (action === 'uninstall' && index === 0) for (const file of plan.files) console.log(`REMOVE ${file.path}`);
    }
    return 0;
  }
  if (action === 'install') {
    if (!existsSync(envFile)) {
      mkdirSync(dirname(envFile), { recursive: true });
      writeFileSync(envFile, `MODEL_GATEWAY_URL=\nUSAGE_SYNC_KEY=\nUSAGE_SYNC_DEVICE=${defaultDevice}\n`, { mode: 0o600, flag: 'wx' });
      console.log(`请填写采集器环境文件：${envFile}`);
    }
    mkdirSync(stateDir, { recursive: true });
    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
  }
  for (const [index, [command, ...args]] of commands.entries()) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0 || result.error) {
      console.error(result.stderr || result.error?.message || `${command} 退出码 ${result.status}`);
      return 1;
    }
    if (action === 'uninstall' && index === 0) for (const file of plan.files) rmSync(file.path, { force: true });
  }
  return 0;
}

/** Homebrew 的 execPath 带版本号（Cellar/node/<ver>），升级后失效；优先用前缀下的稳定链接。 */
function stableNodePath(execPath) {
  const match = /^(.*)[\\/]Cellar[\\/]node(?:@[^\\/]+)?[\\/][^\\/]+[\\/]bin[\\/]node$/.exec(execPath);
  const stable = match && join(match[1], 'bin', 'node');
  return stable && existsSync(stable) ? stable : execPath;
}

/** api：未设置 MODEL_GATEWAY_ADMIN_KEY 时读 <配置目录>/.env（init 生成的那份）。 */
async function cmdApi(opts) {
  const env = { ...process.env };
  const envFile = join(dirs(opts).configDir, '.env');
  if (!env.MODEL_GATEWAY_ADMIN_KEY && existsSync(envFile)) {
    for (const [k, v] of parseEnvText(readFileSync(envFile, 'utf8'))) if (k === 'MODEL_GATEWAY_ADMIN_KEY') env[k] = v;
  }
  const { runApi } = await import('../scripts/api.js');
  return runApi(opts.rest.slice(1), { env });
}

async function main() {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes('--help')) { help(); return 0; }
  const opts = parseArgs(rawArgv);
  const [cmd, sub] = opts.rest;
  switch (cmd) {
    case undefined: help(); return 0;
    case 'init': return cmdInit(opts);
    case 'start': return await cmdStart(opts);
    case 'config':
      if (sub === 'check') return cmdConfigCheck(opts);
      if (sub === 'migrate') return cmdConfigMigrate(opts);
      die(`未知 config 子命令 "${sub ?? ''}"（可用：check、migrate）`, 2);
      return 2;
    case 'api': return cmdApi(opts);
    case 'collect': return cmdCollect(opts);
    default: die(`未知子命令 "${cmd}"（--help 查看用法）`, 2); return 2;
  }
}

main().then((code) => { if (typeof code === 'number') process.exit(code); }, (err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
