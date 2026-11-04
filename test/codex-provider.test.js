/**
 * Codex provider 集成测试（模块内 mock，不打外网）:
 *  - /v1/chat/completions 形态（chat→responses→chat 全链路，含流式）
 *  - /v1/responses 形态透传
 *  - 刷新失败 → provider unhealthy → CodexProviderError(kind=auth) 供 fallback 跳过
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexProvider, CodexProviderError } from '../src/gateway/providers/codex/index.js';

const FIXTURE_RESP = {
  access_token: 'access.fresh',
  refresh_token: 'rt.fresh',
  id_token: 'id.fresh',
  expires_in: 3600,
};
function makeValidAccessJwt() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })}.x`;
}

const SSE_TEXT = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}\n\n',
].join('');

function sseResponse(text) {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** 按域名路由的 mock fetch：auth.openai.com → token 响应；chatgpt.com → handler。 */
function routingFetch(upstreamHandler, tokenResponseJson = FIXTURE_RESP) {
  return async (url, init) => {
    const urlStr = String(url);
    if (urlStr.startsWith('https://auth.openai.com/')) {
      return new Response(JSON.stringify(tokenResponseJson), { status: 200 });
    }
    return upstreamHandler(urlStr, init);
  };
}

async function makeProvider({ fetchImpl, expires = Date.now() - 1000 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-prov-'));
  await fs.writeFile(path.join(dir, 'codex.json'), JSON.stringify({
    type: 'oauth', access: 'access.old', refresh: 'rt.old', idToken: null, expires, accountId: 'acct-1',
  }), { mode: 0o600 });
  const provider = createCodexProvider({ secretsDir: dir, models: ['gpt-6-sol', 'gpt-6-luna'], fetchImpl });
  await provider.init();
  return { provider, dir };
}

describe('chatCompletions 入口（/v1/chat/completions 形态）', () => {
  test('非流式: chat→responses 请求体 + SSE 聚合响应体（codex backend 强制流式）', async () => {
    let captured;
    const sseBody = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Answer!"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchImpl = routingFetch(async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return sseResponse(sseBody);
    });
    const { provider } = await makeProvider({ fetchImpl });
    const chat = await provider.chatCompletions({
      model: 'gpt-6-sol',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
      ],
    });
    // 上游请求: chatgpt backend responses 端点 + OAuth 头 + 强制 stream:true
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(captured.headers.Authorization, 'Bearer access.fresh'); // 已自动刷新
    assert.equal(captured.headers['chatgpt-account-id'], 'acct-1');
    assert.equal(captured.headers.originator, 'model-gateway');
    assert.equal(captured.headers.Accept, 'text/event-stream');
    assert.equal(captured.body.instructions, 'sys');
    assert.equal(captured.body.stream, true); // 后端强制流式
    assert.equal(captured.body.store, false);
    assert.deepEqual(captured.body.input[0].content, [{ type: 'input_text', text: 'q' }]);
    assert.equal(captured.body.model, 'gpt-6-sol');
    // 下游响应: chat.completion（SSE 聚合）
    assert.equal(chat.object, 'chat.completion');
    assert.equal(chat.choices[0].message.content, 'Answer!');
    assert.equal(chat.usage.prompt_tokens, 3);
  });

  test('originator 可配：透传到上游请求头（对齐 pi 原生指纹）', async () => {
    let captured;
    const fetchImpl = routingFetch((url, init) => {
      captured = { url, headers: init.headers };
      return new Response(JSON.stringify({
        id: 'resp_o', status: 'completed', model: 'gpt-6-sol', created_at: 1761020400,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-prov-o'));
    await fs.writeFile(path.join(dir, 'codex.json'), JSON.stringify({
      type: 'oauth', access: 'access.old', refresh: 'rt.old', idToken: null,
      expires: Date.now() - 1000, accountId: 'acct-1',
    }), { mode: 0o600 });
    const provider = createCodexProvider({ secretsDir: dir, models: ['gpt-6-sol'], originator: 'pi', fetchImpl });
    await provider.init();
    await provider.chatCompletions({ model: 'gpt-6-sol', messages: [{ role: 'user', content: 'q' }] });
    assert.equal(captured.headers.originator, 'pi');
  });

  test('流式: 产出 chat chunk 字符串流（delta + [DONE]）', async () => {
    const fetchImpl = routingFetch(async () => sseResponse(SSE_TEXT));
    const { provider } = await makeProvider({ fetchImpl });
    const stream = await provider.chatCompletions({
      model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'q' }],
    });
    const parts = [];
    for await (const chunk of stream) parts.push(chunk);
    assert.ok(parts.length >= 3);
    const first = JSON.parse(parts[0].replace(/^data: /, ''));
    assert.equal(first.choices[0].delta.content, 'Hi');
    assert.equal(parts.at(-1), 'data: [DONE]\n\n');
  });
});

describe('responses 入口（/v1/responses 形态）', () => {
  test('非流式: 上行改 stream:true，SSE 聚合成 response 对象（codex backend 强制流式）', async () => {
    let captured;
    const sseBody = [
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"read_file","arguments":"{}"}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":2}}}',
      '',
    ].join('\n');
    const fetchImpl = routingFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return sseResponse(sseBody);
    }, { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    const raw = await provider.responses({ model: 'gpt-6-sol', input: 'direct' });
    assert.equal(raw.status, 200);
    const resp = await raw.json();
    assert.equal(captured.body.input, 'direct');
    assert.equal(captured.body.stream, true);
    assert.equal(resp.id, 'resp_2');
    assert.equal(resp.usage.input_tokens, 3);
    assert.deepEqual(resp.output.map((i) => i.type), ['function_call', 'message']);
  });

  test('非流式: 终态 response 自带 output 时原样保留', async () => {
    const sseBody = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[{"type":"message","id":"m1"}]}}\n\n';
    const fetchImpl = routingFetch(async () => sseResponse(sseBody), { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    const resp = await (await provider.responses({ model: 'gpt-6-sol', input: 'x' })).json();
    assert.deepEqual(resp.output, [{ type: 'message', id: 'm1' }]);
  });

  test('非流式: response.failed → 502，error 保留', async () => {
    const sseBody = 'event: response.failed\ndata: {"type":"response.failed","response":{"id":"r","status":"failed","error":{"code":"server_error"}}}\n\n';
    const fetchImpl = routingFetch(async () => sseResponse(sseBody), { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    const raw = await provider.responses({ model: 'gpt-6-sol', input: 'x' });
    assert.equal(raw.status, 502);
    assert.equal((await raw.json()).error.code, 'server_error');
  });

  test('流式: 上游 SSE 原样返回', async () => {
    let captured;
    const fetchImpl = routingFetch(async (url, init) => {
      captured = JSON.parse(init.body);
      return sseResponse(SSE_TEXT);
    }, { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    const raw = await provider.responses({ model: 'gpt-6-sol', input: 'x', stream: true });
    assert.equal(captured.stream, true);
    assert.equal(await raw.text(), SSE_TEXT);
  });

  test('temperature / top_p 不上行（backend 400 Unsupported parameter），其余字段透传', async () => {
    let captured;
    const fetchImpl = routingFetch(async (url, init) => {
      captured = JSON.parse(init.body);
      return sseResponse(SSE_TEXT);
    }, { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    await provider.responses({ model: 'gpt-6-sol', input: 'x', stream: true, temperature: 0.2, top_p: 0.9, max_output_tokens: 50 });
    assert.equal('temperature' in captured, false);
    assert.equal('top_p' in captured, false);
    assert.equal(captured.max_output_tokens, 50);
  });
});

describe('会话粘性头透传（前缀缓存命中依赖）', () => {
  test('session/thread/window 头上行；认证与 originator 不可被覆盖；其他头丢弃', async () => {
    let captured;
    const fetchImpl = routingFetch(async (url, init) => {
      captured = init.headers;
      return sseResponse(SSE_TEXT);
    }, { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    await provider.responses({ model: 'gpt-6-sol', input: 'x', stream: true }, {
      sessionHeaders: {
        'session-id': 'sess-1',
        'thread-id': 'sess-1',
        'x-client-request-id': 'sess-1',
        'x-codex-window-id': 'sess-1:0',
        'x-codex-turn-metadata': '{"turn_id":"t1"}',
        authorization: 'Bearer gw-client-key',
        originator: 'codex_exec',
        'x-codex-beta-features': 'remote_compaction_v2',
        cookie: 'c=1',
      },
    });
    assert.equal(captured['session-id'], 'sess-1');
    assert.equal(captured['thread-id'], 'sess-1');
    assert.equal(captured['x-client-request-id'], 'sess-1');
    assert.equal(captured['x-codex-window-id'], 'sess-1:0');
    assert.equal(captured['x-codex-turn-metadata'], '{"turn_id":"t1"}');
    assert.match(captured.Authorization, /^Bearer /);
    assert.notEqual(captured.Authorization, 'Bearer gw-client-key');
    assert.equal('authorization' in captured, false);
    assert.equal(captured.originator, 'model-gateway');
    assert.equal('x-codex-beta-features' in captured, false);
    assert.equal('cookie' in captured, false);
  });

  test('未传 sessionHeaders 时行为不变', async () => {
    let captured;
    const fetchImpl = routingFetch(async (url, init) => {
      captured = init.headers;
      return sseResponse(SSE_TEXT);
    }, { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    await provider.responses({ model: 'gpt-6-sol', input: 'x', stream: true });
    assert.equal('session-id' in captured, false);
    assert.match(captured.Authorization, /^Bearer /);
  });
});

describe('chat 入口剥离采样参数', () => {
  test('chat temperature 不上行（此前 chat 路径任意 temperature 都 502）', async () => {
    let captured;
    const fetchImpl = routingFetch(async (url, init) => {
      captured = JSON.parse(init.body);
      return sseResponse(SSE_TEXT);
    }, { ...FIXTURE_RESP, access_token: makeValidAccessJwt() });
    const { provider } = await makeProvider({ fetchImpl });
    const chat = await provider.chatCompletions({ model: 'gpt-6-sol', messages: [{ role: 'user', content: 'q' }], temperature: 0.2, top_p: 1 });
    assert.equal('temperature' in captured, false);
    assert.equal('top_p' in captured, false);
    assert.equal(chat.choices[0].message.content, 'Hi');
  });
});

describe('降级（fallback 链跳过 codex）', () => {
  test('token 刷新持续失败 → healthy()=false + CodexProviderError(kind=auth)', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('auth.openai.com')) {
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      throw new Error('upstream should not be reached');
    };
    const { provider } = await makeProvider({ fetchImpl });
    assert.equal(provider.healthy(), true);
    await assert.rejects(
      () => provider.chatCompletions({ model: 'gpt-6-sol', messages: [{ role: 'user', content: 'q' }] }),
      (err) => err instanceof CodexProviderError && err.kind === 'auth',
    );
    assert.equal(provider.healthy(), false);
    assert.match(provider.status().reason, /invalid_grant|refresh failed/);
  });

  test('上游 429 → CodexProviderError(kind=rate_limited, retryable)', async () => {
    const fetchImpl = routingFetch(async () => new Response('rate limited', { status: 429 }));
    const { provider } = await makeProvider({ fetchImpl });
    await assert.rejects(
      () => provider.chatCompletions({ model: 'gpt-6-sol', messages: [{ role: 'user', content: 'q' }] }),
      (err) => err instanceof CodexProviderError && err.kind === 'rate_limited' && err.retryable === true,
    );
    // 429 不标记 unhealthy（账号额度临时耗尽，fallback 跳过本请求即可）
    assert.equal(provider.healthy(), true);
  });
});
