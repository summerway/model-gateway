/** codex OAuth 单元测试 — token 刷新/设备流/凭据归一化（全部 mock，绝不真打 auth.openai.com）。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshAccessToken, exchangeAuthorizationCode, startDeviceAuth, pollDeviceAuth,
  decodeJwt, extractAccountId, generatePkce, tokenResponseToCredentials,
  OAuthError, TOKEN_URL, CLIENT_ID,
} from '../src/gateway/providers/codex/oauth.js';

// ---- 测试用 JWT 构造（accountId 提取） ----
function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}
const ACCOUNT_ID = '3d8e3cfd-test-account';
const ACCESS_WITH_ACCOUNT = makeJwt({
  'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID },
});

function tokenResponse({ access = ACCESS_WITH_ACCOUNT, expiresIn = 3600 } = {}) {
  return {
    access_token: access,
    refresh_token: 'rt.new-refresh',
    id_token: 'idtok.new',
    expires_in: expiresIn,
  };
}

/** mock fetch：只允许 token 端点，其它 URL 一律 fail（防止测试真打外网）。 */
function mockFetch(handler) {
  return async (url, init) => {
    const urlStr = String(url);
    if (!urlStr.startsWith('https://auth.openai.com/')) {
      throw new Error(`test guard: unexpected outbound request to ${urlStr}`);
    }
    return handler(urlStr, init);
  };
}

describe('refreshAccessToken', () => {
  test('POST 到 token 端点，form 参数含 grant_type/client_id/refresh_token', async () => {
    let captured;
    const fetchImpl = mockFetch(async (url, init) => {
      assert.equal(url, TOKEN_URL);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      captured = new URLSearchParams(init.body);
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    });
    const creds = await refreshAccessToken('rt.old', { fetchImpl, now: () => 1_000_000 });
    assert.equal(captured.get('grant_type'), 'refresh_token');
    assert.equal(captured.get('refresh_token'), 'rt.old');
    assert.equal(captured.get('client_id'), CLIENT_ID);
    assert.equal(creds.refresh, 'rt.new-refresh');
    assert.equal(creds.accountId, ACCOUNT_ID);
    assert.equal(creds.expires, 1_000_000 + 3600 * 1000);
  });

  test('刷新响应缺 refresh_token 时报错（刷新轮换必须持久化新值）', async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ access_token: 'x', expires_in: 100 }), { status: 200 }));
    await assert.rejects(
      () => refreshAccessToken('rt.old', { fetchImpl }),
      (err) => err instanceof OAuthError && /missing refresh_token/.test(err.message),
    );
  });

  test('400 invalid_grant → OAuthError 带 status（永久失败）', async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await assert.rejects(
      () => refreshAccessToken('rt.revoked', { fetchImpl }),
      (err) => err instanceof OAuthError && err.status === 400,
    );
  });

  test('401/403 同样带 status；网络异常包装为 OAuthError', async () => {
    const fetch401 = mockFetch(async () => new Response('unauthorized', { status: 401 }));
    await assert.rejects(
      () => refreshAccessToken('rt.bad', { fetchImpl: fetch401 }),
      (err) => err.status === 401,
    );
    const fetchNet = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(
      () => refreshAccessToken('rt.any', { fetchImpl: fetchNet }),
      (err) => err instanceof OAuthError && /refresh request failed/.test(err.message),
    );
  });

  test('JWT accountId 缺失时 accountId 为 null（不抛错，由 TokenManager 继承旧值）', async () => {
    const fetchImpl = mockFetch(async () =>
      new Response(JSON.stringify(tokenResponse({ access: makeJwt({ sub: 'u1' }) })), { status: 200 }));
    const creds = await refreshAccessToken('rt.old', { fetchImpl });
    assert.equal(creds.accountId, null);
  });
});

describe('exchangeAuthorizationCode (device 流收尾)', () => {
  test('authorization_code + code_verifier + redirect_uri 换 token', async () => {
    let captured;
    const fetchImpl = mockFetch(async (url, init) => {
      captured = new URLSearchParams(init.body);
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    });
    const creds = await exchangeAuthorizationCode('ac.test', 'verifier123', 'https://auth.openai.com/deviceauth/callback', { fetchImpl });
    assert.equal(captured.get('grant_type'), 'authorization_code');
    assert.equal(captured.get('code'), 'ac.test');
    assert.equal(captured.get('code_verifier'), 'verifier123');
    assert.equal(captured.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
    assert.equal(creds.accountId, ACCOUNT_ID);
  });
});

describe('device flow', () => {
  test('startDeviceAuth 返回 userCode/interval/deviceAuthId', async () => {
    const fetchImpl = mockFetch(async (url) => {
      assert.equal(url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
      return new Response(JSON.stringify({
        device_auth_id: 'da_1', user_code: 'ABCD-1234', interval: '5',
      }), { status: 200 });
    });
    const device = await startDeviceAuth({ fetchImpl });
    assert.equal(device.deviceAuthId, 'da_1');
    assert.equal(device.userCode, 'ABCD-1234');
    assert.equal(device.intervalSeconds, 5);
    assert.equal(device.verificationUri, 'https://auth.openai.com/codex/device');
  });

  test('pollDeviceAuth: pending → complete; slow_down 识别', async () => {
    let call = 0;
    const fetchImpl = mockFetch(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ error: { code: 'deviceauth_authorization_pending' } }), { status: 428 });
      if (call === 2) return new Response(JSON.stringify({ error: { code: 'slow_down' } }), { status: 429 });
      return new Response(JSON.stringify({ authorization_code: 'ac.done', code_verifier: 'cv.done' }), { status: 200 });
    });
    const device = { deviceAuthId: 'da_1', userCode: 'X' };
    assert.equal((await pollDeviceAuth(device, { fetchImpl })).status, 'pending');
    assert.equal((await pollDeviceAuth(device, { fetchImpl })).status, 'slow_down');
    const done = await pollDeviceAuth(device, { fetchImpl });
    assert.equal(done.status, 'complete');
    assert.equal(done.authorizationCode, 'ac.done');
    assert.equal(done.codeVerifier, 'cv.done');
  });
});

describe('JWT / PKCE 工具', () => {
  test('decodeJwt + extractAccountId；非法 token 返回 null', () => {
    assert.equal(extractAccountId(ACCESS_WITH_ACCOUNT), ACCOUNT_ID);
    assert.equal(extractAccountId('not.a'), null);
    assert.equal(extractAccountId('<<<<'), null);
    assert.equal(decodeJwt(''), null);
  });

  test('PKCE verifier/challenge（S256 可验证）', async () => {
    const { verifier, challenge } = await generatePkce();
    assert.equal(verifier.length, 43); // 32 bytes base64url
    const { createHash } = await import('node:crypto');
    assert.equal(
      createHash('sha256').update(verifier).digest().toString('base64url'),
      challenge,
    );
  });

  test('tokenResponseToCredentials 缺字段校验', () => {
    assert.throws(() => tokenResponseToCredentials({}), OAuthError);
    assert.throws(() => tokenResponseToCredentials({ access_token: 'a', refresh_token: 'r' }), OAuthError);
    assert.throws(() => tokenResponseToCredentials({ access_token: 'a', refresh_token: 'r', expires_in: 'x' }), OAuthError);
  });
});
