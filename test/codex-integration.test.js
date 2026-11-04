/**
 * codex 网关集成测试 — 端到端 mock 上游：
 *  - 客户端 → 网关 /v1/chat/completions（GPT 模型）→ codex provider（mock chatgpt backend）→ 响应转换返回
 *  - /v1/responses 形态透传
 *  - codex 401 → 刷新 → 重试失败 → fallback 切下一 provider 完整链路
 *  - unhealthy → fallback 链跳过 codex
 *  - 429 → fallback 切换但不拉黑
 *  - /v1/models 包含 GPT 模型
 *  - 流式：codex responses SSE → chat chunks 透传
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../src/gateway/router.js';
import { createProviderRegistry } from '../src/gateway/providers/registry.js';
import { EventLog } from '../src/events.js';

// ── 测试用 JWT（accountId=acct-int）──
function makeJwt() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-int' } })}.x`;
}

const TOKEN_OK = {
  access_token: makeJwt(),
  refresh_token: 'rt.new',
  id_token: null,
  expires_in: 3600,
};

const RESPONSES_COMPLETED = {
  id: 'resp_int_1',
  status: 'completed',
  model: 'gpt-6-sol',
  created_at: 1761020400,
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'gateway works' }] }],
  usage: { input_tokens: 4, output_tokens: 2 },
};

const RESPONSES_SSE = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"He"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"llo"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
].join('');

async function makeSecretsDir({ expires = Date.now() - 1000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-int-'));
  await fs.writeFile(path.join(dir, 'codex.json'), JSON.stringify({
    type: 'oauth', access: 'access.stale', refresh: 'rt.old', idToken: null, expires, accountId: 'acct-int',
  }), { mode: 0o600 });
  return dir;
}

function mockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function codexProviders() {
  return [{
    id: 'codex-main', type: 'codex', baseUrl: null, apiKeyRef: null, models: ['gpt-6-sol', 'gpt-6-luna'],
  }];
}

/** 组装网关（registry + handler + http server）。fetchImpl 走 codex 模块级注入。 */
async function startGateway({ providers, secretsDir, fetchImpl }) {
  const events = new EventLog(100);
  const registry = createProviderRegistry({ secretsDir, config: { providers }, fetchImpl });
  const handler = createRequestHandler({
    config: { gateway: { keys: ['gw-key'] } },
    catalog: { providers },
    events,
    quotaStore: { snapshot: () => ({}) },
    registry,
  });
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await registry.init();
  return { events, registry, server, url: `http://127.0.0.1:${server.address().port}` };
}

function call(base, reqPath, { method = 'GET', key = 'gw-key', body, headers = {} } = {}) {
  return fetch(base + reqPath, {
    method,
    headers: {
      ...headers,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** 按域名分流的 mock fetch：auth.openai.com → token 端点；chatgpt.com → backend handler。 */
function codexFetch(backendHandler, { tokenJson = TOKEN_OK } = {}) {
  return async (url, init) => {
    const s = String(url);
    if (s.startsWith('https://auth.openai.com/')) {
      return new Response(JSON.stringify(tokenJson), { status: 200 });
    }
    if (s.startsWith('https://chatgpt.com/')) {
      return backendHandler(s, init);
    }
    throw new Error(`unexpected fetch in test: ${s}`);
  };
}

test('integration: /v1/chat/completions GPT → codex（mock backend）→ chat 响应', async () => {
  const secretsDir = await makeSecretsDir();
  let captured;
  const gw = await startGateway({
    providers: codexProviders(),
    secretsDir,
    fetchImpl: codexFetch(async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      // codex backend 强制流式：即使非流式 chat 请求，上游也是 SSE
      return new Response(RESPONSES_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }),
  });
  try {
    const resp = await call(gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-sol', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.model, 'gpt-6-sol');
    assert.equal(json.choices[0].message.content, 'Hello');
    assert.equal(json.usage.prompt_tokens, 4);
    assert.equal(json.usage.completion_tokens, 2);
    // 上游收到 responses 形态（chat→responses 转换发生）+ 刷新后的 token
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.notEqual(captured.headers.Authorization, 'Bearer access.stale', 'token refreshed');
    assert.equal(captured.headers['chatgpt-account-id'], 'acct-int');
    assert.equal(captured.headers.originator, 'model-gateway');
    assert.equal(captured.body.instructions, 'sys');
    assert.equal(captured.body.model, 'gpt-6-sol');
  } finally {
    gw.server.close();
  }
});

test('integration: /v1/models 包含 GPT 模型与 provider 归属', async () => {
  const secretsDir = await makeSecretsDir();
  const providers = [
    ...codexProviders(),
    { id: 'glm-main', type: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKeyRef: 'env:X', models: ['glm-5.3'] },
  ];
  const gw = await startGateway({ providers, secretsDir, fetchImpl: codexFetch(async () => new Response('{}')) });
  try {
    const resp = await call(gw.url, '/v1/models');
    assert.equal(resp.status, 200);
    const json = await resp.json();
    const ids = json.data.map((m) => m.id);
    assert.ok(ids.includes('gpt-6-sol'));
    assert.ok(ids.includes('gpt-6-luna'));
    assert.ok(ids.includes('glm-5.3'));
    const sol = json.data.find((m) => m.id === 'gpt-6-sol');
    assert.deepEqual(sol.providers, ['codex-main']);
  } finally {
    gw.server.close();
  }
});

test('integration: /v1/responses 非流式（codex 上行流式 + 本地聚合）', async () => {
  const secretsDir = await makeSecretsDir();
  let captured;
  const gw = await startGateway({
    providers: codexProviders(),
    secretsDir,
    fetchImpl: codexFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      // 真实 backend 只回 SSE（非流式请求被拒 "Stream must be set to true"），网关本地聚合
      const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_r","status":"completed","output":[]}}\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }),
  });
  try {
    const resp = await call(gw.url, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-sol', input: 'direct-responses' },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.id, 'resp_r');
    assert.equal(captured.body.input, 'direct-responses');
    assert.equal(captured.body.stream, true);
  } finally {
    gw.server.close();
  }
});

test('integration: /v1/responses 透传 codex 会话粘性头到 backend', async () => {
  const secretsDir = await makeSecretsDir();
  let captured;
  const gw = await startGateway({
    providers: codexProviders(),
    secretsDir,
    fetchImpl: codexFetch(async (url, init) => {
      captured = init.headers;
      const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_s","status":"completed","output":[]}}\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }),
  });
  try {
    const resp = await call(gw.url, '/v1/responses', {
      method: 'POST',
      body: { model: 'gpt-6-sol', input: 'x', stream: true, prompt_cache_key: 'sess-9' },
      headers: { 'session-id': 'sess-9', 'thread-id': 'sess-9', 'x-codex-window-id': 'sess-9:0' },
    });
    assert.equal(resp.status, 200);
    await resp.text();
    assert.equal(captured['session-id'], 'sess-9');
    assert.equal(captured['thread-id'], 'sess-9');
    assert.equal(captured['x-codex-window-id'], 'sess-9:0');
    assert.notEqual(captured.Authorization, 'Bearer gw-key');
  } finally {
    gw.server.close();
  }
});

test('integration: codex 401 → 刷新 → 重试失败 → fallback 切下一 provider（完整链路）', async () => {
  const secretsDir = await makeSecretsDir();
  let tokenCalls = 0;
  let backendCalls = 0;
  // token 端点永远给"新"token，但 backend 永远 401（模拟强制刷新后仍被拒的极端场景）
  const fetchImpl = async (url, init) => {
    const s = String(url);
    if (s.startsWith('https://auth.openai.com/')) {
      tokenCalls += 1;
      return new Response(JSON.stringify(TOKEN_OK), { status: 200 });
    }
    if (s.startsWith('https://chatgpt.com/')) {
      backendCalls += 1;
      return new Response('{"error":"unauthorized"}', { status: 401 });
    }
    throw new Error(`unexpected fetch: ${s}`);
  };

  const backup = await mockUpstream((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-backup', object: 'chat.completion', model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'from-backup' }, finish_reason: 'stop' }],
      }));
    });
  });

  const providers = [
    ...codexProviders(),
    {
      id: 'gpt-backup', type: 'openai',
      baseUrl: `http://127.0.0.1:${backup.port}/v1/chat/completions`,
      apiKeyRef: 'env:TEST_GPT_BACKUP_KEY', models: ['gpt-6-sol'],
    },
  ];
  const gw = await startGateway({ providers, secretsDir, fetchImpl });
  process.env.TEST_GPT_BACKUP_KEY = 'sk-backup';
  try {
    const resp = await call(gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.choices[0].message.content, 'from-backup');
    assert.equal(json.model, 'gpt-6-sol');

    // 完整链路证据：codex backend 401（client.send 强制刷新后重试一次 → ≥2 次后端调用）
    assert.ok(backendCalls >= 2, `backend called ${backendCalls}x (forced-refresh retry expected)`);
    assert.ok(tokenCalls >= 1, 'token refresh attempted');
    // fallback 事件：codex-main → gpt-backup，reason=auth
    const fb = gw.events.list({ type: 'fallback' });
    assert.equal(fb.length, 1);
    assert.equal(fb[0].from, 'codex-main');
    assert.equal(fb[0].to, 'gpt-backup');
    assert.equal(fb[0].reason, 'auth');
    assert.equal(fb[0].model, 'gpt-6-sol');
  } finally {
    delete process.env.TEST_GPT_BACKUP_KEY;
    gw.server.close();
    backup.server.close();
  }
});

test('integration: codex unhealthy（secrets 缺失）→ fallback 链跳过 codex 直达 backup', async () => {
  const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-empty-')); // 无 codex.json
  const backup = await mockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-b2', object: 'chat.completion', model: 'gpt-6-sol',
      choices: [{ index: 0, message: { role: 'assistant', content: 'healthy-path' }, finish_reason: 'stop' }],
    }));
  });
  const providers = [
    ...codexProviders(),
    {
      id: 'gpt-backup', type: 'openai',
      baseUrl: `http://127.0.0.1:${backup.port}/v1/chat/completions`,
      apiKeyRef: 'env:TEST_GPT_BACKUP_KEY', models: ['gpt-6-sol'],
    },
  ];
  const gw = await startGateway({ providers, secretsDir, fetchImpl: async () => { throw new Error('should not fetch'); } });
  process.env.TEST_GPT_BACKUP_KEY = 'sk-backup';
  try {
    assert.equal(gw.registry.get('codex-main').healthy(), false, 'secrets missing → unhealthy');
    const resp = await call(gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.choices[0].message.content, 'healthy-path');
    const fb = gw.events.list({ type: 'fallback' });
    assert.equal(fb.length, 1);
    assert.equal(fb[0].from, 'codex-main');
    assert.equal(fb[0].to, 'gpt-backup');
    assert.equal(fb[0].reason, 'unhealthy');
  } finally {
    delete process.env.TEST_GPT_BACKUP_KEY;
    gw.server.close();
    backup.server.close();
  }
});

test('integration: codex 429 → fallback 切换但不标记 unhealthy（临时额度耗尽）', async () => {
  const secretsDir = await makeSecretsDir();
  const backup = await mockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-b3', object: 'chat.completion', model: 'gpt-6-luna',
      choices: [{ index: 0, message: { role: 'assistant', content: 'backup-after-429' }, finish_reason: 'stop' }],
    }));
  });
  const providers = [
    { id: 'codex-main', type: 'codex', baseUrl: null, apiKeyRef: null, models: ['gpt-6-luna'] },
    {
      id: 'gpt-backup', type: 'openai',
      baseUrl: `http://127.0.0.1:${backup.port}/v1/chat/completions`,
      apiKeyRef: 'env:TEST_GPT_BACKUP_KEY', models: ['gpt-6-luna'],
    },
  ];
  const gw = await startGateway({
    providers, secretsDir,
    fetchImpl: codexFetch(async () => new Response('rate limited', { status: 429 })),
  });
  process.env.TEST_GPT_BACKUP_KEY = 'sk-backup';
  try {
    const resp = await call(gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.choices[0].message.content, 'backup-after-429');
    const fb = gw.events.list({ type: 'fallback' });
    assert.equal(fb[0].reason, 'rate_limited');
    // 429 不拉黑 provider（额度临时耗尽，token 有效）
    assert.equal(gw.registry.get('codex-main').healthy(), true);
  } finally {
    delete process.env.TEST_GPT_BACKUP_KEY;
    gw.server.close();
    backup.server.close();
  }
});

test('integration: 流式 — codex responses SSE → chat chunks 透传', async () => {
  const secretsDir = await makeSecretsDir();
  const gw = await startGateway({
    providers: codexProviders(),
    secretsDir,
    fetchImpl: codexFetch(async () => new Response(RESPONSES_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })),
  });
  try {
    const resp = await call(gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'gpt-6-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type'), /text\/event-stream/);
    const text = await resp.text();
    // 两个 delta chunk + completed（含 usage）+ [DONE]
    const chunks = text.split('\n\n').filter((l) => l.startsWith('data: '));
    const first = JSON.parse(chunks[0].slice(6));
    assert.equal(first.choices[0].delta.content, 'He');
    const second = JSON.parse(chunks[1].slice(6));
    assert.equal(second.choices[0].delta.content, 'llo');
    const last = JSON.parse(chunks[2].slice(6));
    assert.equal(last.choices[0].finish_reason, 'stop');
    assert.equal(last.usage.total_tokens, 6);
    assert.equal(chunks[3], 'data: [DONE]');
  } finally {
    gw.server.close();
  }
});

test('integration: /internal/providers 暴露 codex 健康度', async () => {
  const secretsDir = await makeSecretsDir({ expires: Date.now() + 3600_000 });
  const gw = await startGateway({ providers: codexProviders(), secretsDir, fetchImpl: codexFetch(async () => new Response('{}')) });
  try {
    const resp = await fetch(gw.url + '/internal/providers');
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.providers['codex-main'].healthy, true);
    assert.equal(json.providers['codex-main'].accountId, 'acct-int');
  } finally {
    gw.server.close();
  }
});
