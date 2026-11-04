/** import-from-pi.sh 集成测试 — 模块内运行，mock 源 auth.json，验证形态转换/权限/幂等。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'import-from-pi.sh');

function run(args, { env } = {}) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '' };
  }
}

async function writeSource(dir, json) {
  const src = path.join(dir, 'auth.json');
  await fs.writeFile(src, JSON.stringify(json), { mode: 0o600 });
  return src;
}

const PI_AUTH = {
  'openai-codex': {
    type: 'oauth',
    access: 'access.pi',
    refresh: 'rt.pi',
    expires: 1790579446929,
    accountId: 'acct-pi',
  },
  zai: { type: 'api_key', key: 'other-provider' },
};

describe('import-from-pi.sh', () => {
  test('成功导入: 网关形态 + 600 权限 + 目录 700', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-import-'));
    const src = await writeSource(dir, PI_AUTH);
    const secrets = path.join(dir, 'secrets');
    const { code, stdout } = run([secrets, src]);
    assert.equal(code, 0, stdout);
    const out = JSON.parse(await fs.readFile(path.join(secrets, 'codex.json'), 'utf8'));
    assert.equal(out.access, 'access.pi');
    assert.equal(out.refresh, 'rt.pi');
    assert.equal(out.expires, 1790579446929);
    assert.equal(out.accountId, 'acct-pi');
    const fileMode = (await fs.stat(path.join(secrets, 'codex.json'))).mode & 0o777;
    const dirMode = (await fs.stat(secrets)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
  });

  test('幂等: 已存在默认跳过; --force 覆盖', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-import-'));
    const src = await writeSource(dir, PI_AUTH);
    const secrets = path.join(dir, 'secrets');
    run([secrets, src]);
    // 源更新（新 token），默认跳过
    const src2 = {
      'openai-codex': { ...PI_AUTH['openai-codex'], access: 'access.pi2' },
    };
    await writeSource(dir, src2);
    const skip = run([secrets, src]);
    assert.match(skip.stdout, /跳过/);
    assert.equal(JSON.parse(await fs.readFile(path.join(secrets, 'codex.json'), 'utf8')).access, 'access.pi');
    // --force 覆盖
    const forced = run([secrets, src, '--force']);
    assert.equal(forced.code, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(secrets, 'codex.json'), 'utf8')).access, 'access.pi2');
  });

  test('源缺 openai-codex 块 → exit 3', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-import-'));
    const src = await writeSource(dir, { zai: { type: 'api_key', key: 'x' } });
    const { code } = run([path.join(dir, 'secrets'), src]);
    assert.equal(code, 3);
  });

  test('探测失败（源不存在且无默认路径）→ exit 1', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-import-'));
    const { code } = run([path.join(dir, 'secrets'), path.join(dir, 'nope.json')], { env: { HOME: dir } });
    assert.equal(code, 1);
  });

  test('--if-stale: 源更新时覆盖', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-import-'));
    const src = await writeSource(dir, PI_AUTH);
    const secrets = path.join(dir, 'secrets');
    run([secrets, src]);
    // mtime 推后 10s 的更新源
    const srcPath = path.join(dir, 'auth.json');
    const updated = { 'openai-codex': { ...PI_AUTH['openai-codex'], access: 'access.stale' } };
    await fs.writeFile(srcPath, JSON.stringify(updated));
    await fs.utimes(srcPath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    const res = run([secrets, srcPath, '--if-stale']);
    assert.equal(res.code, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(secrets, 'codex.json'), 'utf8')).access, 'access.stale');
  });
});
