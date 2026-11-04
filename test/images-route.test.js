// images-route.test.js — /v1/images/generations：config 声明校验 + 路由行为（model pin、健康检查、透传）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { validateConfig } from '../src/config.js';
import { EventLog } from '../src/events.js';

function gateway(config, catalog, events, registry) {
  return new Promise((resolve) => {
    const handler = createRequestHandler({
      config,
      catalog,
      events,
      quotaStore: { snapshot: () => ({}) },
      ...(registry ? { registry } : {}),
    });
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function call(base, path, { method = 'GET', key = 'gw-test-key', body } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const CODEX_PROVIDER = {
  id: 'codex',
  type: 'codex',
  models: ['gpt-5.5', 'gpt-image-1.5'],
};

function baseConfig(imageGeneration) {
  return {
    gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] },
    ...(imageGeneration === undefined ? {} : { imageGeneration }),
  };
}

/** 可编程假 codex runtime（registry.get('codex') 的返回）。 */
function fakeCodex({ healthy = true, images } = {}) {
  const calls = [];
  return {
    calls,
    get: (id) => (id === 'codex' ? {
      healthy: () => healthy,
      status: () => (healthy ? {} : { reason: 'no credentials' }),
      images: async (body) => { calls.push(body); return images(body); },
    } : null),
    snapshot: () => ({}),
  };
}

// ── config 声明校验 ────────────────────────────────────────────────

test('config: imageGeneration 合法声明被映射进归一化输出', () => {
  const cfg = validateConfig({
    gateway: { keys: ['k'] },
    jobs: { probe: { enabled: false }, activate: { enabled: false }, modelGuard: { enabled: false } },
    providers: [{ id: 'codex', type: 'codex', models: ['gpt-image-1.5'] }],
    imageGeneration: { provider: 'codex', model: 'gpt-image-1.5' },
  });
  assert.deepEqual(cfg.imageGeneration, { provider: 'codex', model: 'gpt-image-1.5' });
});

test('config: 未声明 imageGeneration → null（路由返回 404）', () => {
  const cfg = validateConfig({
    gateway: { keys: ['k'] },
    jobs: { probe: { enabled: false }, activate: { enabled: false }, modelGuard: { enabled: false } },
    providers: [{ id: 'codex', type: 'codex', models: ['gpt-image-1.5'] }],
  });
  assert.equal(cfg.imageGeneration, null);
});

test('config: imageGeneration.provider 非 codex 类型被拒', () => {
  assert.throws(() => validateConfig({
    gateway: { keys: ['k'] },
    providers: [{ id: 'glm', type: 'glm', baseUrl: 'https://x/v4/chat/completions', models: ['m'] }],
    imageGeneration: { provider: 'glm', model: 'gpt-image-1.5' },
  }), /must be type codex/);
});

test('config: imageGeneration.provider 未声明被拒 / model 缺失被拒', () => {
  assert.throws(() => validateConfig({
    gateway: { keys: ['k'] },
    jobs: { probe: { enabled: false }, activate: { enabled: false }, modelGuard: { enabled: false } },
    providers: [{ id: 'codex', type: 'codex', models: ['gpt-image-1.5'] }],
    imageGeneration: { provider: 'nope', model: 'gpt-image-1.5' },
  }), /not declared by any provider/);
  assert.throws(() => validateConfig({
    gateway: { keys: ['k'] },
    jobs: { probe: { enabled: false }, activate: { enabled: false }, modelGuard: { enabled: false } },
    providers: [{ id: 'codex', type: 'codex', models: ['gpt-image-1.5'] }],
    imageGeneration: { provider: 'codex' },
  }), /model: required string/);
});

// ── 路由行为 ──────────────────────────────────────────────────────

test('images: 未配置 imageGeneration → 404', async () => {
  const events = new EventLog(10);
  const gw = await gateway(baseConfig(null), { providers: [CODEX_PROVIDER] }, events, fakeCodex());
  const res = await call(gw.url, '/v1/images/generations', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(res.status, 404);
  gw.server.close();
});

test('images: 缺鉴权 → 401；缺 prompt → 400', async () => {
  const events = new EventLog(10);
  const gw = await gateway(baseConfig({ provider: 'codex', model: 'gpt-image-1.5' }), { providers: [CODEX_PROVIDER] }, events, fakeCodex());
  const noauth = await call(gw.url, '/v1/images/generations', { method: 'POST', key: null, body: { prompt: 'x' } });
  assert.equal(noauth.status, 401);
  const noprompt = await call(gw.url, '/v1/images/generations', { method: 'POST', body: { model: 'gpt-image-1.5' } });
  assert.equal(noprompt.status, 400);
  gw.server.close();
});

test('images: 成功透传；请求体 model 被 config pin（防源漂移）', async () => {
  const events = new EventLog(10);
  const registry = fakeCodex({
    images: async () => ({
      created: 1778832973,
      data: [{ b64_json: 'QUJD' }],
      output_format: 'png',
      usage: { total_tokens: 2846 },
    }),
  });
  const gw = await gateway(baseConfig({ provider: 'codex', model: 'gpt-image-1.5' }), { providers: [CODEX_PROVIDER] }, events, registry);
  const res = await call(gw.url, '/v1/images/generations', {
    method: 'POST',
    body: { prompt: 'a red fox', model: 'attacker-model', size: '1024x1024' },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data[0].b64_json, 'QUJD');
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0].model, 'gpt-image-1.5'); // 请求体 model 不透传
  assert.equal(registry.calls[0].prompt, 'a red fox');
  assert.equal(registry.calls[0].size, '1024x1024');
  assert.ok(events.list().some((e) => e.type === 'imagegen'));
  gw.server.close();
});

test('images: codex runtime 不健康 → 503，不触上游', async () => {
  const events = new EventLog(10);
  const registry = fakeCodex({ healthy: false });
  const gw = await gateway(baseConfig({ provider: 'codex', model: 'gpt-image-1.5' }), { providers: [CODEX_PROVIDER] }, events, registry);
  const res = await call(gw.url, '/v1/images/generations', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(res.status, 503);
  assert.equal(registry.calls.length, 0);
  gw.server.close();
});

test('images: 上游 429 → 网关 429 透传', async () => {
  const events = new EventLog(10);
  const registry = fakeCodex({
    images: async () => {
      const err = new Error('codex upstream 429: slow down');
      err.status = 429;
      err.kind = 'rate_limited';
      throw err;
    },
  });
  const gw = await gateway(baseConfig({ provider: 'codex', model: 'gpt-image-1.5' }), { providers: [CODEX_PROVIDER] }, events, registry);
  const res = await call(gw.url, '/v1/images/generations', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(res.status, 429);
  assert.ok(events.list().some((e) => e.type === 'imagegen_error'));
  gw.server.close();
});
