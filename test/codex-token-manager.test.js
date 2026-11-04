/** TokenManager 单元测试 — 过期自动刷新、单飞、失败降级 unhealthy、secrets 持久化（真实临时目录）。 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenManager, normalizeCredentials, isPermanentOAuthFailure } from '../src/gateway/providers/codex/token-manager.js';
import { OAuthError } from '../src/gateway/providers/codex/oauth.js';

function makeCreds({ expires = Date.now() + 3600_000 } = {}) {
  return { type: 'oauth', access: 'access.old', refresh: 'rt.old', idToken: null, expires, accountId: 'acct-1' };
}

function writeCredsFile(dir, creds) {
  return fs.writeFile(path.join(dir, 'codex.json'), JSON.stringify(creds), { mode: 0o600 });
}

function mockFetchOk({ access = 'access.fresh', refresh = 'rt.fresh', expiresIn = 3600 } = {}) {
  return async () => new Response(JSON.stringify({
    access_token: access, refresh_token: refresh, id_token: 'id.new', expires_in: expiresIn,
  }), { status: 200 });
}

function mockFetchStatus(status, body = '{"error":"invalid_grant"}') {
  return async () => new Response(body, { status });
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mg-codex-test-'));
}

describe('load + normalizeCredentials', () => {
  test('加载网关原生形态', async () => {
    const dir = await tmpDir();
    await writeCredsFile(dir, makeCreds());
    const tm = new TokenManager({ secretsDir: dir });
    assert.equal(await tm.load(), true);
    assert.equal(tm.credentials.accountId, 'acct-1');
    assert.equal(tm.isHealthy(), true);
  });

  test('加载 codex CLI tokens 形态（access_token/refresh_token/account_id，无 expires → 视为过期）', async () => {
    const dir = await tmpDir();
    await writeCredsFile(dir, {
      OPENAI_API_KEY: null,
      tokens: { id_token: 'id.x', access_token: 'a.cli', refresh_token: 'rt.cli', account_id: 'acct-cli' },
    });
    const tm = new TokenManager({ secretsDir: dir });
    await tm.load();
    assert.equal(tm.credentials.access, 'a.cli');
    assert.equal(tm.credentials.accountId, 'acct-cli');
    assert.equal(tm.isExpired(), true);
  });

  test('文件缺失 → load false + unhealthy', async () => {
    const tm = new TokenManager({ secretsDir: (await tmpDir()) + '/nonexistent' });
    assert.equal(await tm.load(), false);
    assert.equal(tm.isHealthy(), false);
    assert.match(tm.getStatus().reason, /not found/);
  });

  test('非法形态抛 TypeError', () => {
    assert.throws(() => normalizeCredentials({ foo: 1 }), TypeError);
    assert.throws(() => normalizeCredentials(null), TypeError);
  });
});

describe('getAccessToken 刷新路径', () => {
  test('未过期直接返回，不触发网络', async () => {
    const dir = await tmpDir();
    await writeCredsFile(dir, makeCreds());
    const tm = new TokenManager({ secretsDir: dir, fetchImpl: async () => { throw new Error('should not fetch'); } });
    await tm.load();
    assert.equal(await tm.getAccessToken(), 'access.old');
  });

  test('过期 → 刷新 → 新凭据持久化（600 权限，refresh_token 轮换保留）', async () => {
    const dir = await tmpDir();
    let clock = 5_000_000;
    await writeCredsFile(dir, makeCreds({ expires: clock - 1000 })); // 相对假时钟已过期
    const tm = new TokenManager({
      secretsDir: dir,
      fetchImpl: mockFetchOk({ access: 'access.fresh', refresh: 'rt.rotated' }),
      now: () => clock,
    });
    await tm.load();
    const token = await tm.getAccessToken();
    assert.equal(token, 'access.fresh');
    assert.equal(tm.credentials.refresh, 'rt.rotated');
    assert.equal(tm.credentials.expires, clock + 3600_000);
    // 文件已写回
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'codex.json'), 'utf8'));
    assert.equal(raw.refresh, 'rt.rotated');
    const st = await fs.stat(path.join(dir, 'codex.json'));
    assert.equal(st.mode & 0o777, 0o600);
  });

  test('并发 getAccessToken 单飞：只发一次刷新请求', async () => {
    const dir = await tmpDir();
    await writeCredsFile(dir, makeCreds({ expires: Date.now() - 1000 }));
    let calls = 0;
    const tm = new TokenManager({
      secretsDir: dir,
      fetchImpl: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return mockFetchOk()();
      },
    });
    await tm.load();
    const [a, b, c] = await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()]);
    assert.equal(calls, 1);
    assert.equal(a, b); assert.equal(b, c);
  });

  test('刷新成功但 accountId 为 null → 继承旧值', async () => {
    const dir = await tmpDir();
    await writeCredsFile(dir, makeCreds({ expires: Date.now() - 1000 }));
    // 返回的 access_token 是无 claim 的哑 JWT
    const dumbJwt = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`;
    const tm = new TokenManager({ secretsDir: dir, fetchImpl: mockFetchOk({ access: dumbJwt }) });
    await tm.load();
    await tm.getAccessToken();
    assert.equal(tm.credentials.accountId, 'acct-1');
  });

  test('提前刷新窗口：过期前 5min 内触发刷新', async () => {
    const dir = await tmpDir();
    const early = 5 * 60 * 1000;
    // 距过期 4min（< 5min 提前量）→ 应刷新
    await writeCredsFile(dir, makeCreds({ expires: Date.now() + early - 60_000 }));
    const tm = new TokenManager({ secretsDir: dir, fetchImpl: mockFetchOk() });
    await tm.load();
    assert.equal(tm.isExpired(), true);
    const token = await tm.getAccessToken();
    assert.equal(token, 'access.fresh');
  });
});

describe('刷新失败降级（unhealthy → fallback 链跳过）', () => {
  test('连续失败达阈值（默认 2）→ unhealthy；冷却期后 probation 可重试', async () => {
    const dir = await tmpDir();
    let clock = 1_000_000;
    await writeCredsFile(dir, makeCreds({ expires: clock - 1000 })); // 相对假时钟已过期
    const tm = new TokenManager({
      secretsDir: dir,
      fetchImpl: mockFetchStatus(503, 'service unavailable'),
      now: () => clock,
      unhealthyCooldownMs: 10 * 60 * 1000,
    });
    await tm.load();
    // 第 1 次失败：计数 1，仍 healthy（给临时网络故障一次机会）
    await assert.rejects(() => tm.getAccessToken());
    assert.equal(tm.refreshFailures, 1);
    assert.equal(tm.unhealthy, false);
    // 第 2 次失败：unhealthy
    await assert.rejects(() => tm.getAccessToken());
    assert.equal(tm.unhealthy, true);
    assert.match(tm.unhealthyReason, /refresh failed 2x/);
    assert.equal(tm.isHealthy(), false); // 冷却期内
    // 冷却期内直接 getAccessToken 仍可被调用（fallback 引擎用 healthy() 跳过）
    // 推进时钟过冷却期 → probation: healthy()=true，但再次失败立即重回 unhealthy
    clock += 11 * 60 * 1000;
    assert.equal(tm.isHealthy(), true);
    await assert.rejects(() => tm.getAccessToken());
    assert.equal(tm.unhealthy, true);
    assert.equal(tm.refreshFailures, 3);
  });

  test('4xx 永久失败（invalid_grant）→ 首次失败立即 unhealthy', async () => {
    const dir = await tmpDir();
    await writeCredsFile(dir, makeCreds({ expires: Date.now() - 1000 }));
    const tm = new TokenManager({ secretsDir: dir, fetchImpl: mockFetchStatus(400) });
    await tm.load();
    await assert.rejects(() => tm.getAccessToken(), OAuthError);
    assert.equal(tm.unhealthy, true);
    assert.equal(isPermanentOAuthFailure(new OAuthError('x', { status: 400 })), true);
    assert.equal(isPermanentOAuthFailure(new OAuthError('x', { status: 503 })), false);
  });

  test('恢复后状态复位 + 持久化', async () => {
    const dir = await tmpDir();
    await writeCredsFile(dir, makeCreds({ expires: Date.now() - 1000 }));
    let failFirst = true;
    const tm = new TokenManager({
      secretsDir: dir,
      fetchImpl: async () => (failFirst ? (failFirst = false, mockFetchStatus(500)()) : mockFetchOk()()),
    });
    await tm.load();
    await assert.rejects(() => tm.getAccessToken());
    const token = await tm.getAccessToken();
    assert.equal(token, 'access.fresh');
    assert.equal(tm.unhealthy, false);
    assert.equal(tm.getStatus().healthy, true);
    assert.equal(tm.getStatus().refreshFailures, 0);
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'codex.json'), 'utf8'));
    assert.equal(raw.access, 'access.fresh');
  });
});
