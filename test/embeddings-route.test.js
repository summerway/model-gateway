// embeddings-route.test.js — /v1/embeddings：config 声明校验 + DashScope 原生/兼容降级 + 分批 + base64。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { validateConfig } from '../src/config.js';
import { EventLog } from '../src/events.js';
import { floatsToBase64 } from '../src/gateway/embeddings.js';

process.env.TEST_DS_KEY = 'ds-test-key';
process.env.TEST_DS_WS = 'ws-test';

const EMB = {
  type: 'dashscope',
  apiKeyRef: 'env:TEST_DS_KEY',
  workspaceIdRef: 'env:TEST_DS_WS',
  region: 'cn-beijing',
  models: ['text-embedding-v4'],
  defaultDimensions: 4,
};

function gateway(config, fetchFn, events = new EventLog(50)) {
  return new Promise((resolve) => {
    const handler = createRequestHandler({
      config,
      catalog: { providers: [] },
      events,
      quotaStore: { snapshot: () => ({}) },
      fetch: fetchFn,
    });
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, events }));
  });
}

function call(base, body, key = 'gw-test-key') {
  return fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const cfg = (embeddings) => ({
  gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] },
  ...(embeddings === undefined ? {} : { embeddings }),
});

const vec = (i) => [i + 1, i + 1.5, -(i + 1), 0.25];

/** 假上游：记录调用；mode 控制原生/兼容各自的返回。 */
function fakeUpstream({ native = 'ok', compat = 'ok' } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.authorization });
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/v1/services/embeddings/')) {
      if (native === 'network') throw new TypeError('fetch failed');
      if (native === '500') return json(500, { message: 'internal' });
      if (native === '401') return json(401, { message: 'Invalid API-key' });
      const texts = body.input.texts;
      return json(200, {
        output: { embeddings: texts.map((_, i) => ({ text_index: i, embedding: vec(i) })).reverse() },
        usage: { total_tokens: texts.length * 3 },
      });
    }
    if (compat === '500') return json(500, { error: { message: 'compat down' } });
    return json(200, {
      data: body.input.map((_, i) => ({ index: i, embedding: vec(i), object: 'embedding' })),
      usage: { prompt_tokens: body.input.length * 3, total_tokens: body.input.length * 3 },
    });
  };
  return { fn, calls };
}

// ── config 声明校验 ────────────────────────────────────────────────

const JOBS_OFF = { probe: { enabled: false }, activate: { enabled: false }, modelGuard: { enabled: false } };
const PROVIDERS = [{ id: 'glm', type: 'glm', baseUrl: 'https://x/v1/chat/completions', apiKeyRef: 'env:X', models: ['glm-5.3'] }];

test('config: embeddings 合法声明被归一化（region 缺省 cn-beijing）', () => {
  const c = validateConfig({
    gateway: { keys: ['k'] }, jobs: JOBS_OFF, providers: PROVIDERS,
    embeddings: { type: 'dashscope', apiKeyRef: 'env:A', workspaceIdRef: 'env:W', models: ['text-embedding-v4'] },
  });
  assert.deepEqual(c.embeddings, {
    type: 'dashscope', apiKeyRef: 'env:A', workspaceIdRef: 'env:W', region: 'cn-beijing',
    models: ['text-embedding-v4'], defaultDimensions: null,
    balanceAccessKeyIdRef: null, balanceAccessKeySecretRef: null,
  });
});

test('config: balance ref 可选声明被透传（非字符串被拒）', () => {
  const c = validateConfig({
    gateway: { keys: ['k'] }, jobs: JOBS_OFF, providers: PROVIDERS,
    embeddings: {
      type: 'dashscope', apiKeyRef: 'env:A', workspaceIdRef: 'env:W', models: ['text-embedding-v4'],
      balanceAccessKeyIdRef: 'env:BSS_ID', balanceAccessKeySecretRef: 'env:BSS_SEC',
    },
  });
  assert.equal(c.embeddings.balanceAccessKeyIdRef, 'env:BSS_ID');
  assert.equal(c.embeddings.balanceAccessKeySecretRef, 'env:BSS_SEC');
  assert.throws(() => validateConfig({
    gateway: { keys: ['k'] }, jobs: JOBS_OFF, providers: PROVIDERS,
    embeddings: {
      type: 'dashscope', apiKeyRef: 'env:A', workspaceIdRef: 'env:W', models: ['text-embedding-v4'],
      balanceAccessKeyIdRef: 123,
    },
  }), /embeddings\.balanceAccessKeyIdRef/);
});

test('config: 未声明 embeddings → null', () => {
  const c = validateConfig({ gateway: { keys: ['k'] }, jobs: JOBS_OFF, providers: PROVIDERS });
  assert.equal(c.embeddings, null);
});

test('config: 非 dashscope / 缺 ref / 空 models 被拒', () => {
  assert.throws(() => validateConfig({
    gateway: { keys: ['k'] }, jobs: JOBS_OFF, providers: PROVIDERS,
    embeddings: { type: 'openai', models: [] },
  }), /embeddings\.type.*embeddings\.apiKeyRef|embeddings\.type/s);
});

// ── 路由行为 ────────────────────────────────────────────────────────

test('未配置 embeddings → 404', async () => {
  const { server, url } = await gateway(cfg(undefined), fakeUpstream().fn);
  try {
    const r = await call(url, { input: 'x' });
    assert.equal(r.status, 404);
  } finally { server.close(); }
});

test('无网关 key → 401', async () => {
  const { server, url } = await gateway(cfg(EMB), fakeUpstream().fn);
  try {
    const r = await call(url, { input: 'x' }, null);
    assert.equal(r.status, 401);
  } finally { server.close(); }
});

test('原生接口：text_type/dimension 透传，按 text_index 排序，OpenAI 形响应', async () => {
  const up = fakeUpstream();
  const { server, url } = await gateway(cfg(EMB), up.fn);
  try {
    const r = await call(url, { model: 'text-embedding-v4', input: ['a', 'b'], text_type: 'query' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.object, 'list');
    assert.equal(j.model, 'text-embedding-v4');
    assert.deepEqual(j.data.map((d) => d.index), [0, 1]);
    assert.deepEqual(j.data[1].embedding, vec(1));
    assert.deepEqual(j.usage, { prompt_tokens: 6, total_tokens: 6 });
    assert.equal(up.calls.length, 1);
    const c = up.calls[0];
    assert.equal(c.url, 'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding');
    assert.equal(c.auth, 'Bearer ds-test-key');
    assert.deepEqual(c.body.parameters, { text_type: 'query', dimension: 4 });
  } finally { server.close(); }
});

test('超过 10 条 → 顺序分批，index 连续', async () => {
  const up = fakeUpstream();
  const { server, url } = await gateway(cfg(EMB), up.fn);
  try {
    const input = Array.from({ length: 23 }, (_, i) => `t${i}`);
    const j = await (await call(url, { input })).json();
    assert.equal(up.calls.length, 3);
    assert.deepEqual(up.calls.map((c) => c.body.input.texts.length), [10, 10, 3]);
    assert.deepEqual(j.data.map((d) => d.index), input.map((_, i) => i));
    assert.equal(j.usage.total_tokens, 69);
  } finally { server.close(); }
});

test('原生 5xx / 网络错误 → 降级兼容模式并记事件', async () => {
  for (const native of ['500', 'network']) {
    const up = fakeUpstream({ native });
    const { server, url, events } = await gateway(cfg(EMB), up.fn);
    try {
      const r = await call(url, { input: 'hello' });
      assert.equal(r.status, 200, native);
      assert.equal(up.calls.length, 2);
      assert.equal(up.calls[1].url, 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings');
      assert.equal(up.calls[1].body.dimensions, 4);
      assert.equal(events.list({ type: 'embeddings_degraded' }).length, 1);
      // 展示位关联：事件携带 providerId，dashboard 卡片「事件动态」才能命中
      assert.equal(events.list({ type: 'embeddings_degraded' })[0].providerId, 'dashscope');
    } finally { server.close(); }
  }
});

test('原生 4xx（鉴权）→ 不降级，直接报错', async () => {
  const up = fakeUpstream({ native: '401' });
  const { server, url } = await gateway(cfg(EMB), up.fn);
  try {
    const r = await call(url, { input: 'x' });
    assert.equal(r.status, 502);
    assert.equal(up.calls.length, 1);
    assert.match((await r.json()).error.message, /Invalid API-key/);
  } finally { server.close(); }
});

test('原生与兼容都失败 → 502', async () => {
  const up = fakeUpstream({ native: '500', compat: '500' });
  const { server, url } = await gateway(cfg(EMB), up.fn);
  try {
    const r = await call(url, { input: 'x' });
    assert.equal(r.status, 502);
  } finally { server.close(); }
});

test('encoding_format=base64 → Float32 LE base64', async () => {
  const { server, url } = await gateway(cfg(EMB), fakeUpstream().fn);
  try {
    const j = await (await call(url, { input: 'x', encoding_format: 'base64' })).json();
    assert.equal(j.data[0].embedding, floatsToBase64(vec(0)));
    const buf = Buffer.from(j.data[0].embedding, 'base64');
    assert.equal(buf.readFloatLE(4), 1.5);
  } finally { server.close(); }
});

test('非法请求 → 400（未知模型 / 空 input / 非法 text_type）', async () => {
  const { server, url } = await gateway(cfg(EMB), fakeUpstream().fn);
  try {
    for (const body of [{ model: 'nope', input: 'x' }, { input: [] }, { input: 'x', text_type: 'passage' }, { input: [1, 2] }]) {
      assert.equal((await call(url, body)).status, 400, JSON.stringify(body));
    }
  } finally { server.close(); }
});
