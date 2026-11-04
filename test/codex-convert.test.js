/** responses ↔ chat/completions 转换测试 — fixture 驱动（含 SSE 流式与 tool_calls）。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chatToResponses, responsesToChat, createSseConverter, parseSseStream,
} from '../src/gateway/providers/codex/responses-convert.js';
import { fromPiAuth, fromCodexCliAuth, toCodexCliAuth } from '../src/gateway/providers/codex/convert.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (f) => JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8'));
const readFixtureText = (f) => readFileSync(path.join(FIXTURES, f), 'utf8');

describe('chatToResponses（请求方向）', () => {
  test('system 聚合为 instructions；user/assistant 进 input', () => {
    const out = chatToResponses({
      model: 'gpt-6-sol',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Bye' },
      ],
    });
    assert.equal(out.model, 'gpt-6-sol');
    assert.equal(out.instructions, 'Be terse.');
    assert.equal(out.input.length, 3);
    assert.deepEqual(
      out.input.map((i) => i.role),
      ['user', 'assistant', 'user'],
    );
    assert.deepEqual(out.input[0].content, [{ type: 'input_text', text: 'Hi' }]);
    assert.equal(out.stream, false);
    assert.equal(out.store, false); // codex backend 强制无状态
  });

  test('多模态 image_url → input_image；max_tokens/temperature/reasoning 映射', () => {
    const out = chatToResponses({
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ] }],
      max_tokens: 512,
      temperature: 0.2,
      reasoning_effort: 'high',
    });
    assert.deepEqual(out.input[0].content, [
      { type: 'input_text', text: '看图' },
      { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
    ]);
    assert.equal(out.max_output_tokens, undefined); // codex backend 不支持，不透传
    assert.equal(out.temperature, 0.2);
    assert.deepEqual(out.reasoning, { effort: 'high' });
  });

  test('tools function 定义转换 + tool_choice 透传', () => {
    const out = chatToResponses({
      model: 'gpt-6-sol',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      }],
      tool_choice: 'auto',
    });
    assert.deepEqual(out.tools, [{
      type: 'function', name: 'get_weather', description: 'w',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    }]);
    assert.equal(out.tool_choice, 'auto');
  });

  test('thinkingLevelMap 覆盖默认映射（off→none）', () => {
    const out = chatToResponses(
      { model: 'm', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'off' },
      { thinkingLevelMap: { off: 'none', low: 'low' } },
    );
    assert.deepEqual(out.reasoning, { effort: 'none' });
  });

  test('工具回合: assistant.tool_calls → function_call；role:tool → function_call_output（无 role:tool 泄漏）', () => {
    const out = chatToResponses({
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call_k6LZ', type: 'function',
          function: { name: 'read', arguments: '{"path":"SKILL.md"}' },
        }] },
        { role: 'tool', tool_call_id: 'call_k6LZ', content: '---\nname: nas-project-lifecycle' },
      ],
    });
    // 无任何 role:'tool' / content为空的 assistant 条目（responses 上游会 400）
    assert.equal(out.input.filter((i) => i.role === 'tool').length, 0);
    assert.deepEqual(
      out.input.map((i) => i.type ?? `msg:${i.role}`),
      ['msg:user', 'function_call', 'function_call_output'],
    );
    assert.deepEqual(out.input[1], {
      type: 'function_call', call_id: 'call_k6LZ', name: 'read',
      arguments: '{"path":"SKILL.md"}',
    });
    assert.deepEqual(out.input[2], {
      type: 'function_call_output', call_id: 'call_k6LZ',
      output: '---\nname: nas-project-lifecycle',
    });
  });

  test('assistant 文本+tool_calls 并存：output_text 消息在前，function_call 在后；tool 多段 content 拼接', () => {
    const out = chatToResponses({
      model: 'gpt-6-luna',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '先查一下',
          tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'f', arguments: {} } }],
        },
        { role: 'tool', tool_call_id: 'call_a', content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] },
      ],
    });
    assert.deepEqual(
      out.input.map((i) => i.type ?? `msg:${i.role}`),
      ['msg:user', 'msg:assistant', 'function_call', 'function_call_output'],
    );
    assert.deepEqual(out.input[1].content, [{ type: 'output_text', text: '先查一下' }]);
    assert.equal(out.input[2].arguments, '{}'); // 非 string arguments 序列化
    assert.equal(out.input[3].output, 'part1part2');
  });

  test('纯文本 assistant 历史回合用 output_text（非 input_text）', () => {
    const out = chatToResponses({
      model: 'gpt-6-sol',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Bye' },
      ],
    });
    assert.deepEqual(out.input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] });
  });
});

describe('responsesToChat（非流式，fixture）', () => {
  test('纯文本响应: content/usage/finish_reason', () => {
    const fixture = readFixture('codex-responses-completed.json');
    const chat = responsesToChat(fixture, { model: 'gpt-6-sol' });
    assert.equal(chat.object, 'chat.completion');
    assert.equal(chat.model, 'gpt-6-sol');
    assert.equal(chat.choices[0].message.content, 'Hello! How can I help you today?');
    assert.equal(chat.choices[0].message.tool_calls, undefined);
    assert.equal(chat.choices[0].finish_reason, 'stop');
    assert.deepEqual(chat.usage, { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 });
  });

  test('tool_calls 响应: function_call item → tool_calls 数组', () => {
    const fixture = readFixture('codex-responses-toolcall.json');
    const chat = responsesToChat(fixture, { model: 'gpt-6-sol' });
    assert.equal(chat.choices[0].message.content, "I'll check the weather for you.");
    assert.deepEqual(chat.choices[0].message.tool_calls, [{
      id: 'call_wx_001',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city": "Tokyo"}' },
    }]);
    assert.equal(chat.choices[0].finish_reason, 'stop');
  });

  test('incomplete(max_output_tokens) → finish_reason length', () => {
    const chat = responsesToChat({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'trunc' }] }],
    }, { model: 'm' });
    assert.equal(chat.choices[0].finish_reason, 'length');
  });
});

describe('SSE 转换（fixture）', () => {
  test('文本流: delta 事件 → chat chunks + [DONE]', () => {
    const sse = readFixtureText('codex-responses-sse-text.txt');
    const events = parseSseStream(sse);
    assert.equal(events.length, 6);
    const converter = createSseConverter({ model: 'gpt-6-luna' });
    const chunks = converter.feed(sse);
    // 2 个 delta + completed + [DONE]
    assert.equal(chunks.length, 4);
    const deltas = chunks.slice(0, 2).map((c) => JSON.parse(c.replace(/^data: /, '').trim()));
    assert.deepEqual(
      deltas.map((d) => d.choices[0].delta.content),
      ['Hel', 'lo!'],
    );
    assert.equal(deltas[0].model, 'gpt-6-luna');
    assert.equal(deltas[0].object, 'chat.completion.chunk');
    const finalChunk = JSON.parse(chunks[2].replace(/^data: /, '').trim());
    assert.equal(finalChunk.choices[0].finish_reason, 'stop');
    assert.deepEqual(finalChunk.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    assert.equal(chunks[3], 'data: [DONE]\n\n');
  });

  test('工具流: function_call item → tool_calls chunk，finish_reason tool_calls', () => {
    const sse = readFixtureText('codex-responses-sse-toolcall.txt');
    const converter = createSseConverter({ model: 'gpt-6-luna' });
    const chunks = converter.feed(sse);
    const toolChunk = JSON.parse(chunks[0].replace(/^data: /, '').trim());
    assert.deepEqual(toolChunk.choices[0].delta.tool_calls, [{
      index: 0,
      id: 'call_db_001',
      type: 'function',
      function: { name: 'query_db', arguments: '{"sql": "SELECT 1"}' },
    }]);
    const finalChunk = JSON.parse(chunks[1].replace(/^data: /, '').trim());
    assert.equal(finalChunk.choices[0].finish_reason, 'tool_calls');
  });

  test('分块喂入（跨事件边界）与不完整事件缓冲', () => {
    const sse = readFixtureText('codex-responses-sse-text.txt');
    const converter = createSseConverter({ model: 'gpt-6-luna' });
    // 按 17 字节切块喂入，跨 '\n\n' 边界
    const all = [];
    for (let i = 0; i < sse.length; i += 17) {
      all.push(...converter.feed(sse.slice(i, i + 17)));
    }
    assert.equal(all.length, 4);
    const deltas = all.slice(0, 2).map((c) => JSON.parse(c.replace(/^data: /, '').trim()));
    assert.deepEqual(deltas.map((d) => d.choices[0].delta.content), ['Hel', 'lo!']);
  });
});

describe('凭据格式转换', () => {
  test('pi auth.json → 网关凭据', () => {
    const creds = fromPiAuth({
      'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 123, accountId: 'acct' },
    });
    assert.deepEqual(creds, { type: 'oauth', access: 'a', refresh: 'r', idToken: null, expires: 123, accountId: 'acct' });
    assert.equal(fromPiAuth({ 'openai-codex': { type: 'api_key' } }), null);
    assert.equal(fromPiAuth({}), null);
  });

  test('codex CLI auth.json ↔ 网关凭据', () => {
    const cli = { OPENAI_API_KEY: null, tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r', account_id: 'acct' } };
    const creds = fromCodexCliAuth(cli);
    assert.equal(creds.access, 'a');
    assert.equal(creds.expires, 0);
    assert.deepEqual(toCodexCliAuth(creds), cli);
    assert.equal(fromCodexCliAuth({ OPENAI_API_KEY: 'sk-x' }), null);
  });
});
