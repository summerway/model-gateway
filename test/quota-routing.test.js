// quota-routing.test.js — quota-aware chain ordering + transition events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChain, orderChainByQuota, recordQuotaTransitions, createRequestHandler } from '../src/gateway/router.js';
import { EventLog } from '../src/events.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROVIDERS = [
  { id: 'glm-primary', type: 'glm', models: ['glm-5.3'] },
  { id: 'glm-backup', type: 'glm', models: ['glm-5.3'] },
  { id: 'deepseek', type: 'openai', models: ['glm-5.3'] },
];
const CATALOG = { providers: PROVIDERS };

function snap(primaryPct, backupPct = 10) {
  return {
    'glm-primary': { ok: true, stale: false, tiers: { fiveHour: { usedPercent: primaryPct } } },
    'glm-backup': { ok: true, stale: false, tiers: { fiveHour: { usedPercent: backupPct } } },
  };
}

test('orderChainByQuota: exhausted glm provider demoted to tail, order kept otherwise', () => {
  const chain = buildChain(CATALOG, 'glm-5.3');
  assert.deepEqual(chain.map((p) => p.id), ['glm-primary', 'glm-backup', 'deepseek']);

  const ordered = orderChainByQuota(chain, snap(100));
  assert.deepEqual(ordered.map((p) => p.id), ['glm-backup', 'deepseek', 'glm-primary']);
});

test('orderChainByQuota: below threshold / stale / probe-failed → unchanged', () => {
  const chain = buildChain(CATALOG, 'glm-5.3');
  assert.deepEqual(orderChainByQuota(chain, snap(94)).map((p) => p.id), ['glm-primary', 'glm-backup', 'deepseek']);

  const stale = snap(100);
  stale['glm-primary'].stale = true;
  assert.deepEqual(orderChainByQuota(chain, stale).map((p) => p.id), ['glm-primary', 'glm-backup', 'deepseek']);

  const failed = snap(100);
  failed['glm-primary'] = { ok: false, tiers: null };
  assert.deepEqual(orderChainByQuota(chain, failed).map((p) => p.id), ['glm-primary', 'glm-backup', 'deepseek']);
});

test('orderChainByQuota: both exhausted keeps relative order', () => {
  const ordered = orderChainByQuota(buildChain(CATALOG, 'glm-5.3'), snap(100, 100));
  assert.deepEqual(ordered.map((p) => p.id), ['deepseek', 'glm-primary', 'glm-backup']);
});

test('recordQuotaTransitions: one demote event per episode, restore on recovery', () => {
  const events = new EventLog(50);
  const state = new Map();

  recordQuotaTransitions({ providers: PROVIDERS, quotaSnap: snap(100), state, events });
  recordQuotaTransitions({ providers: PROVIDERS, quotaSnap: snap(100), state, events }); // same episode, no dup
  let evs = events.list({ limit: 50 });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'quota_demoted');
  assert.equal(evs[0].providerId, 'glm-primary');

  recordQuotaTransitions({ providers: PROVIDERS, quotaSnap: snap(40), state, events }); // window reset
  evs = events.list({ limit: 50 });
  assert.equal(evs.length, 2);
  assert.equal(evs[0].type, 'quota_restored'); // newest first
  assert.equal(evs[1].type, 'quota_demoted');
});

test('orderChainByQuota: exhausted codex provider demoted to tail; glm parity guards', () => {
  const chain = [
    { id: 'codex', type: 'codex', models: ['gpt-6-luna'] },
    { id: 'glm-primary', type: 'glm', models: ['glm-5.3'] },
  ];
  const codexSnap = (pct, stale = false) => ({
    codex: { ok: true, stale, tiers: { fiveHour: { usedPercent: pct } } },
  });

  // ≥95% → codex 挪到链尾，提前让位
  assert.deepEqual(
    orderChainByQuota(chain, codexSnap(98)).map((p) => p.id),
    ['glm-primary', 'codex'],
  );
  // 阈值以下 / 数据过期 / 探测失败 → 不动
  assert.deepEqual(orderChainByQuota(chain, codexSnap(94)).map((p) => p.id), ['codex', 'glm-primary']);
  assert.deepEqual(orderChainByQuota(chain, codexSnap(98, true)).map((p) => p.id), ['codex', 'glm-primary']);
  assert.deepEqual(orderChainByQuota(chain, {}).map((p) => p.id), ['codex', 'glm-primary']);
  // openai 类型永不参与（防误伤 deepseek 等无窗口渠道）
  const dsSnap = { deepseek: { ok: true, stale: false, tiers: { fiveHour: { usedPercent: 99 } } } };
  assert.deepEqual(
    orderChainByQuota([{ id: 'deepseek', type: 'openai' }], dsSnap).map((p) => p.id),
    ['deepseek'],
  );
});

test('recordQuotaTransitions: codex demote/restore events fire like glm', () => {
  const events = new EventLog(20);
  const state = new Map();
  const providers = [{ id: 'codex', type: 'codex' }];
  const snap = (pct) => ({ codex: { ok: true, stale: false, tiers: { fiveHour: { usedPercent: pct } } } });

  recordQuotaTransitions({ providers, quotaSnap: snap(97), state, events });
  recordQuotaTransitions({ providers, quotaSnap: snap(98), state, events }); // 同一回合不重复
  let evs = events.list({ limit: 20 });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'quota_demoted');
  assert.equal(evs[0].providerId, 'codex');

  recordQuotaTransitions({ providers, quotaSnap: snap(10), state, events }); // 窗口重置
  evs = events.list({ limit: 20 });
  assert.equal(evs.length, 2);
  assert.equal(evs[0].type, 'quota_restored');
});

test('router: /v1 request records quota_demoted event and routes via backup first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgw-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  const cfgYaml = `
gateway:
  keys:
    - env:MGW_TEST_KEY
providers:
  - id: glm-primary
    type: glm
    baseUrl: https://open.bigmodel.cn/api/paas/v4/chat/completions
    apiKeyRef: env:MGW_TEST_KEY
    models:
      - glm-5.3
  - id: glm-backup
    type: glm
    baseUrl: https://open.bigmodel.cn/api/paas/v4/chat/completions
    apiKeyRef: env:MGW_TEST_KEY
    models:
      - glm-5.3
jobs:
  activate:
    enabled: false
`;
  writeFileSync(join(dir, 'config', 'config.yaml'), cfgYaml);
  const config = loadConfig(join(dir, 'config'));
  const catalog = { providers: config.providers };

  const events = new EventLog(50);
  const quotaStore = { snapshot: () => snap(100) };

  const calls = [];
  // Fake upstream: assert the first attempted provider is glm-backup.
  const fakeFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: 'glm-5.3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.MGW_TEST_KEY = 'sk-test';

  const handler = createRequestHandler({ config, catalog, events, quotaStore, fetch: fakeFetch });
  const req = {
    method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on: (ev, fn) => {
      if (ev === 'data') setImmediate(() => fn(Buffer.from(JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }))));
      if (ev === 'end') setImmediate(fn);
    },
  };
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs ?? {}; },
    write(x) { this.body += x; }, end(x) { if (x) this.body += x; },
  };
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).choices[0].message.content, 'OK');
  const evs = events.list({ limit: 50 });
  assert.ok(evs.some((e) => e.type === 'quota_demoted' && e.providerId === 'glm-primary'));
});
