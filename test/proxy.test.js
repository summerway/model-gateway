// proxy.test.js — router end-to-end against a mock upstream (fallback, SSE passthrough, endpoints).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { EventLog } from '../src/events.js';

function mockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function gateway(config, catalog, events) {
  return new Promise((resolve) => {
    const handler = createRequestHandler({
      config,
      catalog,
      events,
      quotaStore: { snapshot: () => ({}) },
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

function setup({ primaryHandler, backupHandler, providers } = {}) {
  const events = new EventLog(100);
  return (async () => {
    const primary = await mockUpstream(primaryHandler);
    const backup = await mockUpstream(backupHandler);
    const catalog = {
      providers: providers ?? [
        {
          id: 'primary',
          type: 'openai',
          baseUrl: `http://127.0.0.1:${primary.port}/v1/chat/completions`,
          apiKeyRef: 'env:TEST_PRIMARY_KEY',
          models: ['m1'],
        },
        {
          id: 'backup',
          type: 'openai',
          baseUrl: `http://127.0.0.1:${backup.port}/v1/chat/completions`,
          apiKeyRef: 'env:TEST_BACKUP_KEY',
          models: ['m1'],
        },
      ],
    };
    const config = { gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] } };
    const gw = await gateway(config, catalog, events);
    return { events, primary, backup, gw, catalog };
  })();
}

test('chat/completions: developer role normalized to system for glm upstream (1214 fix)', async () => {
  let upstreamBody = null;
  const t = await setup({
    providers: [
      {
        id: 'glm-stub',
        type: 'glm',
        baseUrl: 'http://127.0.0.1:PLACEHOLDER_PORT/v1/chat/completions',
        apiKeyRef: 'env:TEST_PRIMARY_KEY',
        models: ['glm-5.3-flash'],
      },
    ],
    primaryHandler: (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        upstreamBody = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', model: 'glm-5.3-flash', choices: [{ message: { content: 'ok' } }] }));
      });
    },
  });
  t.catalog.providers[0].baseUrl = `http://127.0.0.1:${t.primary.port}/v1/chat/completions`;
  process.env.TEST_PRIMARY_KEY = 'sk-primary';
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'glm-5.3-flash',
        messages: [
          { role: 'developer', content: 'You are pi.' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
        stream: true,
      },
    });
    assert.equal(resp.status, 200);
    assert.ok(upstreamBody, 'upstream received the request');
    const roles = upstreamBody.messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user']);
    assert.equal(upstreamBody.messages[0].content, 'You are pi.');
    assert.deepEqual(upstreamBody.messages[1].content, [{ type: 'text', text: 'hi' }]);
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('chat/completions: primary 429 → backup 200; fallback event recorded', async () => {
  const t = await setup({
    primaryHandler: (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limited' }));
    },
    backupHandler: (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', model: parsed.model, choices: [{ message: { content: 'from-backup' } }] }));
      });
    },
  });
  process.env.TEST_PRIMARY_KEY = 'sk-primary';
  process.env.TEST_BACKUP_KEY = 'sk-backup';
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.choices[0].message.content, 'from-backup');
    const fbEvents = t.events.list({ type: 'fallback' });
    assert.equal(fbEvents.length, 1);
    assert.equal(fbEvents[0].from, 'primary');
    assert.equal(fbEvents[0].to, 'backup');
    assert.equal(fbEvents[0].reason, 'rate_limited');
    assert.equal(fbEvents[0].model, 'm1');
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('chat/completions: primary 500 → backup 200 (5xx retriable)', async () => {
  const t = await setup({
    primaryHandler: (req, res) => {
      res.writeHead(500);
      res.end('{"error":"boom"}');
    },
    backupHandler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    },
  });
  process.env.TEST_PRIMARY_KEY = 'k1';
  process.env.TEST_BACKUP_KEY = 'k2';
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('all upstreams fail → 502 with attempts', async () => {
  const t = await setup({
    primaryHandler: (req, res) => {
      res.writeHead(503);
      res.end();
    },
    backupHandler: (req, res) => {
      res.writeHead(429);
      res.end();
    },
  });
  process.env.TEST_PRIMARY_KEY = 'k1';
  process.env.TEST_BACKUP_KEY = 'k2';
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 502);
    const json = await resp.json();
    assert.ok(json.error.attempts.length >= 2);
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('streaming SSE: chunks piped through unbuffered, no fallback after first byte', async () => {
  const chunks = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
  const t = await setup({
    primaryHandler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) res.write(chunks[i++]);
        else {
          clearInterval(timer);
          res.end();
        }
      }, 10);
    },
    backupHandler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"from":"backup"}\n\ndata: [DONE]\n\n');
    },
  });
  process.env.TEST_PRIMARY_KEY = 'k1';
  process.env.TEST_BACKUP_KEY = 'k2';
  try {
    const resp = await call(t.gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'm1', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type'), /text\/event-stream/);
    const text = await resp.text();
    assert.ok(text.includes('"a":1'));
    assert.ok(text.includes('[DONE]'));
    assert.equal(t.events.list({ type: 'fallback' }).length, 0);
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('client aborts mid-SSE → recorded as client_abort, not request_error', async () => {
  const t = await setup({
    primaryHandler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => res.write(`data: {"i":${i++}}\n\n`), 5);
      res.on('close', () => clearInterval(timer));
    },
    backupHandler: (req, res) => { res.writeHead(200); res.end('{}'); },
  });
  process.env.TEST_PRIMARY_KEY = 'k1';
  process.env.TEST_BACKUP_KEY = 'k2';
  try {
    const ac = new AbortController();
    const resp = await fetch(t.gw.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer gw-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    });
    assert.equal(resp.status, 200);
    const reader = resp.body.getReader();
    await reader.read(); // 首块已透传，此后客户端打断（同 Pi 中断生成）
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
    const errs = t.events.list({ type: 'request_error' });
    assert.deepEqual(errs, [], 'client abort must not be recorded as request_error');
    assert.equal(t.events.list({ type: 'client_abort' }).length, 1);
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('upstream stream exceeds streamSec → recorded as upstream timeout, not client_abort', async () => {
  const events = new EventLog(100);
  const primary = await mockUpstream((req, res) => {
    // 持续产块的长生成：数据一直在流动（排除空闲超时语义），但总时长超过 streamSec
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const timer = setInterval(() => res.write(`data: {"i":${i++}}\n\n`), 5);
    res.on('close', () => clearInterval(timer));
  });
  const catalog = {
    providers: [{
      id: 'primary', type: 'openai',
      baseUrl: `http://127.0.0.1:${primary.port}/v1/chat/completions`,
      apiKeyRef: 'env:TEST_PRIMARY_KEY', models: ['m1'],
    }],
  };
  // streamSec=0.05 → streamMs 下限 50ms：网关必在总时长封顶处掐断上游
  const config = { gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'], timeouts: { streamSec: 0.05 } } };
  const gw = await gateway(config, catalog, events);
  process.env.TEST_PRIMARY_KEY = 'k1';
  try {
    const resp = await fetch(gw.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer gw-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm1', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(resp.status, 200);
    // 持续读到网关掐断上游（客户端不主动断，否则才是真 client_abort）
    await resp.arrayBuffer().catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events.list({ type: 'client_abort' }).length, 0,
      'gateway-initiated stream timeout must not be booked as client_abort');
    const errs = events.list({ type: 'request_error' });
    assert.equal(errs.length, 1, 'stream timeout must be recorded as request_error');
    assert.equal(errs[0].kind, 'timeout');
    assert.match(errs[0].error, /stream timeout after 50ms/);
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    primary.server.close();
    gw.server.close();
  }
});

test('upstream connection refused (network) → fallback to backup', async () => {
  const events = new EventLog(100);
  // Reserve a real ephemeral port, then free it → genuine ECONNREFUSED.
  // (Port 9 etc. hit undici's bad-port list: "bad port" error with no errno.)
  const deadPort = await new Promise((resolve) => {
    const probeSrv = http.createServer(() => {});
    probeSrv.listen(0, '127.0.0.1', () => {
      const p = probeSrv.address().port;
      probeSrv.close(() => resolve(p));
    });
  });
  // Backup is alive.
  const backup = await mockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"net-ok"}}]}');
  });
  const catalog = {
    providers: [
      { id: 'dead', type: 'openai', baseUrl: `http://127.0.0.1:${deadPort}/v1/chat/completions`, apiKeyRef: 'env:K', models: ['m1'] },
      { id: 'backup', type: 'openai', baseUrl: `http://127.0.0.1:${backup.port}/v1/chat/completions`, apiKeyRef: 'env:K2', models: ['m1'] },
    ],
  };
  const config = { gateway: { keys: ['gw-test-key'] } };
  const gw = await gateway(config, catalog, events);
  process.env.K = 'k1';
  process.env.K2 = 'k2';
  try {
    const resp = await call(gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.choices[0].message.content, 'net-ok');
    const fb = events.list({ type: 'fallback' });
    assert.equal(fb.length, 1);
    assert.equal(fb[0].reason, 'network');
  } finally {
    delete process.env.K;
    delete process.env.K2;
    backup.server.close();
    gw.server.close();
  }
});

test('auth: no/invalid key → 401; unknown model → 503; unknown route → 404', async () => {
  const t = await setup({
    primaryHandler: () => {},
    backupHandler: () => {},
  });
  process.env.TEST_PRIMARY_KEY = 'k1';
  process.env.TEST_BACKUP_KEY = 'k2';
  try {
    assert.equal((await call(t.gw.url, '/v1/models', { key: null })).status, 401);
    assert.equal((await call(t.gw.url, '/v1/models', { key: 'wrong' })).status, 401);
    const r503 = await call(t.gw.url, '/v1/chat/completions', {
      method: 'POST',
      body: { model: 'nope', messages: [] },
    });
    assert.equal(r503.status, 503);
    const r404 = await call(t.gw.url, '/v1/embeddings');
    assert.equal(r404.status, 404);
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('/v1/models: claude 展示位模型 display-only，同名不覆盖路由目录', async () => {
  const events = new EventLog(100);
  const primary = await mockUpstream(() => {});
  const catalog = {
    providers: [{
      id: 'primary',
      type: 'openai',
      baseUrl: `http://127.0.0.1:${primary.port}/v1/chat/completions`,
      apiKeyRef: 'env:TEST_PRIMARY_KEY',
      models: ['m1', 'claude-opus-5-5'], // 同名：路由目录优先
    }],
  };
  const config = {
    gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] },
    claude: { enabled: true, models: ['claude-opus-5-5', 'claude-haiku-5-5'] },
  };
  const gw = await gateway(config, catalog, events);
  try {
    const resp = await call(gw.url, '/v1/models');
    assert.equal(resp.status, 200);
    const json = await resp.json();
    const byId = Object.fromEntries(json.data.map((m) => [m.id, m]));
    // 同名：保留路由目录归属，不变成 display-only
    assert.deepEqual(byId['claude-opus-5-5'].providers, ['primary']);
    assert.equal(byId['claude-opus-5-5'].routable, true);
    // 展示位：claude 归属 + routable: false + owned_by 标记订阅来源
    assert.deepEqual(byId['claude-haiku-5-5'].providers, ['claude']);
    assert.equal(byId['claude-haiku-5-5'].routable, false);
    assert.equal(byId['claude-haiku-5-5'].owned_by, 'claude-subscription');
    // 路由模型 routable: true
    assert.equal(byId.m1.routable, true);
  } finally {
    primary.server.close();
    gw.server.close();
  }
});

test('GET /v1/models: catalog listing with provider attribution', async () => {
  const t = await setup({
    primaryHandler: () => {},
    backupHandler: () => {},
  });
  try {
    const resp = await call(t.gw.url, '/v1/models');
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.object, 'list');
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].id, 'm1');
    assert.deepEqual(json.data[0].providers, ['primary', 'backup']);
  } finally {
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('POST /v1/messages without native provider → 400 invalid_request_error (format conversion removed)', async () => {
  let hit = 0;
  const t = await setup({ primaryHandler: () => { hit++; }, backupHandler: () => { hit++; } });
  process.env.TEST_PRIMARY_KEY = 'k1';
  process.env.TEST_BACKUP_KEY = 'k2';
  try {
    for (const stream of [false, true]) {
      const resp = await call(t.gw.url, '/v1/messages', {
        method: 'POST',
        body: { model: 'm1', max_tokens: 10, stream, messages: [{ role: 'user', content: 'x' }] },
      });
      assert.equal(resp.status, 400);
      const json = await resp.json();
      assert.equal(json.type, 'error');
      assert.equal(json.error.type, 'invalid_request_error');
      assert.match(json.error.message, /no native Anthropic provider/);
    }
    const missing = await call(t.gw.url, '/v1/messages', { method: 'POST', body: { messages: [] } });
    assert.equal(missing.status, 400);
    assert.equal(hit, 0, '不触达上游');
  } finally {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    t.primary.server.close();
    t.backup.server.close();
    t.gw.server.close();
  }
});

test('image chain maps GLM flash → backup flash → DeepSeek flash; real success controls highlight, errors do not', async () => {
  const seen = [];
  let statuses = [429, 503, 200];
  const upstreams = await Promise.all([0, 1, 2].map((i) => mockUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ i, body });
      res.writeHead(statuses[i], { 'content-type': 'application/json' });
      res.end(statuses[i] === 200 ? JSON.stringify({ model: body.model, choices: [{ message: { content: 'ok' } }] }) : '{}');
    });
  })));
  const providers = upstreams.map((s, i) => ({
    id: ['glm-primary', 'glm-backup', 'deepseek'][i],
    displayName: ['智谱 1', '智谱 2', 'DeepSeek'][i],
    type: i === 2 ? 'openai' : 'glm',
    models: i === 2 ? ['deepseek-flash'] : ['glm-5.3-flash'],
    modelDefs: i === 2 ? { 'deepseek-flash': ['text', 'image'] } : { 'glm-5.3-flash': ['text', 'image'] },
    ...(i === 2 ? { fallbackModelMap: { 'glm-5.3-flash': 'deepseek-flash' } } : {}),
    baseUrl: `http://127.0.0.1:${s.port}/v1/chat/completions`, apiKeyRef: 'env:IMAGE_TEST_KEY',
  }));
  const events = new EventLog(50);
  const quota = { current: {}, snapshot() { return this.current; } };
  const handler = createRequestHandler({
    config: { gateway: { keys: ['gw-test-key'] } }, catalog: { providers }, events, quotaStore: quota,
  });
  const gw = await new Promise((resolve) => {
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  process.env.IMAGE_TEST_KEY = 'dummy';
  const content = [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } }];
  const body = { model: 'glm-5.3-flash', messages: [{ role: 'user', content }], stream: false, temperature: 0.4 };
  const dash = async () => (await (await fetch(gw.url + '/internal/dashboard')).json()).providers[0].models[0];
  const send = () => call(gw.url, '/v1/chat/completions', { method: 'POST', body });
  try {
    assert.equal((await dash()).active, null);
    assert.equal((await dash()).expected, 'glm-primary');
    const ds = await send();
    assert.equal(ds.status, 200);
    assert.equal((await ds.json()).model, 'deepseek-flash');
    assert.deepEqual(seen.map((s) => s.body.model), ['glm-5.3-flash', 'glm-5.3-flash', 'deepseek-flash']);
    for (const s of seen) {
      assert.deepEqual(s.body.messages[0].content, content);
      assert.equal(s.body.temperature, 0.4);
    }
    let model = await dash();
    assert.deepEqual(model.fallbacks.map((f) => f.model), ['glm-5.3-flash', 'deepseek-flash']);
    assert.equal(model.active.providerId, 'deepseek');
    assert.equal(model.active.model, 'deepseek-flash');
    assert.ok(model.active.at);
    assert.deepEqual((await (await fetch(gw.url + '/internal/dashboard')).json()).providers[2].models.map((m) => m.id), ['deepseek-flash']);

    statuses = [429, 200, 200];
    seen.length = 0;
    assert.equal((await send()).status, 200);
    assert.deepEqual(seen.map((s) => s.i), [0, 1]);
    assert.equal((await dash()).active.providerId, 'glm-backup');
    statuses = [400, 200, 200];
    seen.length = 0;
    assert.equal((await send()).status, 400); // non-retriable client error never reaches backup
    assert.deepEqual(seen.map((s) => s.i), [0]);
    assert.equal((await dash()).active.providerId, 'glm-backup');
    statuses = [200, 200, 200];
    seen.length = 0;
    assert.equal((await send()).status, 200);
    assert.equal((await dash()).active.providerId, 'glm-primary');
    // Quota demotion changes expected priority; no request means actual remains primary.
    quota.current = { 'glm-primary': { ok: true, stale: false, tiers: { fiveHour: { usedPercent: 96 } } } };
    model = await dash();
    assert.equal(model.expected, 'glm-backup');
    assert.equal(model.active.providerId, 'glm-primary');
    seen.length = 0;
    assert.equal((await send()).status, 200);
    assert.deepEqual(seen.map((s) => s.i), [1]);
    assert.equal((await dash()).active.providerId, 'glm-backup');
    assert.equal(events.list({ type: 'fallback' }).length, 3);
  } finally {
    delete process.env.IMAGE_TEST_KEY;
    gw.server.close();
    for (const s of upstreams) s.server.close();
  }
});

test('mapped image SSE stays streaming and records actual node only after stream completes', async () => {
  const primary = await mockUpstream((req, res) => { res.writeHead(429); res.end('{}'); });
  const seen = [];
  const upstream = await mockUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"part":1}\n\n');
      setTimeout(() => res.end('data: [DONE]\n\n'), 30);
    });
  });
  const events = new EventLog();
  const handler = createRequestHandler({
    config: { gateway: { keys: ['gw-test-key'] } }, events,
    catalog: { providers: [
      { id: 'glm', type: 'glm', models: ['glm-5.3-flash'], apiKeyRef: 'env:NO_KEY', baseUrl: `http://127.0.0.1:${primary.port}/chat/completions` },
      { id: 'ds', type: 'openai', models: ['deepseek-flash'], fallbackModelMap: { 'glm-5.3-flash': 'deepseek-flash' },
        apiKeyRef: 'env:IMAGE_TEST_KEY', baseUrl: `http://127.0.0.1:${upstream.port}/chat/completions` },
    ] },
  });
  const gw = await new Promise((resolve) => {
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  process.env.IMAGE_TEST_KEY = 'dummy';
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  try {
    // Set an actual key so the first provider returns 429 rather than an auth failure.
    process.env.NO_KEY = 'dummy';
    const res = await call(gw.url, '/v1/chat/completions', { method: 'POST', body: {
      model: 'glm-5.3-flash', stream: true, messages: [{ role: 'user', content: [image] }],
    } });
    // Primary 429 advances to DeepSeek, retaining the stream.
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-gateway-provider'), 'ds');
    assert.equal(await res.text(), 'data: {"part":1}\n\ndata: [DONE]\n\n');
    assert.equal(seen[0].model, 'deepseek-flash');
    assert.deepEqual(seen[0].messages[0].content, [image]);
    const dashboard = await (await fetch(gw.url + '/internal/dashboard')).json();
    assert.equal(dashboard.providers[0].models[0].active.providerId, 'ds');
    assert.equal(dashboard.providers[0].models[0].active.model, 'deepseek-flash');
  } finally {
    delete process.env.IMAGE_TEST_KEY;
    delete process.env.NO_KEY;
    gw.server.close(); upstream.server.close(); primary.server.close();
  }
});

test('internal endpoints: quota snapshot + events listing', async () => {
  const events = new EventLog(10);
  events.record('fallback', { from: 'a', to: 'b', reason: 'rate_limited', model: 'm' });
  const gw = await gateway(
    { gateway: { keys: ['gw-test-key'] } },
    { providers: [] },
    events,
  );
  // inject a quota store
  try {
    const resp = await fetch(gw.url + '/internal/events?type=fallback');
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.events.length, 1);
    assert.equal(json.events[0].from, 'a');
  } finally {
    gw.server.close();
  }
});

test('codex chat path applies fallbackModelMap rewrite (legacy alias served by mapped model)', async () => {
  // 2026-10-01 生产止血：gpt-6-sol 被 ChatGPT 账号拒收，legacy pin（pi/openclaw）
  // 经映射改写至 gpt-6-luna 再进 codex 运行时；未映射模型原样透传
  const captured = [];
  const codexRuntime = {
    healthy: () => true,
    status: () => ({ id: 'codex' }),
    chatCompletions: async (body) => {
      captured.push(body.model);
      return { model: body.model, choices: [{ message: { content: 'ok' } }] };
    },
  };
  const providers = [{
    id: 'codex', displayName: 'OpenAI', type: 'codex',
    models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
    fallbackModelMap: { 'gpt-6-sol': 'gpt-6-luna' },
  }];
  const events = new EventLog(50);
  const handler = createRequestHandler({
    config: { gateway: { keys: ['gw-test-key'] } },
    catalog: { providers }, events,
    quotaStore: { snapshot: () => ({}) },
    registry: { get: () => codexRuntime, snapshot: () => ({}) },
  });
  const gw = await new Promise((resolve) => {
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  try {
    const alias = await call(gw.url, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(alias.status, 200);
    const direct = await call(gw.url, '/v1/chat/completions', {
      method: 'POST', body: { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(direct.status, 200);
    assert.deepEqual(captured, ['gpt-6-luna', 'gpt-6.1-sol'], 'legacy alias rewritten; unmapped model passed through');
  } finally {
    gw.server.close();
  }
});

function nativeProviders(primaryPort, backupPort) {
  return [
    {
      id: 'primary',
      type: 'glm',
      baseUrl: `http://127.0.0.1:${primaryPort}/v1/chat/completions`,
      anthropicBaseUrl: `http://127.0.0.1:${primaryPort}/api/anthropic`,
      apiKeyRef: 'env:TEST_PRIMARY_KEY',
      models: ['glm-5.3'],
    },
    {
      id: 'backup',
      type: 'glm',
      baseUrl: `http://127.0.0.1:${backupPort}/v1/chat/completions`,
      anthropicBaseUrl: `http://127.0.0.1:${backupPort}/api/anthropic`,
      apiKeyRef: 'env:TEST_BACKUP_KEY',
      models: ['glm-5.3'],
    },
  ];
}

async function setupNative({ primaryHandler, backupHandler }) {
  const events = new EventLog(100);
  const primary = await mockUpstream(primaryHandler);
  const backup = await mockUpstream(backupHandler);
  const catalog = { providers: nativeProviders(primary.port, backup.port) };
  const config = { gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] } };
  const gw = await gateway(config, catalog, events);
  process.env.TEST_PRIMARY_KEY = 'k1';
  process.env.TEST_BACKUP_KEY = 'k2';
  const close = () => {
    delete process.env.TEST_PRIMARY_KEY;
    delete process.env.TEST_BACKUP_KEY;
    primary.server.close();
    backup.server.close();
    gw.server.close();
  };
  return { events, gw, close };
}

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"Read","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/a\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

test('POST /v1/messages native passthrough: SSE + tool_use verbatim, body/headers forwarded', async () => {
  let seen = null;
  const t = await setupNative({
    primaryHandler: (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of ANTHROPIC_SSE) res.write(chunk);
        res.end();
      });
    },
    backupHandler: () => {},
  });
  try {
    const reqBody = {
      model: 'glm-5.3',
      max_tokens: 1000,
      stream: true,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const resp = await fetch(t.gw.url + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'gw-test-key',
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify(reqBody),
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type'), /text\/event-stream/);
    assert.equal(resp.headers.get('x-gateway-provider'), 'primary');
    assert.equal(await resp.text(), ANTHROPIC_SSE.join(''));
    assert.equal(seen.url, '/api/anthropic/v1/messages');
    assert.deepEqual(seen.body, reqBody);
    assert.equal(seen.headers['x-api-key'], 'k1');
    assert.equal(seen.headers.authorization, 'Bearer k1');
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.equal(seen.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  } finally {
    t.close();
  }
});

test('POST /v1/messages native passthrough: primary 429 → backup (before first byte)', async () => {
  const t = await setupNative({
    primaryHandler: (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
      });
    },
    backupHandler: (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } }));
      });
    },
  });
  try {
    const resp = await call(t.gw.url, '/v1/messages', {
      method: 'POST',
      body: { model: 'glm-5.3', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(resp.status, 200);
    const json = await resp.json();
    assert.equal(json.content[0].text, 'ok');
    assert.ok(t.events.list({}).some((e) => e.type === 'fallback'));
  } finally {
    t.close();
  }
});

test('POST /v1/messages/count_tokens: native passthrough; 404 without native provider', async () => {
  let seenUrl = null;
  const t = await setupNative({
    primaryHandler: (req, res) => {
      seenUrl = req.url;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 17 }));
      });
    },
    backupHandler: () => {},
  });
  try {
    const ok = await call(t.gw.url, '/v1/messages/count_tokens', {
      method: 'POST',
      body: { model: 'glm-5.3', messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { input_tokens: 17 });
    assert.equal(seenUrl, '/api/anthropic/v1/messages/count_tokens');
    const missing = await call(t.gw.url, '/v1/messages/count_tokens', {
      method: 'POST',
      body: { model: 'no-such-model', messages: [] },
    });
    assert.equal(missing.status, 404);
  } finally {
    t.close();
  }
});
