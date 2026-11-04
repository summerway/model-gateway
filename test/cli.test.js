// cli.test.js — bin/model-gateway.js 子命令行为（MG16）。
// 全部用 spawnSync 跑真实 CLI 进程，目录用 mkdtemp 隔离；不在测试里真正启动服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'model-gateway.js');

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'mg16-cli-'));
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  return { root, configDir, dataDir };
}

function run(args, dirs, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MODEL_GATEWAY_CONFIG_DIR: dirs.configDir,
      MODEL_GATEWAY_DATA_DIR: dirs.dataDir,
      ...extraEnv,
    },
  });
}

function readEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq > 0) out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim();
  }
  return out;
}

test('init: 生成 config.json + .env + .env.example + 数据目录，配置过 validateConfig', () => {
  const dirs = makeDirs();
  const res = run(['init'], dirs);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const configPath = join(dirs.configDir, 'config.json');
  const envPath = join(dirs.configDir, '.env');
  const examplePath = join(dirs.configDir, '.env.example');
  assert.ok(existsSync(configPath));
  assert.ok(existsSync(envPath));
  assert.ok(existsSync(examplePath));
  assert.ok(statSync(dirs.dataDir).isDirectory());

  // 最小配置必须过 validateConfig（卡片断言）
  assert.doesNotThrow(() => validateConfig(JSON.parse(readFileSync(configPath, 'utf8'))));

  const env = readEnvFile(envPath);
  assert.match(env.MODEL_GATEWAY_KEY ?? '', /^[0-9a-f]{64}$/);
  assert.match(env.MODEL_GATEWAY_ADMIN_KEY ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(env.MODEL_GATEWAY_KEY, env.MODEL_GATEWAY_ADMIN_KEY);
  assert.equal(env.OPENAI_API_KEY, '');

  if (process.platform !== 'win32') {
    const mode = statSync(envPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  // .env.example 同键名、值为空
  const example = readEnvFile(examplePath);
  assert.deepEqual(Object.keys(example).sort(), ['MODEL_GATEWAY_ADMIN_KEY', 'MODEL_GATEWAY_KEY', 'OPENAI_API_KEY']);
  for (const v of Object.values(example)) assert.equal(v, '');
});

test('init: 已存在时退出码 1 且内容不变；--force 覆盖成功', () => {
  const dirs = makeDirs();
  assert.equal(run(['init'], dirs).status, 0);
  const before = {
    config: readFileSync(join(dirs.configDir, 'config.json'), 'utf8'),
    env: readFileSync(join(dirs.configDir, '.env'), 'utf8'),
  };

  const again = run(['init'], dirs);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /已存在/);
  assert.equal(readFileSync(join(dirs.configDir, 'config.json'), 'utf8'), before.config);
  assert.equal(readFileSync(join(dirs.configDir, '.env'), 'utf8'), before.env);
  const oldKey = /^MODEL_GATEWAY_KEY=([0-9a-f]{64})$/m.exec(before.env)?.[1];
  assert.ok(oldKey);

  const forced = run(['init', '--force'], dirs);
  assert.equal(forced.status, 0);
  const newEnv = readEnvFile(join(dirs.configDir, '.env'));
  assert.match(newEnv.MODEL_GATEWAY_KEY ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(newEnv.MODEL_GATEWAY_KEY, oldKey); // --force 重新生成随机 key
});

test('start: 配置目录缺配置文件 → 退出码 1 并提示 init', () => {
  const dirs = makeDirs();
  mkdirSync(dirs.configDir, { recursive: true }); // 空目录：没有 config.*，也没有 .env
  const res = run(['start'], dirs);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /init/);
});

test('--help 退出码 0；api 缺参数退出码 2；未知子命令退出码 2', () => {
  const dirs = makeDirs(); // 不实际读目录，仅复用 env 隔离
  const help = run(['--help'], dirs);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /init|start|config/);

  const api = run(['api'], dirs);
  assert.equal(api.status, 2);
  assert.match(api.stderr, /用法：model-gateway api/);

  const unknown = run(['does-not-exist'], dirs);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知子命令/);
});
