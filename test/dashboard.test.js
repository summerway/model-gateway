// dashboard.test.js — GET / (page) + GET /internal/dashboard aggregate + config
// normalization feeding the dashboard (displayName / badge / modalities object form).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../src/gateway/router.js';
import { buildDashboardData } from '../src/ops/dashboard-data.js';
import { EventLog } from '../src/events.js';
import { validateConfig } from '../src/config.js';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import { parseYaml } from '../src/yaml.js';
import { readFileSync } from 'node:fs';
import { runInNewContext as runVm } from 'node:vm';
function runInNewContext(script, sandbox = {}) { return runVm(script, { URL, URLSearchParams, AbortController, setTimeout, clearTimeout, ...sandbox }); }

// 页面 <head> 另有主题 bootstrap <script>（issue #1）；主脚本块以 'use strict' 开头。

function startGateway({ config, catalog, events, quotaStore, registry } = {}) {
  const handler = createRequestHandler({
    config: config ?? { gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] } },
    catalog,
    events,
    quotaStore,
    registry,
  });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function fixtureCatalog() {
  return {
    providers: [
      {
        id: 'glm-primary',
        displayName: '智谱 1',
        type: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        apiKeyRef: 'env:GLM_KEY',
        badge: 'Coding Plan · Max',
        models: ['glm-5.3', 'glm-5.3-flash'],
        modelDefs: { 'glm-5.3': ['text'], 'glm-5.3-flash': ['text', 'image'] },
      },
      {
        id: 'glm-backup',
        displayName: '智谱 2',
        type: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        apiKeyRef: 'env:GLM_BACKUP_KEY',
        models: ['glm-5.3', 'glm-5.3-flash'],
        modelDefs: { 'glm-5.3-flash': ['text', 'image'] },
      },
      {
        id: 'deepseek',
        displayName: 'DeepSeek',
        type: 'openai',
        baseUrl: 'https://api.deepseek.com/v1/chat/completions',
        apiKeyRef: 'env:DS_KEY',
        models: ['deepseek-flash', 'deepseek-v4-pro'],
        fallbackModelMap: { 'glm-5.3-flash': 'deepseek-flash' },
      },
      {
        id: 'codex',
        displayName: 'OpenAI',
        type: 'codex',
        models: ['gpt-6-sol'],
      },
    ],
  };
}

function fixtureQuota() {
  const resetMs = Date.now() + 90 * 60 * 1000;
  return {
    snapshot: () => ({
      'glm-primary': {
        ok: true, stale: false, level: 'MAX',
        tiers: {
          fiveHour: { usedPercent: 96, resetsAt: new Date(resetMs).toISOString(), resetMs },
          weekly: { usedPercent: 41, resetsAt: new Date(resetMs + 3 * 86400000).toISOString(), resetMs: resetMs + 3 * 86400000 },
        },
        fetchedAt: new Date().toISOString(),
      },
      'glm-backup': { ok: false, stale: false, tiers: null },
      deepseek: {
        ok: true, stale: false, tiers: null,
        isAvailable: true,
        balance: { currency: 'CNY', total: '46.20', granted: '30.00', toppedUp: '16.20' },
        fetchedAt: new Date().toISOString(),
      },
    }),
  };
}

const FIXTURE_REGISTRY = {
  get: () => null,
  snapshot: () => ({ codex: { healthy: false, reason: 'no credentials loaded' } }),
};


test('GET / serves the console page (v0.5 起默认页)；/console 与 /dashboard 301 → /', async () => {
  const gw = await startGateway({ catalog: fixtureCatalog(), events: new EventLog(50) });
  try {
    const resp = await fetch(gw.url + '/');
    assert.equal(resp.status, 200);
    assert.ok(resp.headers.get('content-type').startsWith('text/html'));
    const html = await resp.text();
    // 新版控制台标记：布局骨架 + 数据源 + 自动刷新 + 拓扑卡 + 密钥视图（旧 /keys 页并入）
    for (const needle of ['id="auto-btn"', 'id="live-tag"', '/internal/dashboard', '/internal/usage', '链路拓扑', 'topologyHtml', 'gateway-keys']) {
      assert.ok(html.includes(needle), `page must reference ${needle}`);
    }
    // 旧路径永久重定向（书签/外链平滑过渡）
    for (const path of ['/console', '/dashboard']) {
      const r = await fetch(gw.url + path, { redirect: 'manual' });
      assert.equal(r.status, 301, `${path} 应 301`);
      assert.equal(r.headers.get('location'), '/');
    }
    // 跟随重定向后拿到的是同一个控制台页
    const follow = await fetch(gw.url + '/console');
    assert.equal(follow.status, 200);
    assert.ok((await follow.text()).includes('id="auto-btn"'));
  } finally {
    gw.server.close();
  }
});

// MG24：旧独立页 /usage、/keys、/inbox 已删除（301 → 看板对应视图），其 DOM 用例一并移除；
// Agent 端点分组与脱敏聚合的服务端口径由 test/agent-endpoints.test.js 覆盖。

test('example keys: 只用通用示例 app', () => {
  const raw = readFileSync(new URL('../config/config.example.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /pi-agent|mac-pi|skills-evolve|night-duty|kb-service|karakeep|poker/);
  assert.match(raw, /app: my-app$/m);
});

test('GET /favicon.png serves the project icon (image/png, PNG magic, page references it)', async () => {
  const gw = await startGateway({ catalog: fixtureCatalog(), events: new EventLog(50) });
  try {
    const resp = await fetch(gw.url + '/favicon.png');
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString('hex'), '89504e47', 'PNG magic bytes');
    assert.ok(buf.length > 1000, 'favicon should be a real image');
    const html = await (await fetch(gw.url + '/')).text();
    assert.ok(html.includes('rel="icon"'), 'dashboard page must reference the favicon');
  } finally {
    gw.server.close();
  }
});

test('GET /internal/dashboard: providers structure (display/badge/health/models/fallbacks/quota)', async () => {
  const events = new EventLog(50);
  events.record('fallback', { from: 'glm-primary', to: 'glm-backup', reason: 'rate_limited', model: 'glm-5.3', durationMs: 120 });
  events.record('request_error', { path: '/v1/chat/completions', model: 'glm-5.3', status: 502, kind: 'server_error', error: 'boom' });
  const gw = await startGateway({
    catalog: fixtureCatalog(),
    events,
    quotaStore: fixtureQuota(),
    registry: FIXTURE_REGISTRY,
  });
  try {
    const resp = await fetch(gw.url + '/internal/dashboard');
    assert.equal(resp.status, 200);
    const data = await resp.json();

    // ── providers ──
    assert.equal(data.providers.length, 4);
    const glm1 = data.providers[0];
    assert.equal(glm1.id, 'glm-primary');
    assert.equal(glm1.displayName, '智谱 1');
    assert.equal(glm1.badge, 'Coding Plan · Max');
    assert.equal(glm1.type, 'glm');
    assert.equal(glm1.healthy, true);

    // quota: fiveHour + weekly shape
    assert.equal(glm1.quota.fiveHour.usedPercent, 96);
    assert.ok(glm1.quota.fiveHour.resetsAt);
    assert.equal(glm1.quota.weekly.usedPercent, 41);
    assert.equal(glm1.quota.level, 'MAX');

    // models: modalities from modelDefs, fallback chain expansion (厂商·模型 对)
    const m0 = glm1.models.find((m) => m.id === 'glm-5.3');
    assert.deepEqual(m0.modalities, ['text']);
    assert.equal(m0.chainIndex, 0);
    assert.deepEqual(m0.fallbacks, [
      { providerId: 'glm-backup', provider: '智谱 2', model: 'glm-5.3' },
    ]);
    const m1 = glm1.models.find((m) => m.id === 'glm-5.3-flash');
    assert.deepEqual(m1.modalities, ['text', 'image']);
    assert.deepEqual(m1.fallbacks, [
      { providerId: 'glm-backup', provider: '智谱 2', model: 'glm-5.3-flash' },
      { providerId: 'deepseek', provider: 'DeepSeek', model: 'deepseek-flash' },
    ]);
    assert.equal(m1.active, null);
    assert.equal(m1.expected, 'glm-backup'); // primary 96% quota demoted

    // provider 级 fallbacks：模型链展开去重
    assert.deepEqual(glm1.fallbacks, [
      { providerId: 'glm-backup', provider: '智谱 2', model: 'glm-5.3' },
      { providerId: 'glm-backup', provider: '智谱 2', model: 'glm-5.3-flash' },
      { providerId: 'deepseek', provider: 'DeepSeek', model: 'deepseek-flash' },
    ]);

    // 智谱 2：glm-5.3 链中第 2 级，quota 不可用 → null
    const glm2 = data.providers[1];
    assert.equal(glm2.models[0].chainIndex, 1);
    assert.deepEqual(glm2.models[0].fallbacks, []);
    assert.deepEqual(glm2.models[1].chain.map((node) => [node.providerId, node.model]), [
      ['glm-primary', 'glm-5.3-flash'], ['glm-backup', 'glm-5.3-flash'], ['deepseek', 'deepseek-flash'],
    ]);
    assert.equal(glm2.quota, null);
    assert.equal(glm2.badge, null); // badge 缺省 → null
    assert.equal(glm2.displayName, '智谱 2');

    // deepseek：modalities 缺省 ['text']（无 modelDefs）；余额 quota 透传
    const ds = data.providers[2];
    assert.deepEqual(ds.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
    assert.deepEqual(ds.models.find((m) => m.id === 'deepseek-v4-pro').modalities, ['text']);
    assert.equal(ds.quota.balance.total, '46.20');
    assert.equal(ds.quota.balance.granted, '30.00');
    assert.equal(ds.quota.isAvailable, true);
    assert.ok(ds.quota.fetchedAt);

    // codex：healthy/statusReason 来自 registry snapshot
    const codex = data.providers[3];
    assert.equal(codex.healthy, false);
    assert.equal(codex.statusReason, 'no credentials loaded');

    // ── events：newest first ──
    assert.ok(Array.isArray(data.events));
    assert.equal(data.events.length, 2);
    assert.equal(data.events[0].type, 'request_error');
    assert.equal(data.events[1].type, 'fallback');
  } finally {
    gw.server.close();
  }
});

test('L1 localhost dashboard serves raw audit events while the served page groups the visible rows', async () => {
  const events = new EventLog(50);
  const ts = Date.now();
  for (let i = 4; i >= 0; i--) events.buf.push({
    ts: new Date(ts - i * 9000).toISOString(), type: 'fallback',
    from: 'glm-primary', to: 'glm-backup', reason: 'rate_limited',
    model: 'glm-5.3', status: 429, durationMs: i,
  });
  const gw = await startGateway({ catalog: fixtureCatalog(), events });
  try {
    // v0.5 起 / 服务新版控制台；老首页逻辑（事件分组脚本）从源文件直读断言
    const [dashboard, audit] = await Promise.all([
      fetch(gw.url + '/internal/dashboard'), fetch(gw.url + '/internal/events'),
    ]);
    assert.equal(dashboard.status, 200);
    assert.equal(audit.status, 200);
    const [data, raw] = await Promise.all([dashboard.json(), audit.json()]);
    assert.equal(data.events.length, 5);
    assert.deepEqual(data.events, raw.events);
  } finally {
    gw.server.close();
  }
});

test('dashboard current node requires a recent successful sample still present in the chain', () => {
  const catalog = fixtureCatalog();
  const lastSuccess = new Map([['glm-5.3-flash', {
    providerId: 'deepseek', model: 'deepseek-flash', at: new Date(Date.now() - 11 * 60_000).toISOString(),
  }]]);
  const deps = { catalog, lastSuccess, events: new EventLog(), quotaStore: fixtureQuota() };
  const model = () => buildDashboardData(deps).providers[0].models.find((m) => m.id === 'glm-5.3-flash');
  assert.equal(model().active, null);
  lastSuccess.get('glm-5.3-flash').at = new Date().toISOString();
  assert.equal(model().active.providerId, 'deepseek');
  catalog.providers[2].fallbackModelMap = {};
  assert.equal(model().active, null); // hot reload removed the mapping
});

test('GET /internal/dashboard: 动态分页 — 默认 30，eventsLimit 白名单 10/30/50，白名单外回退', async () => {
  const events = new EventLog(500);
  for (let i = 0; i < 80; i++) events.record('probe_error', { providerId: 'glm-primary', error: `e${i}` });
  const gw = await startGateway({ catalog: fixtureCatalog(), events });
  try {
    const base = gw.url + '/internal/dashboard';
    assert.equal((await (await fetch(base)).json()).events.length, 30);
    assert.equal((await (await fetch(base + '?eventsLimit=10')).json()).events.length, 10);
    assert.equal((await (await fetch(base + '?eventsLimit=50')).json()).events.length, 50);
    assert.equal((await (await fetch(base + '?eventsLimit=999')).json()).events.length, 30); // 白名单外回退默认
    const data = await (await fetch(base + '?eventsLimit=10')).json();
    assert.equal(data.events[0].error, 'e79'); // newest first
  } finally {
    gw.server.close();
  }
});

test('validateConfig: displayName/badge passthrough + models object form → modelDefs', () => {
  const cfg = validateConfig({
    gateway: { keys: ['k'] },
    providers: [
      {
        id: 'p1',
        displayName: '渠道一',
        badge: 'Coding Plan · Max',
        type: 'openai',
        baseUrl: 'https://x.example/v1/chat/completions',
        apiKeyRef: 'env:K',
        models: [
          'plain-model',
          { id: 'rich-model', modalities: ['text', 'image', 'pdf'] },
          { id: 'bare-model' },
        ],
      },
    ],
    jobs: { activate: { model: 'plain-model' } },
  });
  const p = cfg.providers[0];
  assert.equal(p.displayName, '渠道一');
  assert.equal(p.badge, 'Coding Plan · Max');
  assert.deepEqual(p.models, ['plain-model', 'rich-model', 'bare-model']); // strings, chain-building unchanged
  assert.deepEqual(p.modelDefs, {
    'plain-model': ['text'],
    'rich-model': ['text', 'image', 'pdf'],
    'bare-model': ['text'],
  });
});

test('validateConfig: rejects malformed models object entries', () => {
  assert.throws(() => validateConfig({
    gateway: { keys: ['k'] },
    providers: [{
      id: 'p1', type: 'openai', baseUrl: 'https://x.example/v1/chat/completions',
      apiKeyRef: 'env:K', models: [{ modalities: ['text'] }], // missing id
    }],
    jobs: { activate: { model: 'x' } },
  }), /models/);
  assert.throws(() => validateConfig({
    gateway: { keys: ['k'] },
    providers: [{
      id: 'p1', type: 'openai', baseUrl: 'https://x.example/v1/chat/completions',
      apiKeyRef: 'env:K', models: [{ id: 'm', modalities: 'text' }], // modalities not a list
    }],
    jobs: { activate: { model: 'x' } },
  }), /modalities/);
});

test('example YAML block mapping loads with cross-model fallback and own-model catalog', () => {
  const raw = parseYaml(readFileSync(new URL('../config/config.example.yaml', import.meta.url), 'utf8'));
  const cfg = validateConfig(raw);
  assert.deepEqual(cfg.providers.find((p) => p.id === 'deepseek').models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(cfg.providers.find((p) => p.id === 'deepseek').fallbackModelMap,
    { 'glm-5.3-flash': 'deepseek-flash' });
  assert.equal(cfg.providers.find((p) => p.id === 'glm-backup').models.includes('glm-5.3-flash'), true);
  // codex 映射已支持（2026-10-01）：legacy 别名自映射 gpt-6-sol→gpt-6-luna 合法
  raw.providers.find((p) => p.id === 'codex').fallbackModelMap = { 'gpt-6-sol': 'gpt-6-luna' };
  validateConfig(raw);
  // target 仍必须是本 provider owned 模型
  raw.providers.find((p) => p.id === 'codex').fallbackModelMap = { 'gpt-6-sol': 'not-owned' };
  assert.throws(() => validateConfig(raw), /fallbackModelMap/);
  delete raw.providers.find((p) => p.id === 'codex').fallbackModelMap;
  for (const bad of [
    { 'glm-5.3-flash': 'not-owned' }, { 'glm-5.3-flash': 'deepseek-flash', typo: 'deepseek-flash' },
    { 'deepseek-flash': 'glm-5.3-flash' }, // source 自映射已合法，但 target 必须本 provider owned
  ]) {
    raw.providers.find((p) => p.id === 'deepseek').fallbackModelMap = bad;
    assert.throws(() => validateConfig(raw), /fallbackModelMap/);
  }
});

test('GET /internal/dashboard?force=<id>: bypasses cache via quotaStore.refresh, then returns fresh data', async () => {
  const refreshed = [];
  let pct = 96;
  const quotaStore = {
    snapshot: () => ({ 'glm-primary': { ok: true, stale: false, level: 'MAX', tiers: { fiveHour: { usedPercent: pct } }, fetchedAt: new Date().toISOString() } }),
    probeIds: () => ['glm-primary'],
    refresh: async (id) => { refreshed.push(id); pct = 42; return { ok: true }; },
  };
  const gw = await startGateway({ catalog: fixtureCatalog(), events: new EventLog(50), quotaStore });
  try {
    const before = await (await fetch(gw.url + '/internal/dashboard')).json();
    assert.equal(before.providers[0].quota.fiveHour.usedPercent, 96);
    assert.equal(refreshed.length, 0); // no force → cache read only

    const after = await (await fetch(gw.url + '/internal/dashboard?force=glm-primary')).json();
    assert.deepEqual(refreshed, ['glm-primary']); // upstream probe forced
    assert.equal(after.providers[0].quota.fiveHour.usedPercent, 42); // fresh value served
    assert.deepEqual(after.refreshErrors, []);
  } finally {
    gw.server.close();
  }
});

test('forced dashboard: actual QuotaProbe bypasses cache, force all probes eligible only, reports partial failures', async () => {
  const catalog = fixtureCatalog();
  const glm = catalog.providers.filter((p) => p.type === 'glm');
  process.env.GLM_KEY = 'dummy';
  process.env.GLM_BACKUP_KEY = 'dummy';
  let percent = 96;
  const calls = [];
  const events = new EventLog(50);
  const probe = new QuotaProbe({
    providers: glm, events,
    fetch: async (url, opts) => {
      calls.push(url);
      if (opts.headers.Authorization !== 'dummy') throw new Error('missing test key');
      if (calls.length === 4) return new Response('{"success":false,"msg":"quota outage"}', { status: 200 });
      return new Response(JSON.stringify({ success: true, data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: percent, nextResetTime: Date.now() + 3600000 },
      ] } }), { status: 200 });
    },
  });
  const gw = await startGateway({ catalog, events, quotaStore: {
    snapshot: () => probe.snapshot(), probeIds: () => [...probe.state.keys()],
    refresh: (id) => probe.refresh(id, { force: true }),
  } });
  try {
    await probe.refresh('glm-primary');
    const before = await (await fetch(gw.url + '/internal/dashboard')).json();
    assert.equal(before.providers[0].quota.fiveHour.usedPercent, 96);
    assert.equal(calls.length, 1);
    percent = 42;
    const one = await (await fetch(gw.url + '/internal/dashboard?force=glm-primary')).json();
    assert.equal(calls.length, 2);
    assert.equal(one.providers[0].quota.fiveHour.usedPercent, 42);
    assert.deepEqual(one.refreshErrors, []);
    const all = await (await fetch(gw.url + '/internal/dashboard?force=all')).json();
    assert.equal(calls.length, 4); // only 2 GLM providers; DeepSeek/codex not in this probe
    assert.deepEqual(all.refreshErrors.map((e) => e.providerId), ['glm-backup']);
    assert.match(all.refreshErrors[0].error, /额度查询失败/);
    assert.equal(all.providers[0].quota.fiveHour.usedPercent, 42);
    assert.equal((await fetch(gw.url + '/internal/dashboard?force=unknown')).status, 400);
    assert.equal((await fetch(gw.url + '/internal/dashboard?force=')).status, 400);
    const unsupported = await (await fetch(gw.url + '/internal/dashboard?force=codex')).json();
    assert.equal(unsupported.refreshErrors[0].providerId, 'codex');
    assert.equal(calls.length, 4);
  } finally {
    delete process.env.GLM_KEY;
    delete process.env.GLM_BACKUP_KEY;
    gw.server.close();
  }
});

test('dashboard: claude 监控位卡片展开模型明细（无调用链）— 数据层', () => {
  const claude = {
    id: 'claude', type: 'claude', monitor: true,
    displayName: 'Claude', badge: 'Pro',
    models: ['claude-opus-5-5', 'claude-haiku-5-5'],
    modelDefs: {}, visionRouting: {}, fallbackModelMap: {},
  };
  const events = new EventLog(100);
  const data = buildDashboardData({
    catalog: { providers: [...fixtureCatalog().providers, claude] },
    events, quotaStore: fixtureQuota(), registry: FIXTURE_REGISTRY,
    // models.dev 能力源（与定价同源）：opus 收录 pdf，haiku 未收录走缺省
    pricing: { modalitiesFor: (m) => (m === 'claude-opus-5-5' ? ['text', 'image', 'pdf'] : null) },
  });
  const cl = data.providers.find((p) => p.id === 'claude');
  assert.equal(cl.monitor, true);
  assert.deepEqual(cl.models, [
    { id: 'claude-opus-5-5', modalities: ['text', 'image', 'pdf'], monitor: true },
    { id: 'claude-haiku-5-5', modalities: ['text'], monitor: true },
  ]);
  assert.deepEqual(cl.fallbacks, []); // provider 级备用链聚合不受监控位影响
  // 回归：普通 provider 不打 monitor 标，链结构原样
  const glm1 = data.providers.find((p) => p.id === 'glm-primary');
  assert.equal(glm1.monitor, false);
  assert.ok(!('monitor' in glm1.models[0]));
  assert.equal(glm1.models[0].chain.length, 2);
});


test('dashboard: ⚡/🛡 装饰图标与真实配置联动 — 数据层 + 渲染层', () => {
  // ── 数据层：activation 字段随 activator snapshot；features 带 model-guard 配置态 ──
  const deps = () => ({
    catalog: fixtureCatalog(), events: new EventLog(100), quotaStore: fixtureQuota(), registry: FIXTURE_REGISTRY,
  });
  const wired = buildDashboardData({
    ...deps(),
    activator: { snapshot: () => ({
      'glm-primary': { active: true, model: 'glm-5.3-flash' },
      'glm-backup': { active: true, model: 'glm-5.3-flash' },
      claude: { active: false, reason: 'no activation model configured for claude' },
    }) },
    modelGuard: { snapshot: () => ({ enabled: true, dryRun: true }) },
  });
  assert.equal(wired.providers.find((p) => p.id === 'glm-primary').activation.active, true);
  assert.equal(wired.providers.find((p) => p.id === 'deepseek').activation.active, false); // 非激活型 provider 不在 snapshot
  assert.deepEqual(wired.features, { modelGuard: { enabled: true, dryRun: true } });
  // 未注入 → 向后兼容：activation=null、features 缺省
  const bare = buildDashboardData(deps());
  assert.equal(bare.providers[0].activation, null);
  assert.ok(!('features' in bare));

});

// ── 向量端点展示位（dashscope / 阿里百炼）—— claude 监控位同构的 display-only 伪 provider ──

test('dashboard: 向量展示位 — 数据层：monitor 行 + desc 透传 + 自带健康口径', () => {
  const dashscope = {
    id: 'dashscope', type: 'dashscope', monitor: true,
    displayName: '阿里云百炼', badge: 'API按量收费',
    desc: '文本向量 · POST /v1/embeddings',
    healthy: false, statusReason: 'apiKeyRef/workspaceIdRef 解析为空（env 未配置）',
    models: ['text-embedding-v4'], modelDefs: {}, defaultDimensions: 1024,
  };
  const events = new EventLog(100);
  const data = buildDashboardData({
    catalog: { providers: [...fixtureCatalog().providers, dashscope] },
    events, quotaStore: fixtureQuota(), registry: FIXTURE_REGISTRY,
  });
  const ds = data.providers.find((p) => p.id === 'dashscope');
  assert.ok(ds, 'dashscope card present');
  assert.equal(ds.monitor, true);
  assert.equal(ds.healthy, false); // 伪 provider 自带健康优先于缺省 true
  assert.match(ds.statusReason, /解析为空/);
  assert.equal(ds.desc, '文本向量 · POST /v1/embeddings');
  assert.equal(ds.defaultDimensions, 1024); // 维度透传（模型行渲染用）
  assert.deepEqual(ds.models, [{ id: 'text-embedding-v4', modalities: ['text'], monitor: true }]);
  assert.equal(ds.quota, null); // 无额度探测
  assert.deepEqual(ds.fallbacks, []); // 无备用链聚合
  // 回归：真实 provider 不受「自带健康」影响（仍以 registry 快照为准）
  const codex = data.providers.find((p) => p.id === 'codex');
  assert.equal(codex.healthy, false);
  assert.equal(codex.statusReason, 'no credentials loaded');
});

test('GET /internal/dashboard: config.embeddings 注入向量展示位（凭据健康随 env 实时联动）', async () => {
  process.env.EMB_KEY = 'sk-test';
  process.env.EMB_WS = 'ws-test';
  const gw = await startGateway({
    config: {
      gateway: { host: '127.0.0.1', port: 0, keys: ['gw-test-key'] },
      embeddings: {
        type: 'dashscope', apiKeyRef: 'env:EMB_KEY', workspaceIdRef: 'env:EMB_WS',
        region: 'cn-beijing', models: ['text-embedding-v4'], defaultDimensions: 1024,
      },
    },
    catalog: { providers: [] },
    events: new EventLog(100),
  });
  try {
    const data = await (await fetch(gw.url + '/internal/dashboard')).json();
    const ds = data.providers.find((p) => p.id === 'dashscope');
    assert.ok(ds, 'embeddings card injected');
    assert.equal(ds.displayName, '阿里云百炼');
    assert.equal(ds.healthy, true);
    assert.equal(ds.statusReason, null);
    assert.match(ds.desc, /\/v1\/embeddings/);
    assert.doesNotMatch(ds.desc, /维/); // 维度已移至模型行
    assert.equal(ds.defaultDimensions, 1024);
    assert.deepEqual(ds.models, [{ id: 'text-embedding-v4', modalities: ['text'], monitor: true }]);

    // 凭据摘除 → 同一进程内下次聚合即显式异常（不等首个请求 500）
    delete process.env.EMB_KEY;
    const data2 = await (await fetch(gw.url + '/internal/dashboard')).json();
    const ds2 = data2.providers.find((p) => p.id === 'dashscope');
    assert.equal(ds2.healthy, false);
    assert.match(ds2.statusReason, /apiKeyRef/);

    // 未配置 embeddings 的网关：零卡片（回归）
    delete process.env.EMB_WS;
  } finally {
    delete process.env.EMB_KEY;
    delete process.env.EMB_WS;
    gw.server.close();
  }
});

test('dashboard: 套餐标签 plan 归一化 — 档位优先、badge 取「·」末段、按量类透传', () => {
  const providers = [
    { id: 'glm-primary', type: 'glm', badge: 'Coding Plan · Lite', models: [], modelDefs: {} },
    { id: 'glm-backup', type: 'glm', badge: 'Coding Plan · Pro', models: [], modelDefs: {} },
    { id: 'codex', type: 'codex', badge: 'ChatGPT 订阅', models: [], modelDefs: {} },
    { id: 'deepseek', type: 'openai', badge: 'API 按量付费', models: [], modelDefs: {} },
    { id: 'nobadge', type: 'openai', models: [], modelDefs: {} },
  ];
  const data = buildDashboardData({
    catalog: { providers },
    events: new EventLog(10),
    quotaStore: {
      snapshot: () => ({
        'glm-primary': { ok: true, tiers: { fiveHour: {} }, level: 'lite' },
        'codex': { ok: true, tiers: { fiveHour: {} }, level: 'plus' },
        'deepseek': { ok: true, balance: { total: '1.00' } },
      }),
      probeIds: () => [],
    },
    registry: FIXTURE_REGISTRY,
  });
  const plan = Object.fromEntries(data.providers.map((p) => [p.id, p.plan]));
  assert.deepEqual(plan, {
    'glm-primary': 'Lite',      // 档位优先（探测到 level）
    'glm-backup': 'Pro',        // 无 quota → badge「·」末段
    'codex': 'Plus',            // 档位优先，不带 ChatGPT 前缀
    'deepseek': 'API 按量付费', // 无「·」原样透传
    'nobadge': null,
  });
});

test('quota card: 熔断/恢复试探/认证异常态不清空额度主体（进度条与重置时间保留）', () => {
  const html = readFileSync(new URL('../src/dashboard/console.html', import.meta.url), 'utf8');
  const block = html.split('<script>').slice(1).map(s => s.split('</script>')[0]).find(s => s.includes('quotaCard'));
  assert.ok(block, 'console main script block not found');
  const defs = block.slice(0, block.indexOf("document.addEventListener('change'")); // 事件绑定段有 DOM 副作用，截掉
  const { quotaCard } = runInNewContext(defs + '\nS = { features: {} };\n({ quotaCard })', { matchMedia: () => ({ matches: false }), document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => ({ innerHTML: '' }), addEventListener() {}, documentElement: { classList: { toggle() {} } } } });
  const soon = new Date(Date.now() + 5 * 3600e3).toISOString();
  const tiers = { fiveHour: { usedPercent: 100, resetsAt: soon }, weekly: { usedPercent: 42, resetsAt: soon } };
  const base = { id: 'glm-primary', name: '智谱1', type: 'glm', badge: 'Coding Plan · Lite', probe: { supported: true }, quota: { ...tiers, fetchedAt: new Date().toISOString() } };
  // 2026-10-31 智谱 5h 窗口耗尽事故：half_open/open 期间额度主体被清空，只剩状态芯片。
  // 修复后：主体（额度数据维度）与芯片（状态维度）解耦，等待窗口重置时进度条/重置时间仍在。
  for (const [phase, chipText] of [['half_open', '恢复试探'], ['open', '熔断冷却']]) {
    const out = quotaCard({ ...base, circuit: { phase } });
    assert.match(out, new RegExp(chipText), `${phase} chip`);
    assert.match(out, /5 小时额度/, `${phase} keeps five-hour meter`);
    assert.match(out, /本周额度/, `${phase} keeps weekly meter`);
    assert.match(out, /aria-valuenow="100"/, `${phase} keeps meter value`);
    assert.match(out, /后重置/, `${phase} keeps reset time`);
  }
  // 认证异常（healthy=false）同样保留额度主体
  assert.match(quotaCard({ ...base, healthy: false, healthBasis: 'credentials' }), /认证异常[\s\S]*5 小时额度/);
  // 余额型渠道（DeepSeek/百炼）在熔断态主体不再消失；负余额红色样式保留
  const bal = quotaCard({ ...base, id: 'deepseek', type: 'deepseek', circuit: { phase: 'half_open' }, quota: { balance: { currency: 'CNY', total: '-0.53', granted: '0.00', toppedUp: '-0.53' }, fetchedAt: new Date().toISOString() } });
  assert.match(bal, /恢复试探/);
  assert.match(bal, /balance num crit/);
  assert.match(bal, /¥-0\.53/);
  // 无熔断时的原行为不回归：满格 → 待重置芯片；负余额 → 欠费芯片
  assert.match(quotaCard({ ...base, circuit: { phase: 'closed' } }), /待重置/);
  assert.match(quotaCard({ ...base, id: 'deepseek', type: 'deepseek', circuit: { phase: 'closed' }, quota: { balance: { currency: 'CNY', total: '-0.53' } } }), /欠费/);
});

test('quota card: quota 完全缺失与正余额熔断形态（评审 #2/#3 补测）', () => {
  const html = readFileSync(new URL('../src/dashboard/console.html', import.meta.url), 'utf8');
  const block = html.split('<script>').slice(1).map(s => s.split('</script>')[0]).find(s => s.includes('quotaCard'));
  const defs = block.slice(0, block.indexOf("document.addEventListener('change'"));
  const { quotaCard } = runInNewContext(defs + '\nS = { features: {} };\n({ quotaCard })', { matchMedia: () => ({ matches: false }), document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => ({ innerHTML: '' }), addEventListener() {}, documentElement: { classList: { toggle() {} } } } });
  const base = { id: 'claude', name: 'Claude', type: 'claude', badge: 'Pro', probe: { supported: true, lastError: 'credentials: ENOENT', fetchedAt: new Date().toISOString() } };
  // quota 完全缺失（claude 凭据 ENOENT 现役场景）+ half_open：主体空、芯片照常渲染
  const noData = quotaCard({ ...base, circuit: { phase: 'half_open' } });
  assert.match(noData, /恢复试探/);
  assert.match(noData, /<div class="q-body"><div class="q-error">[\s\S]*额度暂不可用[\s\S]*credentials: ENOENT/, 'body shows why quota is missing (2026-11-06：Claude 凭据失效时卡片不再空白/消失)');
  // 无熔断时：探测失败芯片
  assert.match(quotaCard(base), /chip crit[\s\S]*探测失败<\/span><\/div>/);
  assert.match(noData, /探测失败/);
  // 正余额 + half_open：主体显示余额（非 meter），芯片为状态
  const bal = quotaCard({ ...base, id: 'dashscope', type: 'dashscope', circuit: { phase: 'half_open' }, quota: { balance: { currency: 'CNY', total: '19.68', cash: '19.68' } } });
  assert.match(bal, /恢复试探/);
  assert.match(bal, /¥19\.68/);
  assert.doesNotMatch(bal, /meter/);
  // healthy=false + 负余额：健康优先于欠费芯片，但红色负余额主体保留
  const neg = quotaCard({ ...base, healthy: false, healthBasis: 'credentials', quota: { balance: { currency: 'CNY', total: '-0.53' } } });
  assert.match(neg, /认证异常/);
  assert.doesNotMatch(neg, /欠费/);
  assert.match(neg, /balance num crit[\s\S]*¥-0\.53/);
});

test('inbox confirm button form: data-apply must not coexist with data-close (click would close without firing)', () => {
  // 线上回归（2026-11-04）：确认钮同时带 data-close + data-apply，布尔空属性使
  // dataset.apply === ''，旧判断 `!e.target.dataset.apply` 为真 → 点「确认执行」
  // 命中关闭分支，弹窗关掉、preview/apply 请求根本不发。钉住按钮形态 + 处理器
  // 只按 closest('[data-apply]') 分派，防回退。
  const html = readFileSync(new URL('../src/dashboard/console.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-close data-apply|data-apply data-close/, '确认钮不得携带 data-close');
  assert.doesNotMatch(html, /!\s*e\.target\.dataset\.apply/, '处理器不得依赖空属性的 truthy 判断');
  assert.match(html, /closest\('\[data-apply\]'\)/, '确认分支按 closest 分派');
});

// ── 日志 › 请求（近 24h 混排明细）── v0.5 console 重做时列被砍成 6 列且写死 kind=served，
// Claude Code 等订阅直连记录（observed，采集器导入）被整体过滤。2026-11-05 恢复：
// 10 列（含输入/输出/缓存创建/缓存命中/成本）、served 与 observed 混排、渠道筛选按需拉取。
function loadConsoleView(extraLocation = {}, extraSandbox = {}) {
  const html = readFileSync(new URL('../src/dashboard/console.html', import.meta.url), 'utf8');
  const block = html.split('<script>').slice(1).map((s) => s.split('</script>')[0]).find((s) => s.includes('viewRequests'));
  assert.ok(block, 'console main script block not found');
  const defs = block.slice(0, block.indexOf("document.addEventListener('change'")); // 事件绑定段有 DOM 副作用，截掉
  const sandbox = {
    matchMedia: () => ({ matches: false }),
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => ({ innerHTML: '' }), addEventListener() {}, documentElement: { classList: { toggle() {} } } },
    location: { hash: '#logs-requests', ...extraLocation },
    fetch: () => new Promise(() => {}), // 悬挂：触发 loadLG 也不抛未处理拒绝
    fetchJson: () => new Promise(() => {}), // 真实声明在切片截断点之后，这里给悬挂实现
    ...extraSandbox,
  };
  return runInNewContext(defs + '\nS = { providers: [], logs: [] };\n({ viewRequests, viewChannels, loadLG, uFiltersHtml, LG, U, state })', sandbox);
}

test('logs view: 10 列表头 + observed 混排（用量导入/耗时—/成本4位）+ 上游模型改写 A → B + 未回报 usage 行', () => {
  const { viewRequests, LG, state } = loadConsoleView();
  LG.data = {
    logs: [
      { ts: '2026-11-05T05:06:12.854Z', kind: 'served', client: 'mac-pi', providerId: 'glm-primary', model: 'glm-5.3', upstreamModel: 'glm-5.3', stream: true, status: 200, ok: true, latencyMs: 7133, usage: { input: 375, output: 387, cacheRead: 41216, cacheWrite: 0 }, reported: true, cost: 0.012944 },
      { ts: '2026-11-05T04:51:58.048Z', kind: 'observed', device: 'mac', path: 'claude-code', client: 'claude-code', providerId: 'claude', model: 'claude-opus-5-5', upstreamModel: 'claude-opus-5-5', status: null, ok: null, latencyMs: null, usage: { input: 2, output: 3521, cacheRead: 87993, cacheWrite: 2144 }, reported: true, cost: 0.098747 },
      { ts: '2026-11-05T03:00:00.000Z', kind: 'served', client: 'pi-agent', providerId: 'deepseek', model: 'glm-5.3', upstreamModel: 'deepseek-v4-pro', stream: false, status: 502, ok: false, latencyMs: 821, usage: null, reported: false, cost: null },
    ],
    filters: { providers: [{ id: 'glm-primary', name: '智谱 1' }, { id: 'claude', name: 'Claude' }] },
    totals: {},
  };
  const out = viewRequests();
  // 列头：时间/来源/渠道·模型/输入/输出/缓存创建/缓存命中/成本/耗时/状态（Tokens 合并列已拆开）
  for (const th of ['时间', '来源', '渠道 · 模型', '输入', '输出', '缓存创建', '缓存命中', '成本', '耗时', '状态']) assert.match(out, new RegExp(th), `column ${th}`);
  assert.equal((out.match(/<th\b/g) ?? []).length, 10, 'exactly 10 columns');
  // served 行：四类 token 与 4 位小数成本
  assert.match(out, /375/); assert.match(out, /387/); assert.match(out, /41,216/); assert.match(out, /\$0\.0129/);
  // observed（Claude Code）行：可见、用量导入、耗时「—」、成本按订阅价折算
  assert.match(out, /claude-opus-5\.5/); assert.match(out, /用量导入/); assert.match(out, /87,993/); assert.match(out, /\$0\.0987/);
  // 失败请求行：上游模型改写展示 A → B；usage 未回报 → 输入/输出「暂无数据」、缓存「—」
  assert.match(out, /glm-5\.3[\s\S]*?→[\s\S]*?deepseek-v4-pro/); assert.match(out, /暂无数据/);
  // 渠道下拉含 observed 渠道（claude）—— Claude Code 记录可按渠道筛出
  assert.match(out, /<select data-lg="prov"[ >][\s\S]*?value="claude"/, '渠道下拉含 observed 渠道（claude）—— Claude Code 记录可按渠道筛出');
  // 筛选行顺序：渠道 → 口径 → 日志类型（2026-11-05 用户反馈）
  { const iP = out.indexOf('data-lg="prov"'), iK = out.indexOf('data-seg="kind"'), iF = out.indexOf('data-seg="logFilter"'); assert.ok(iP > 0 && iP < iK && iK < iF, 'filter order: channel → kind → log type'); }
  assert.match(out, /近 24 小时滚动窗口/);
  // 「失败」筛选：只留 served 失败行，observed（ok=null）不误伤为失败
  state.logFilter = 'failed';
  const failed = viewRequests();
  assert.doesNotMatch(failed, /用量导入/, 'observed rows must not count as failed');
  assert.match(failed, /deepseek-v4-pro/, 'served failure stays visible');
});

test('logs view: 渠道页「查看日志」hash 定位 —— 跳转锁定下拉，手动筛选不被残留锚点拉回', () => {
  // 直开带参 URL：首次加载采纳锚点渠道并按需拉取（fetchJson 悬挂 → loading 停留 true）
  const page = loadConsoleView({ hash: '#logs-requests/claude' });
  page.viewRequests();
  assert.equal(page.LG.prov, 'claude', 'anchor adopted on first load');
  assert.equal(page.LG.loading, true, 'fetch in flight');
  // 回归（2026-11-05 线上反馈）：手动换渠道后重渲染，URL 锚点仍是一/claude —— 不得拉回旧渠道
  page.LG.loading = false; page.LG.loadedOnce = true; // 模拟首拉完成（沙箱 fetch 悬挂，手动置状态）
  page.LG.prov = 'deepseek'; // 模拟 change handler 效果
  page.LG.data = { logs: [], filters: { providers: [{ id: 'deepseek' }] }, totals: {} };
  const out = page.viewRequests();
  assert.equal(page.LG.prov, 'deepseek', 'manual selection survives re-render with stale anchor');
  assert.equal(page.LG.loading, false, 'no refetch storm');
  assert.match(out, /value="deepseek" selected/, 'dropdown reflects manual selection');
  // 无参 hash（普通切页）不清筛选、不触发重拉
  const page2 = loadConsoleView({ hash: '#logs-requests' });
  page2.LG.prov = 'glm-primary';
  page2.LG.data = { logs: [], filters: { providers: [] }, totals: {} };
  page2.viewRequests();
  assert.equal(page2.LG.prov, 'glm-primary', 'plain navigation keeps provider filter');
  assert.notEqual(page2.LG.data, null, 'plain navigation does not refetch');
});

test('logs view: 渠道页「查看日志」常驻 —— 未选渠道 → all 锚点（跳转后全部日志），选中 → 渠道定位', () => {
  const page = loadConsoleView();
  page.U.data = { filters: { providers: [], models: [], clients: [] } };
  page.U.prov = '';
  assert.match(page.uFiltersHtml(), /#logs-requests\/all"/, 'no channel → all-logs anchor');
  page.U.prov = 'claude';
  assert.match(page.uFiltersHtml(), /#logs-requests\/claude"/, 'channel selected → channel anchor');
  // 'all' 锚点首载不被误当渠道 id（否则会拉 provider=all 的空数据再多一次和解重拉）
  const p2 = loadConsoleView({ hash: '#logs-requests/all' });
  p2.viewRequests();
  assert.equal(p2.LG.prov, '', "'all' anchor is not a channel id");
  assert.equal(p2.LG.loading, true, 'auto-load still fires');
});

test('channels view: 概览「查看用量」跳转干净定位 —— 口径/来源/模型残留一并重置（2026-11-05 反馈：订阅直连残留吞掉智谱 1 定位）', () => {
  const page = loadConsoleView({ hash: '#usage-channels/glm-primary' });
  page.state.kind = 'observed'; // 模拟之前在渠道页选了订阅直连
  page.U.model = 'claude-opus-5-5'; page.U.client = 'claude-code'; // 其他残留筛选
  page.viewChannels();
  assert.equal(page.U.prov, 'glm-primary', 'focus applies channel');
  assert.equal(page.state.kind, 'all', 'kind reset to all —— glm-primary 在订阅直连口径下无记录，不重置则选项消失、定位落空');
  assert.equal(page.U.range, 'today', 'range reset to today');
  assert.equal(page.U.model, '', 'model filter cleared');
  assert.equal(page.U.client, '', 'client filter cleared');
  assert.equal(page.U.loading, true, 'refetch in flight');
});

test('logs view: 口径切换后渠道和解 —— 订阅直连+claude → 经网关时渠道真实重置为全部并重拉（2026-11-05 线上反馈）', async () => {
  const calls = [];
  const served = { logs: [{ ts: '2026-11-05T08:00:00.000Z', kind: 'served', client: 'mac-pi', providerId: 'glm-primary', model: 'glm-5.3', upstreamModel: 'glm-5.3', ok: true, status: 200, latencyMs: 1000, usage: { input: 10, output: 10, cacheRead: 10, cacheWrite: 0 }, reported: true, cost: 0.001 }], filters: { providers: [{ id: 'glm-primary' }] }, totals: {}, modelNames: {} };
  const observed = { logs: [{ ts: '2026-11-05T04:00:00.000Z', kind: 'observed', client: 'claude-code', providerId: 'claude', model: 'claude-opus-5-5', usage: { input: 2, output: 1, cacheRead: 1, cacheWrite: 1 }, reported: true, cost: 0.01 }], filters: { providers: [{ id: 'claude' }] }, totals: {}, modelNames: {} };
  // hash 用非 logs 视图：跳过 loadLG 尾部的 render()（沙箱无完整 DOM），只测数据层和解
  const page = loadConsoleView({ hash: '#usage-channels' }, { fetchJson: (url) => { calls.push(String(url)); return Promise.resolve(String(url).includes('kind=served') ? served : observed); } });
  const { loadLG, LG, state } = page;
  // 订阅直连 + claude：组合有效，渠道保留
  state.kind = 'observed'; LG.prov = 'claude';
  await loadLG();
  assert.equal(LG.prov, 'claude', 'valid combo keeps channel');
  assert.ok(calls[0].includes('provider=claude') && calls[0].includes('kind=observed'));
  // 切经网关（kind handler 效果）：claude 在该口径无记录 → 渠道真实重置并重拉，下拉显示与数据源不再错位
  state.kind = 'served'; LG.data = null;
  await loadLG();
  assert.equal(LG.prov, '', 'channel reconciled to all');
  assert.equal(calls.length, 3, 'reconcile triggers exactly one refetch');
  assert.ok(!calls[2].includes('provider='), 'refetch drops stale channel');
  assert.ok(calls[2].includes('kind=served'));
  assert.ok(LG.data.logs.length === 1 && LG.data.logs[0].providerId === 'glm-primary', 'data follows reconciled filter');
});
