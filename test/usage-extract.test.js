// usage-extract.test.js — usage 归一化提取 + SSE 旁路扫描。

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, SseUsageTap } from '../src/monitor/extract.js';

test('extractUsage: openai 标准形态（cached ⊂ prompt_tokens）', () => {
  const u = extractUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 800 } });
  assert.deepEqual(u, { input: 200, output: 200, cacheRead: 800, cacheWrite: 0 });
});

test('extractUsage: deepseek 形态（hit/miss 拆分）', () => {
  const u = extractUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 });
  assert.deepEqual(u, { input: 100, output: 50, cacheRead: 900, cacheWrite: 0 });
});

test('extractUsage: anthropic 形态（input_tokens 不含缓存项）', () => {
  const u = extractUsage({ input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 7000, cache_creation_input_tokens: 30 });
  assert.deepEqual(u, { input: 120, output: 80, cacheRead: 7000, cacheWrite: 30 });
});

test('extractUsage: responses 形态（input_tokens + details.cached_tokens）', () => {
  const u = extractUsage({ input_tokens: 500, output_tokens: 60, input_tokens_details: { cached_tokens: 400 } });
  assert.deepEqual(u, { input: 100, output: 60, cacheRead: 400, cacheWrite: 0 });
});

test('extractUsage: zhipu 形态（无缓存字段）', () => {
  const u = extractUsage({ prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 });
  assert.deepEqual(u, { input: 300, output: 40, cacheRead: 0, cacheWrite: 0 });
});

test('extractUsage: 无效输入返回 null', () => {
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage(undefined), null);
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage({ total_tokens: 5 }), null);
});

test('SseUsageTap: chat 流末 chunk usage（跨 chunk 拆行也识别）', () => {
  const tap = new SseUsageTap();
  tap.feed('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  tap.feed('data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":3');
  tap.feed('00,"prompt_tokens_details":{"cached_tokens":1000}}}\n\n');
  tap.feed('data: [DONE]\n\n');
  assert.equal(tap.reported, true);
  assert.deepEqual(tap.usage, { input: 200, output: 300, cacheRead: 1000, cacheWrite: 0 });
});

test('SseUsageTap: responses 透传流 response.completed 的 usage', () => {
  const tap = new SseUsageTap();
  tap.feed('event: response.completed\n');
  tap.feed('data: {"type":"response.completed","response":{"usage":{"input_tokens":80,"output_tokens":9,"input_tokens_details":{"cached_tokens":50}}}}\n\n');
  assert.equal(tap.reported, true);
  assert.deepEqual(tap.usage, { input: 30, output: 9, cacheRead: 50, cacheWrite: 0 });
});

test('SseUsageTap: 无 usage 的流保持未上报', () => {
  const tap = new SseUsageTap();
  tap.feed('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');
  assert.equal(tap.reported, false);
  assert.equal(tap.usage, null);
});

test('SseUsageTap: Anthropic 原生流 message_start 输入 + message_delta 输出合并', () => {
  const tap = new SseUsageTap();
  tap.feed('event: message_start\n');
  tap.feed('data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":900}}}\n\n');
  tap.feed('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n');
  tap.feed('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n');
  assert.equal(tap.reported, true);
  assert.deepEqual(tap.usage, { input: 120, output: 42, cacheRead: 900, cacheWrite: 0 });
});

test('SseUsageTap: 终止标记探测（[DONE] / response.completed / message_stop）', () => {
  const done = new SseUsageTap();
  done.feed('data: {"choices":[]}\n\ndata: [DONE]\n\n');
  assert.equal(done.completed, true);

  const resp = new SseUsageTap();
  resp.feed('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n');
  assert.equal(resp.completed, true);
  assert.equal(resp.reported, true);

  const anth = new SseUsageTap();
  anth.feed('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  assert.equal(anth.completed, true);

  const mid = new SseUsageTap();
  mid.feed('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n');
  assert.equal(mid.completed, false);
});
