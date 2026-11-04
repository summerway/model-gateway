// vision-routing.test.js — 视觉路由（v1 reroute）单测 + proxy 集成（mock upstream）。
// 单测：分区/回合状态/决策矩阵/copy-on-write；集成：model 改写、响应头、事件。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { applyVisionRouting, findVisionRouting, HISTORY_IMAGE_PLACEHOLDER } from '../src/gateway/vision-routing.js';
import { EventLog } from '../src/events.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const IMG_DATA = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
const IMG_URL = { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } };

const CATALOG = {
  providers: [
    {
      id: 'glm-primary',
      models: ['glm-5.3', 'glm-5.3-flash'],
      visionRouting: { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash' } },
    },
    {
      id: 'glm-backup',
      models: ['glm-5.3', 'glm-5.3-flash'],
      visionRouting: { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash' } },
    },
  ],
};
const CATALOG_UNCONFIGURED = { providers: [{ id: 'plain', models: ['glm-5.3'] }] };
const CATALOG_CONSUMED = {
  providers: [
    {
      id: 'glm-primary',
      models: ['glm-5.3', 'glm-5.3-flash'],
      visionRouting: { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'consumed' } },
    },
  ],
};

// ── 纯函数单测 ───────────────────────────────────────────────────────────────

test('applyVisionRouting: 新区图（user 首轮，无 assistant）→ reroute，像素保留，model=target', () => {
  const body = { model: 'glm-5.3', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, IMG_DATA] }] };
  const { body: out, routing } = applyVisionRouting(body, CATALOG);
  assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 1, placeholderCount: 0, uncertain: false });
  assert.equal(out.model, 'glm-5.3-flash');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: '看图' }, IMG_DATA], '新区像素原样保留');
  assert.equal(body.model, 'glm-5.3', '入参未被修改（copy-on-write）');
});

test('applyVisionRouting: 确定态历史图 + 无新区图 → placeholder only，模型不变，历史图变占位文本', () => {
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '这是什么' }, IMG_DATA] },
      { role: 'assistant', content: '是一只猫' },
      { role: 'user', content: '什么颜色' },
    ],
  };
  const { body: out, routing } = applyVisionRouting(body, CATALOG);
  assert.deepEqual(routing, { action: 'placeholder', from: 'glm-5.3', to: 'glm-5.3', newImages: 0, placeholderCount: 1, uncertain: false });
  assert.equal(out.model, 'glm-5.3', '仅历史图：模型不动');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: '这是什么' }, { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER }]);
  assert.equal(out.messages[1].content, '是一只猫');
  assert.equal(out.messages[2].content, '什么颜色');
});

test('applyVisionRouting: uncertain（最后 assistant 带非空 tool_calls）+ 仅历史图 → reroute 且历史像素保留（不占位）', () => {
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: [IMG_URL] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'look', arguments: '{}' } }] },
      { role: 'tool', content: 'tool output text' },
    ],
  };
  const { body: out, routing } = applyVisionRouting(body, CATALOG);
  assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 0, placeholderCount: 0, uncertain: true });
  assert.equal(out.model, 'glm-5.3-flash');
  assert.deepEqual(out.messages[0].content, [IMG_URL], 'uncertain：历史像素零占位保留');
});

test('applyVisionRouting: 确定态 新区图+历史图同请求 → 历史占位+新区保留+reroute', () => {
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: [IMG_DATA, { type: 'text', text: '第一张' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: '第二张' }, IMG_URL] },
    ],
  };
  const { body: out, routing } = applyVisionRouting(body, CATALOG);
  assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 1, placeholderCount: 1, uncertain: false });
  assert.equal(out.model, 'glm-5.3-flash');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: HISTORY_IMAGE_PLACEHOLDER }, { type: 'text', text: '第一张' }], '占位保持数组位置，非图 parts 不动');
  assert.deepEqual(out.messages[2].content, [{ type: 'text', text: '第二张' }, IMG_URL], '新区像素保留');
});

test('applyVisionRouting: tool result 消息 content 数组内嵌 image_url → 新区计数正确', () => {
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: '截图分析' },
      { role: 'assistant', content: '我来取图' },
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'tool 返回图' }, IMG_DATA] },
    ],
  };
  const { routing } = applyVisionRouting(body, CATALOG);
  assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 1, placeholderCount: 0, uncertain: false });
});

test('applyVisionRouting: input_image part（Responses 形态）识别', () => {
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/x.png' }] },
    ],
  };
  const { routing } = applyVisionRouting(body, CATALOG);
  assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 1, placeholderCount: 0, uncertain: false });
});

test('applyVisionRouting: 无图 → routing null，原 body 引用返回（byte-identical 语义）', () => {
  const body = { model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: '纯文本' }] };
  const { body: out, routing } = applyVisionRouting(body, CATALOG);
  assert.equal(routing, null);
  assert.equal(out, body, 'no-op 返回原引用');
});

test('applyVisionRouting: 未配置 visionRouting 的模型 → routing null', () => {
  const body = { model: 'glm-5.3', messages: [{ role: 'user', content: [IMG_DATA] }] };
  const { body: out, routing } = applyVisionRouting(body, CATALOG_UNCONFIGURED);
  assert.equal(routing, null);
  assert.equal(out, body);
  assert.equal(findVisionRouting(CATALOG_UNCONFIGURED, 'glm-5.3'), null);
  assert.deepEqual(findVisionRouting(CATALOG, 'glm-5.3'), { strategy: 'reroute', target: 'glm-5.3-flash' });
});

test('applyVisionRouting: copy-on-write —— 未变消息/content/其他字段保持引用，stream/tools 不碰', () => {
  const historyMsg = { role: 'user', content: [IMG_DATA] };
  const textMsg = { role: 'assistant', content: 'done' };
  const newMsg = { role: 'user', content: [{ type: 'text', text: '继续' }, IMG_URL] };
  const body = { model: 'glm-5.3', stream: true, tools: [{ type: 'function', function: { name: 'f' } }], messages: [historyMsg, textMsg, newMsg] };
  const { body: out } = applyVisionRouting(body, CATALOG);
  assert.equal(out.messages[1], textMsg, '无图消息保持原引用');
  assert.equal(out.messages[2], newMsg, '新区消息保持原引用（历史有图也只复制历史消息）');
  assert.equal(out.messages[0].content[1], undefined);
  assert.equal(out.stream, true, 'stream 不碰');
  assert.equal(out.tools, body.tools, 'tools 引用不变');
  assert.deepEqual(historyMsg.content, [IMG_DATA], '入参消息未被就地修改');
});

test('applyVisionRouting: 占位后消息顺序与 string content 不动；多图计数正确', () => {
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: 'string content 不动' },
      { role: 'user', content: [IMG_DATA, IMG_URL] },
      { role: 'assistant', content: [{ type: 'text', text: '两张都看了' }] },
      { role: 'user', content: '总结' },
    ],
  };
  const { body: out, routing } = applyVisionRouting(body, CATALOG);
  assert.deepEqual(routing, { action: 'placeholder', from: 'glm-5.3', to: 'glm-5.3', newImages: 0, placeholderCount: 2, uncertain: false });
  assert.equal(out.model, 'glm-5.3');
  assert.equal(out.messages[0].content, 'string content 不动');
  assert.equal(out.messages.length, 4, '消息顺序不变');
  assert.deepEqual(out.messages[1].content, [
    { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER },
    { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER },
  ]);
});

// ── v1.1 uncertain: 'consumed' —— 工具循环中已识别图占位，只保未消费像素 ──

const TOOL_ROUND = [
  { role: 'user', content: [{ type: 'text', text: '看这张截图' }, IMG_DATA] },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
];

test('consumed: uncertain + 全部已消费（工具循环续请求）→ placeholder only，模型不动，历史图占位', () => {
  const body = { model: 'glm-5.3', messages: structuredClone(TOOL_ROUND) };
  const { body: out, routing } = applyVisionRouting(body, CATALOG_CONSUMED);
  assert.deepEqual(routing, { action: 'placeholder', from: 'glm-5.3', to: 'glm-5.3', newImages: 0, placeholderCount: 1, uncertain: true });
  assert.equal(out.model, 'glm-5.3', '全已消费：不介入视觉 target，回合延续回主力模型');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: '看这张截图' }, { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER }]);
  assert.deepEqual(body.messages[0].content[1], IMG_DATA, '入参未就地修改（deepEqual：structuredClone 后非同引用）');
});

test('consumed: uncertain + 历史已消费图 + 新 user 未消费图 → reroute，新图保像素、历史占位', () => {
  const body = {
    model: 'glm-5.3',
    messages: [...structuredClone(TOOL_ROUND), { role: 'user', content: [{ type: 'text', text: '对比这张新的' }, IMG_URL] }],
  };
  const { body: out, routing } = applyVisionRouting(body, CATALOG_CONSUMED);
  assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 1, placeholderCount: 1, uncertain: true });
  assert.equal(out.model, 'glm-5.3-flash');
  assert.deepEqual(out.messages[0].content[1], { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER }, '已消费图占位');
  assert.deepEqual(out.messages[3].content[1], IMG_URL, '未消费新图像素保留');
});

test('consumed: uncertain + tool 结果新图（其后无 assistant）→ 未消费，像素保留并 reroute', () => {
  const body = {
    model: 'glm-5.3',
    messages: [
      { role: 'user', content: '截图分析' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'snap', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: [IMG_DATA] },
    ],
  };
  const { body: out, routing } = applyVisionRouting(body, CATALOG_CONSUMED);
  assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 1, placeholderCount: 0, uncertain: true });
  assert.deepEqual(out.messages[2].content, [IMG_DATA], 'tool 新图保像素');
});

test('consumed: 显式 pixels 与缺省一致 —— uncertain 零占位全像素 reroute（v1 行为不变）', () => {
  const rulePixels = { providers: [{ id: 'p', models: ['glm-5.3', 'glm-5.3-flash'], visionRouting: { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'pixels' } } }] };
  for (const cat of [rulePixels, CATALOG]) {
    const body = { model: 'glm-5.3', messages: structuredClone(TOOL_ROUND) };
    const { body: out, routing } = applyVisionRouting(body, cat);
    assert.deepEqual(routing, { action: 'reroute', from: 'glm-5.3', to: 'glm-5.3-flash', newImages: 0, placeholderCount: 0, uncertain: true });
    assert.deepEqual(out.messages[0].content[1], IMG_DATA, 'v1：历史像素零占位保留');
  }
});

test('consumed: findVisionRouting 返回含 uncertain 的完整规则', () => {
  assert.deepEqual(findVisionRouting(CATALOG_CONSUMED, 'glm-5.3'), { strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'consumed' });
});

// ── proxy 集成（mock upstream）───────────────────────────────────────────────

test('proxy: consumed 策略 —— 工具循环续请求全已消费 → 原模型 + 占位 content；vision_placeholder 事件 uncertain=true', async () => {
  const t = await setupVision({ strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'consumed' });
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      model: 'glm-5.3',
      stream: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看截图' }, IMG_URL] },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('x-gateway-vision-reroute'), null, '全已消费不加 reroute 头');
    assert.equal(t.seen[0].model, 'glm-5.3', '回合延续回原模型');
    assert.deepEqual(t.seen[0].messages[0].content, [
      { type: 'text', text: '看截图' },
      { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER },
    ], '已识别图已占位');
    const ev = t.events.list({ type: 'vision_placeholder' });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].uncertain, true);
    assert.equal(ev[0].placeholderCount, 1);
    assert.equal(ev[0].newImages, 0);
    assert.equal(t.events.list({ type: 'vision_reroute' }).length, 0);
  } finally {
    delete process.env.VISION_TEST_KEY;
    t.gw.server.close();
    t.upstream.server.close();
  }
});

function mockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function call(base, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { authorization: 'Bearer gw-test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function setupVision(rule = { strategy: 'reroute', target: 'glm-5.3-flash' }) {
  const seen = [];
  const upstream = await mockUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-1',
        model: seen.at(-1).model,
        choices: [{ message: { role: 'assistant', content: 'a cat' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }));
    });
  });
  const events = new EventLog(50);
  const providers = [{
    id: 'glm',
    displayName: '智谱',
    type: 'glm',
    baseUrl: `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
    apiKeyRef: 'env:VISION_TEST_KEY',
    models: ['glm-5.3', 'glm-5.3-flash'],
    modelDefs: { 'glm-5.3': ['text'], 'glm-5.3-flash': ['text', 'image'] },
    visionRouting: { 'glm-5.3': rule },
  }];
  const handler = createRequestHandler({
    config: { gateway: { keys: ['gw-test-key'] } },
    catalog: { providers },
    events,
    quotaStore: { snapshot: () => ({}) },
  });
  const gw = await new Promise((resolve) => {
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  process.env.VISION_TEST_KEY = 'dummy';
  return { seen, events, gw, upstream };
}

test('proxy: glm-5.3 + 新区图 → upstream 收到 model=target；reroute 头；vision_reroute 事件', async () => {
  const t = await setupVision();
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      model: 'glm-5.3',
      stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, IMG_DATA] }],
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('x-gateway-vision-reroute'), 'glm-5.3->glm-5.3-flash');
    assert.equal(t.seen[0].model, 'glm-5.3-flash', 'upstream 收到 target 模型');
    assert.deepEqual(t.seen[0].messages[0].content, [{ type: 'text', text: 'describe' }, IMG_DATA], '像素透传');
    const ev = t.events.list({ type: 'vision_reroute' });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].from, 'glm-5.3');
    assert.equal(ev[0].to, 'glm-5.3-flash');
    assert.equal(ev[0].newImages, 1);
    assert.equal(ev[0].placeholderCount, 0);
    assert.equal(ev[0].uncertain, false);
    assert.equal(ev[0].path, 'chat');
    assert.equal(t.events.list({ type: 'vision_placeholder' }).length, 0);
  } finally {
    delete process.env.VISION_TEST_KEY;
    t.gw.server.close();
    t.upstream.server.close();
  }
});

test('proxy: glm-5.3 + 确定态历史图 + 无新图 → 原模型 + 占位 content；无头；vision_placeholder 事件', async () => {
  const t = await setupVision();
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      model: 'glm-5.3',
      stream: false,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '这是什么' }, IMG_URL] },
        { role: 'assistant', content: '是猫' },
        { role: 'user', content: '什么颜色' },
      ],
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('x-gateway-vision-reroute'), null, 'placeholder 不加头');
    assert.equal(t.seen[0].model, 'glm-5.3', '模型不动');
    assert.deepEqual(t.seen[0].messages[0].content, [
      { type: 'text', text: '这是什么' },
      { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER },
    ]);
    const ev = t.events.list({ type: 'vision_placeholder' });
    assert.equal(ev.length, 1);
    assert.deepEqual(
      { from: ev[0].from, to: ev[0].to, newImages: ev[0].newImages, placeholderCount: ev[0].placeholderCount, uncertain: ev[0].uncertain, path: ev[0].path },
      { from: 'glm-5.3', to: 'glm-5.3', newImages: 0, placeholderCount: 1, uncertain: false, path: 'chat' },
    );
    assert.equal(t.events.list({ type: 'vision_reroute' }).length, 0);
  } finally {
    delete process.env.VISION_TEST_KEY;
    t.gw.server.close();
    t.upstream.server.close();
  }
});

test('proxy: glm-5.3 纯文本 → 与现状一致（原模型、无头、无 vision 事件）', async () => {
  const t = await setupVision();
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      model: 'glm-5.3',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('x-gateway-vision-reroute'), null);
    assert.equal(t.seen[0].model, 'glm-5.3');
    assert.deepEqual(t.seen[0].messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(t.events.list({ type: 'vision_reroute' }).length, 0);
    assert.equal(t.events.list({ type: 'vision_placeholder' }).length, 0);
  } finally {
    delete process.env.VISION_TEST_KEY;
    t.gw.server.close();
    t.upstream.server.close();
  }
});

