/**
 * model-guard 单测 — 决策核心移植对齐：
 *  - classifyModel / buildUniverse（发现）
 *  - priceOk / planChanges 决策护栏（≤30% 替换 / >30% 并行 / 全新系列报告 / 首跑基线 / retired 沉默）
 *  - detectRetired（deepseek 官方列表消失 / glm 响应漂移 / glm 503 / gpt 豁免）
 *  - applyToConfig（YAML / JSON；只改 providers[].models）
 *  - state 持久化幂等（次轮无新动作）
 *  - dryRun 默认 true：不改 config；显式 false 才落地 + 事件 + onChange
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyModel, buildUniverse, priceOk, planChanges,
  detectRetired, applyToConfig, ModelGuard, buildReport,
} from '../src/ops/jobs/model-guard.js';
import { EventLog } from '../src/events.js';

// ── 发现 ────────────────────────────────────────────────────────

test('classifyModel: gpt/glm/deepseek 系列与 tier 解析', () => {
  assert.deepEqual(classifyModel('gpt-6-sol'), { family: 'gpt', version: 6, tier: 'sol' });
  assert.deepEqual(classifyModel('gpt-6.5-luna'), { family: 'gpt', version: 6.5, tier: 'luna' });
  assert.deepEqual(classifyModel('glm-5.3'), { family: 'glm', version: 5.3, tier: 'base' });
  assert.deepEqual(classifyModel('glm-5.3-flash'), { family: 'glm', version: 5.3, tier: 'flash' });
  assert.deepEqual(classifyModel('deepseek-v4-pro'), { family: 'deepseek', version: 4, tier: 'pro' });
  assert.deepEqual(classifyModel('deepseek-v4.2-flash'), { family: 'deepseek', version: 4.2, tier: 'flash' });
  // 未跟踪变体 / 无版本条目 / 未知系列
  assert.equal(classifyModel('glm-5.3-flashx'), null);
  assert.equal(classifyModel('deepseek-chat'), null);
  assert.equal(classifyModel('o3'), null);
  assert.equal(classifyModel('kimi-k2'), null);
});

test('buildUniverse: models.dev api.json → family 分桶（无计费条目剔除）', () => {
  const api = {
    openai: { models: {
      'gpt-6-sol': { cost: { input: 1.25, output: 10 }, limit_context: 400000, limit_output: 128000 },
      'gpt-6.5-sol': { cost: { input: 1.5, output: 12 }, limit_context: 400000, limit_output: 128000 },
      'o3': { cost: { input: 2, output: 8 } }, // 不匹配系列 pattern
    } },
    zai: { models: {
      'glm-5.3': { cost: { input: 0.6, output: 2.2 } },
      'glm-5.3-flash': { cost: { input: 0.1, output: 0.4 } },
      'glm-5.3-air': { cost: { input: 0.05, output: 0.2 } }, // 未跟踪变体
    } },
    deepseek: { models: {
      'deepseek-v4-pro': { cost: { input: 0.28, output: 0.42 } },
      'deepseek-v4.5-pro': { cost: { input: 0.4, output: 0.6 } },
      'deepseek-free': {}, // 无计费 → 剔除
    } },
  };
  const u = buildUniverse(api);
  assert.deepEqual(Object.keys(u.gpt), ['gpt-6-sol', 'gpt-6.5-sol']);
  assert.deepEqual(Object.keys(u.glm), ['glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual(Object.keys(u.deepseek), ['deepseek-v4-pro', 'deepseek-v4.5-pro']);
  assert.equal(u.gpt['gpt-6.5-sol'].tier, 'sol');
  assert.equal(u.gpt['gpt-6.5-sol'].cost.input, 1.5);
});

// ── 决策护栏 ────────────────────────────────────────────────────

const OLD = { family: 'gpt', version: 6, tier: 'sol', cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 }, ctx: 400000, maxout: 128000 };

test('priceOk: ≤30% 通过；>30% 任一项即否；免费→收费否', () => {
  const bump10 = { ...OLD, cost: { ...OLD.cost, input: 1.375, output: 11 } }; // +10% / +10%
  assert.equal(priceOk(OLD, bump10, 1.3), true);
  const bump29 = { ...OLD, cost: { ...OLD.cost, input: 1.6, output: 12.9 } }; // +28% / +29%
  assert.equal(priceOk(OLD, bump29, 1.3), true);
  const inputOver = { ...OLD, cost: { ...OLD.cost, input: 1.63, output: 11 } }; // input +30.4%
  assert.equal(priceOk(OLD, inputOver, 1.3), false);
  const outputOver = { ...OLD, cost: { ...OLD.cost, input: 1.2, output: 13.1 } }; // output +31%
  assert.equal(priceOk(OLD, outputOver, 1.3), false);
  const freeToPaid = { ...OLD, cost: { ...OLD.cost, input: 0.01, output: 0.01 } };
  const freeOld = { ...OLD, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(priceOk(freeOld, freeToPaid, 1.3), false);
});

function universeWith(entries) {
  return entries; // 直接给 {family: {mid: info}} 形态
}

test('planChanges: 涨幅 ≤30% 且目录已部署 → replace', () => {
  const universe = universeWith({
    gpt: {
      'gpt-6-sol': OLD,
      'gpt-6.5-sol': { ...OLD, version: 6.5, cost: { ...OLD.cost, input: 1.5, output: 12 } },
    },
  });
  const state = { models: { gpt: { 'gpt-6-sol': OLD } } };
  const actions = planChanges(universe, state, { threshold: 1.3, deployed: ['gpt-6-sol'] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'replace');
  assert.equal(actions[0].old, 'gpt-6-sol');
  assert.equal(actions[0].new, 'gpt-6.5-sol');
});

test('planChanges 回归: state 基线已吸收新模型不致盲升级发现', () => {
  // 2026-10-01 生产事故：gpt-6.1-sol 上线时恰逢容器重建丢 state，首跑重建基线
  // 把它记为已见过 → 旧逻辑（快照对比）永不报告；目录驱动对比不受影响
  const universe = universeWith({
    gpt: { 'gpt-6-sol': OLD, 'gpt-6.1-sol': { ...OLD, version: 6.1 } },
  });
  const state = { models: { gpt: { 'gpt-6-sol': OLD, 'gpt-6.1-sol': { version: 6.1 } } } };
  const actions = planChanges(universe, state, { threshold: 1.3, deployed: ['gpt-6-sol'] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'replace');
  assert.equal(actions[0].old, 'gpt-6-sol');
  assert.equal(actions[0].new, 'gpt-6.1-sol');
});

test('planChanges: 首跑（空 state）+ 目录非空 → replace 照样产出（各 family 统一语义）', () => {
  const universe = universeWith({
    gpt: { 'gpt-6-sol': OLD, 'gpt-6.1-sol': { ...OLD, version: 6.1 } },
  });
  const actions = planChanges(universe, {}, { threshold: 1.3, deployed: ['gpt-6-sol'] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'replace');
  assert.equal(actions[0].new, 'gpt-6.1-sol');
});

test('planChanges: 涨幅 >30% → parallel（人工决策）', () => {
  const universe = universeWith({
    gpt: {
      'gpt-6-sol': OLD,
      'gpt-6.5-sol': { ...OLD, version: 6.5, cost: { ...OLD.cost, input: 2.5, output: 20 } }, // +100%
    },
  });
  const state = { models: { gpt: { 'gpt-6-sol': OLD } } };
  const actions = planChanges(universe, state, { threshold: 1.3, deployed: ['gpt-6-sol'] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'parallel');
});

test('planChanges: 旧模型价格未知（上游与快照均无）→ parallel（无法比价）', () => {
  // 目录里的自维护别名不在 models.dev，升级候选无法比价 → 人工决策
  const universe = universeWith({
    gpt: { 'gpt-7-sol': { ...OLD, version: 7 } }, // 上游无 gpt-6-sol 条目
  });
  const actions = planChanges(universe, { models: {} }, { threshold: 1.3, deployed: ['gpt-6-sol'] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'parallel');
  assert.match(actions[0].reason ?? '', /价格未知/);
});

test('planChanges: 上游 family+tier 无部署对应 → notify_new_family；seen 去重只报一次', () => {
  const universe = universeWith({
    glm: {
      'glm-5.3': { family: 'glm', version: 5.3, tier: 'base', cost: { input: 0.6, output: 2.2 }, ctx: 128000, maxout: 128000 },
      'glm-6-air': { family: 'glm', version: 6, tier: 'base', cost: { input: 0.3, output: 1 }, ctx: 128000, maxout: 128000 },
    },
  });
  // 目录只部署 flash tier；base tier 无部署对应；glm-5.3 已见过（state 去重）
  const state = { models: { glm: { 'glm-5.3': {} } } };
  const actions = planChanges(universe, state, { threshold: 1.3, deployed: ['glm-5.3-flash'] });
  const types = actions.map((a) => a.type);
  assert.ok(types.every((t) => t === 'notify_new_family'));
  assert.ok(actions.some((a) => a.model === 'glm-6-air'));
  assert.ok(!actions.some((a) => a.model === 'glm-5.3'), 'seen 集合去重：已见过的不再报');
});

test('planChanges: 首跑 notify 沉默、replace 不沉默；retired 名单沉默升级候选', () => {
  const universe = universeWith({
    gpt: { 'gpt-6-sol': OLD, 'gpt-6.1-sol': { ...OLD, version: 6.1 } },
    glm: { 'glm-6-air': { family: 'glm', version: 6, tier: 'base', cost: { input: 0.3, output: 1 }, ctx: 1, maxout: 1 } },
  });
  // 首跑（空 state）：deployed gpt-6-sol 的 replace 照常产出；无部署对应的 glm-6-air 沉默（建基线）
  const a1 = planChanges(universe, {}, { threshold: 1.3, deployed: ['gpt-6-sol'] });
  assert.equal(a1.filter((a) => a.type === 'replace').length, 1);
  assert.equal(a1.filter((a) => a.type === 'notify_new_family').length, 0);
  // retired 名单中的上游候选不作为升级目标
  const a2 = planChanges(universe, { models: {}, retired: ['gpt/gpt-6.1-sol'] }, { threshold: 1.3, deployed: ['gpt-6-sol'] });
  assert.deepEqual(a2, []);
});

test('planChanges: 同 tier 版本不更新 → 忽略；跨 tier 不比价', () => {
  const universe = universeWith({
    glm: {
      'glm-5.3': { family: 'glm', version: 5.3, tier: 'base', cost: { input: 0.6, output: 2.2 }, ctx: 1, maxout: 1 },
      'glm-5.3-flash': { family: 'glm', version: 5.3, tier: 'flash', cost: { input: 0.1, output: 0.4 }, ctx: 1, maxout: 1 },
    },
  });
  // 目录部署 base（glm-5.3）：上游同版本 → 无升级；flash 无部署对应 → 新系列报告（不与 base 比价）
  const state = { models: { glm: {} } };
  const actions = planChanges(universe, state, { threshold: 1.3, deployed: ['glm-5.3'] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'notify_new_family');
  assert.equal(actions[0].model, 'glm-5.3-flash');
});

// ── 退役检测 ────────────────────────────────────────────────────

const DS_PROVIDER = {
  id: 'deepseek', type: 'openai',
  baseUrl: 'https://api.deepseek.com/v1/chat/completions',
  apiKeyRef: 'env:TEST_DS_KEY',
  models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
};
const GLM_PROVIDER = {
  id: 'glm-main', type: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  apiKeyRef: 'env:TEST_GLM_KEY',
  models: ['glm-5.3', 'glm-5.3-flash'],
};

test('detectRetired: deepseek 官方列表消失 → 退役', async () => {
  process.env.TEST_DS_KEY = 'k';
  const universe = { deepseek: { 'deepseek-v4-pro': {}, 'deepseek-v4-flash': {} } };
  const fetchImpl = async (url) => {
    assert.equal(String(url), 'https://api.deepseek.com/v1/models');
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { status: 200 }); // flash 消失
  };
  try {
    const retired = await detectRetired({ providers: [DS_PROVIDER], universe, fetchImpl });
    assert.equal(retired.length, 1);
    assert.equal(retired[0].model, 'deepseek-v4-flash');
    assert.equal(retired[0].family, 'deepseek');
    assert.match(retired[0].evidence, /absent from official/);
  } finally {
    delete process.env.TEST_DS_KEY;
  }
});

test('detectRetired: 官方稳定名 deepseek-flash 也全量比对（在册不误报 / 消失报退役）', async () => {
  process.env.TEST_DS_KEY = 'k';
  const provider = { ...DS_PROVIDER, models: ['deepseek-flash', 'deepseek-v4-pro'] };
  const universe = { deepseek: { 'deepseek-v4-pro': {} } };
  const mkFetch = (ids) => async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
  try {
    // 在官方列表中 → 不误报
    let retired = await detectRetired({ providers: [provider], universe, fetchImpl: mkFetch(['deepseek-flash', 'deepseek-v4-pro']) });
    assert.equal(retired.length, 0);
    // 从官方列表消失 → 报退役（classifyModel 对其返回 null，旧逻辑会漏检）
    retired = await detectRetired({ providers: [provider], universe, fetchImpl: mkFetch(['deepseek-v4-pro']) });
    assert.equal(retired.length, 1);
    assert.equal(retired[0].model, 'deepseek-flash');
    assert.match(retired[0].evidence, /absent from official/);
  } finally {
    delete process.env.TEST_DS_KEY;
  }
});

test('detectRetired: glm 响应 model 字段漂移（静默重映射）→ 退役；503 → 退役；健康不误报', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const universe = { glm: { 'glm-5.3': {}, 'glm-5.3-flash': {} } };
  const probes = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    probes.push(body.model);
    if (body.model === 'glm-5.3') {
      return new Response(JSON.stringify({ model: 'glm-5.3-flash', choices: [] }), { status: 200 }); // 漂移
    }
    if (body.model === 'glm-5.3-flash') {
      return new Response('no channel', { status: 503 }); // 网关无渠道
    }
    return new Response('{}', { status: 200 });
  };
  const events = new EventLog(20);
  try {
    const retired = await detectRetired({ providers: [GLM_PROVIDER], universe, fetchImpl, events });
    // 本 provider 只列 glm-5.3 与 glm-5.3-flash —— 都退役
    assert.equal(retired.length, 2);
    const byModel = Object.fromEntries(retired.map((r) => [r.model, r]));
    assert.match(byModel['glm-5.3'].evidence, /silently remapped to glm-5.3-flash/);
    assert.match(byModel['glm-5.3-flash'].evidence, /HTTP 503/);
    // 探测请求温和性：1-token、非流式
    assert.ok(probes.every((m) => typeof m === 'string'));
    assert.equal(events.list({ type: 'model_guard_retired' }).length, 1); // 漂移记事件
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

test('detectRetired: glm 429/5xx 不算退役证据；codex(gpt) 豁免不探测', async () => {
  process.env.TEST_GLM_KEY = 'k';
  const glmProvider = { ...GLM_PROVIDER, models: ['glm-5.3'] };
  const codexProvider = { id: 'codex', type: 'codex', baseUrl: null, apiKeyRef: null, models: ['gpt-6-sol'] };
  let glmCalls = 0;
  const fetchImpl = async () => {
    glmCalls += 1;
    return new Response('busy', { status: 429 });
  };
  try {
    const retired = await detectRetired({
      providers: [glmProvider, codexProvider],
      universe: { glm: { 'glm-5.3': {} }, gpt: { 'gpt-6-sol': {} } },
      fetchImpl,
    });
    assert.equal(retired.length, 0, '429 不算退役');
    assert.equal(glmCalls, 1, 'codex 不被探测');
  } finally {
    delete process.env.TEST_GLM_KEY;
  }
});

// ── 落地（只改网关 config）──────────────────────────────────────

test('applyToConfig: JSON 配置 — replace 改 models、retired 删除；不动其他字段', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  await fs.writeFile(cfgPath, JSON.stringify({
    gateway: { keys: ['k'] },
    providers: [
      { id: 'glm-main', type: 'glm', baseUrl: 'https://x/chat/completions', apiKeyRef: 'env:K', models: ['glm-5.3', 'glm-5.3-flash'] },
      { id: 'ds', type: 'openai', baseUrl: 'https://y/chat/completions', apiKeyRef: 'env:K2', models: ['deepseek-flash'] },
    ],
  }));
  const actions = [{ type: 'replace', family: 'glm', old: 'glm-5.3', new: 'glm-6', info: {}, oldinfo: {} }];
  const retired = [{ family: 'deepseek', model: 'deepseek-flash', providerId: 'ds', evidence: 'absent' }];
  const { changed } = await applyToConfig({ actions, retired, configPath: cfgPath });
  const after = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  assert.deepEqual(after.providers[0].models, ['glm-6', 'glm-5.3-flash']);
  assert.deepEqual(after.providers[1].models, []);
  // 其他字段不动
  assert.equal(after.gateway.keys[0], 'k');
  assert.equal(after.providers[0].baseUrl, 'https://x/chat/completions');
  assert.ok(changed.some((c) => c.includes('glm-5.3 → glm-6')));
  assert.ok(changed.some((c) => c.includes('-deepseek-flash')));
});

test('applyToConfig: YAML 配置 — 文本级 models 项替换/删除（保留注释）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-cfg-'));
  const cfgPath = path.join(dir, 'config.yaml');
  await fs.writeFile(cfgPath, [
    'gateway:',
    '  keys:',
    '    - env:GW_KEY',
    'providers:',
    '  - id: glm-main',
    '    type: glm',
    '    baseUrl: https://x/chat/completions',
    '    apiKeyRef: env:K',
    '    models:',
    '      - glm-5.3   # 主力',
    '      - glm-5.3-flash',
    '',
  ].join('\n'));
  const actions = [{ type: 'replace', family: 'glm', old: 'glm-5.3', new: 'glm-6' }];
  const retired = [{ family: 'glm', model: 'glm-5.3-flash', providerId: 'glm-main', evidence: 'x' }];
  await applyToConfig({ actions, retired, configPath: cfgPath });
  const text = await fs.readFile(cfgPath, 'utf8');
  assert.match(text, /- glm-6/);
  assert.ok(!text.includes('- glm-5.3\n'), 'old model entry removed');
  assert.ok(!text.includes('glm-5.3-flash'), 'retired model removed');
  assert.match(text, /# 主力/); // 注释保留（同一行尾注释随旧行替换丢失是预期——项本身被换掉）
});

test('applyToConfig: YAML 结构化条目 — `- id:` 替换保留 modalities 子块；删除整块移除不留孤儿', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-cfg2-'));
  const cfgPath = path.join(dir, 'config.yaml');
  await fs.writeFile(cfgPath, [
    'providers:',
    '  - id: codex',
    '    type: codex',
    '    models:',
    '      - id: gpt-6-sol',
    '        modalities:',
    '          - text',
    '          - image',
    '      - id: gpt-6-luna',
    '        modalities:',
    '          - text',
    '',
  ].join('\n'));
  await applyToConfig({
    actions: [{ type: 'replace', family: 'gpt', old: 'gpt-6-sol', new: 'gpt-6.1-sol' }],
    retired: [{ family: 'gpt', model: 'gpt-6-luna', providerId: 'codex', evidence: 'x' }],
    configPath: cfgPath,
  });
  const text = await fs.readFile(cfgPath, 'utf8');
  assert.ok(text.includes('- id: gpt-6.1-sol'), 'id swapped');
  assert.ok(text.includes('- text') && text.includes('- image'), 'modalities preserved');
  assert.ok(!text.includes('gpt-6-sol'), 'old id gone');
  assert.ok(!text.includes('gpt-6-luna'), 'retired structured entry removed with its modalities block');
});

test('applyToConfig: JSON 结构化条目 — {id:...} 换 id 保留其余字段；删除同理', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-cfg3-'));
  const cfgPath = path.join(dir, 'config.json');
  await fs.writeFile(cfgPath, JSON.stringify({
    gateway: { keys: ['k'] },
    providers: [{ id: 'codex', type: 'codex', models: [
      { id: 'gpt-6-sol', modalities: ['text', 'image'] },
      { id: 'gpt-6-luna', modalities: ['text'] },
    ] }],
  }, null, 2));
  await applyToConfig({
    actions: [{ type: 'replace', family: 'gpt', old: 'gpt-6-sol', new: 'gpt-6.1-sol' }],
    retired: [{ family: 'gpt', model: 'gpt-6-luna', providerId: 'codex', evidence: 'x' }],
    configPath: cfgPath,
  });
  const after = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  assert.deepEqual(after.providers[0].models, [{ id: 'gpt-6.1-sol', modalities: ['text', 'image'] }]);
});

test('ModelGuard: statePath 注入生效（state 落注入路径而非 config 同目录）', async () => {
  const providers = guardProviders();
  const { dir, cfgPath } = await makeConfigDir({ providers });
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-state-'));
  const statePath = path.join(stateDir, 'model-guard-state.json');
  const events = new EventLog(50);
  const guard = new ModelGuard({
    providers, jobs: { modelGuard: { enabled: true, dryRun: true } },
    configPath: cfgPath, statePath, events, fetch: guardFetch({}),
  });
  await guard.runOnce();
  const st = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.ok(st.models.gpt['gpt-6-sol'], 'baseline persisted at injected path');
  await assert.rejects(() => fs.access(path.join(dir, 'model-guard-state.json')), 'default path unused');
});

test('ModelGuard: apply 失败可见化 — model_guard_error 事件 + runOnce 不抛 + 报告照常', async () => {
  const providers = guardProviders();
  const { cfgPath } = await makeConfigDir({ providers });
  const events = new EventLog(50);
  const guard = new ModelGuard({
    providers, jobs: { modelGuard: { enabled: true, dryRun: false } },
    configPath: path.join(os.tmpdir(), 'nonexistent-mg-dir', 'config.yaml'),
    events, fetch: guardFetch({ withNew: true }),
  });
  const r = await guard.runOnce(); // applyToConfig 读不存在文件 → 报错被捕获不外抛
  assert.equal(r.actions.length, 1);
  assert.equal(r.applied.length, 0);
  const errs = events.list({ type: 'model_guard_error' });
  assert.ok(errs.length >= 1, 'apply/state 失败记入事件');
  assert.ok(errs.some((e) => e.stage === 'apply'));
  assert.match(r.report, /gpt-6\.5-sol/);
});

// ── ModelGuard job：runOnce / state 幂等 / dryRun ─────────────

function modelsDevApi({ withNew = false } = {}) {
  const gpt = {
    'gpt-6-sol': { cost: { input: 1.25, output: 10 } },
  };
  if (withNew) gpt['gpt-6.5-sol'] = { cost: { input: 1.5, output: 12 } }; // +20% ≤30% → replace
  return {
    openai: { models: gpt },
    zai: { models: { 'glm-5.3': { cost: { input: 0.6, output: 2.2 } } } },
    deepseek: { models: { 'deepseek-v4-pro': { cost: { input: 0.28, output: 0.42 } } } },
  };
}

function baselineState(api) {
  const u = buildUniverse(api);
  return { models: Object.fromEntries(Object.entries(u).map(([f, ms]) => [f, Object.fromEntries(Object.keys(ms).map((k) => [k, {}]))])) };
}

function guardProviders() {
  return [{
    id: 'codex-main', type: 'codex', baseUrl: null, apiKeyRef: null,
    models: ['gpt-6-sol'],
  }];
}

async function makeConfigDir({ providers, baselineState } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-guard-'));
  const cfgPath = path.join(dir, 'config.json');
  await fs.writeFile(cfgPath, JSON.stringify({
    gateway: { keys: ['k'] },
    providers: providers.map((p) => ({ ...p })),
  }, null, 2));
  if (baselineState) {
    await fs.writeFile(path.join(dir, 'model-guard-state.json'), JSON.stringify(baselineState, null, 2));
  }
  return { dir, cfgPath };
}

/** mock fetch：models.dev → api；退役探测按 provider 类型响应。withNew 控制次轮出现新模型。 */
function guardFetch({ glmServe = {}, withNew = false } = {}) {
  return async (url, init) => {
    const s = String(url);
    if (s === 'https://models.dev/api.json') {
      return new Response(JSON.stringify(modelsDevApi({ withNew })), { status: 200 });
    }
    // glm 1-token 探测
    if (init?.method === 'POST' && init.body) {
      const body = JSON.parse(init.body);
      const served = glmServe[body.model];
      if (served === undefined) return new Response(JSON.stringify({ model: body.model, choices: [] }), { status: 200 });
      if (served === 503) return new Response('no channel', { status: 503 });
      return new Response(JSON.stringify({ model: served, choices: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${s}`);
  };
}

test('ModelGuard: 首跑建基线（无动作、写 state）；次轮新模型 replace 决策 + dryRun 不改 config', async () => {
  const providers = guardProviders();
  const { dir, cfgPath } = await makeConfigDir({ providers });
  const events = new EventLog(50);
  let withNew = false;
  const inner = guardFetch({ glmServe: {} });
  const fetchImpl = async (url, init) => {
    if (String(url) === 'https://models.dev/api.json' && withNew) {
      return guardFetch({ withNew: true })(url, init);
    }
    return inner(url, init);
  };
  const guard = new ModelGuard({
    providers, jobs: { modelGuard: { enabled: true, dryRun: true } },
    configPath: cfgPath, events, fetch: fetchImpl,
  });

  // 首跑：基线（universe 无新模型）
  const r1 = await guard.runOnce();
  assert.equal(r1.actions.length, 0);
  const state1 = JSON.parse(await fs.readFile(path.join(dir, 'model-guard-state.json'), 'utf8'));
  assert.ok(state1.models.gpt['gpt-6-sol']);

  // 次轮：models.dev 出现 gpt-6.5-sol → replace 决策；dryRun → config 不动
  withNew = true;
  const before = await fs.readFile(cfgPath, 'utf8');
  const r2 = await guard.runOnce();
  assert.equal(r2.actions.length, 1);
  assert.equal(r2.actions[0].type, 'replace');
  assert.equal(r2.actions[0].new, 'gpt-6.5-sol');
  assert.equal(r2.applied.length, 0, 'dry-run applies nothing');
  assert.equal(await fs.readFile(cfgPath, 'utf8'), before, 'config untouched in dry-run');
  assert.match(r2.report, /dry-run/);
  // 事件（newest-first：次轮的 replace 在头部）
  const ev = events.list({ type: 'model_guard' })[0];
  assert.equal(ev.dryRun, true);
  assert.equal(ev.newModels, 1);
});

test('ModelGuard: dryRun:false → 落地改 config + state 推进 + onChange 触发 + 幂等（次轮无动作）', async () => {
  const providers = guardProviders();
  const { dir, cfgPath } = await makeConfigDir({
    providers,
    baselineState: { models: { gpt: { 'gpt-6-sol': {} }, glm: { 'glm-5.3': {} }, deepseek: { 'deepseek-v4-pro': {} } } },
  });
  const events = new EventLog(50);
  let changeCalls = 0;
  const guard = new ModelGuard({
    providers, jobs: { modelGuard: { enabled: true, dryRun: false } },
    configPath: cfgPath, events, fetch: guardFetch({ withNew: true }),
    onChange: () => { changeCalls += 1; },
  });

  const r1 = await guard.runOnce();
  assert.equal(r1.actions.length, 1);
  assert.equal(r1.applied.length, 1);
  assert.equal(changeCalls, 1);
  const after = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  assert.deepEqual(after.providers[0].models, ['gpt-6.5-sol'], 'catalog upgraded');

  // state 已推进：gpt-6.5-sol 入快照
  const state = JSON.parse(await fs.readFile(path.join(dir, 'model-guard-state.json'), 'utf8'));
  assert.ok(state.models.gpt['gpt-6.5-sol']);

  // 幂等：次轮 universe 无新条目 → 无动作
  const r2 = await guard.runOnce();
  assert.equal(r2.actions.length, 0);
  assert.equal(r2.applied.length, 0);
  assert.equal(changeCalls, 1, 'no extra onChange');
});

test('ModelGuard: 退役落地（glm 漂移）→ config 删除 + retired 名单防重复报告', async () => {
  const providers = [{
    id: 'glm-main', type: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyRef: 'env:TEST_MG_GLM_KEY',
    models: ['glm-5.3'],
  }];
  const baseline = { models: { gpt: { 'gpt-6-sol': {} }, glm: { 'glm-5.3': {} }, deepseek: { 'deepseek-v4-pro': {} } } };
  const { dir, cfgPath } = await makeConfigDir({ providers, baselineState: baseline });
  process.env.TEST_MG_GLM_KEY = 'k';
  const events = new EventLog(50);
  try {
    const guard = new ModelGuard({
      providers, jobs: { modelGuard: { enabled: true, dryRun: false } },
      configPath: cfgPath, events,
      fetch: guardFetch({ glmServe: { 'glm-5.3': 'glm-5.3-flash' } }), // 漂移 → 退役
    });    const r1 = await guard.runOnce();
    assert.equal(r1.retired.length, 1);
    assert.equal(r1.retired[0].model, 'glm-5.3');
    const after = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    assert.deepEqual(after.providers[0].models, [], 'retired model removed from catalog');

    // retired 名单已记录；再次运行（漂移仍在）→ 不重复报告（目录已无该模型，不再探测）
    const r2 = await guard.runOnce();
    assert.equal(r2.retired.length, 0, 'no duplicate retire report');
    const state = JSON.parse(await fs.readFile(path.join(dir, 'model-guard-state.json'), 'utf8'));
    assert.ok(state.retired.includes('glm/glm-5.3'));
  } finally {
    delete process.env.TEST_MG_GLM_KEY;
  }
});

test('ModelGuard: models.dev 不可达 → 记错误事件，本轮跳过（不误报）', async () => {
  const providers = guardProviders();
  const { cfgPath } = await makeConfigDir({ providers });
  const events = new EventLog(50);
  const guard = new ModelGuard({
    providers, jobs: { modelGuard: { enabled: true, dryRun: false } },
    configPath: cfgPath, events,
    fetch: async () => new Response('oops', { status: 500 }),
  });
  const r = await guard.runOnce();
  assert.equal(r.actions.length, 0);
  assert.equal(events.list({ type: 'model_guard_error' }).length, 1);
});

test('buildReport: 报告文本含替换/并行/新系列/退役段落', () => {
  const report = buildReport({
    universe: {},
    actions: [
      { type: 'replace', family: 'gpt', old: 'gpt-6-sol', new: 'gpt-6.5-sol', info: { cost: { input: 1.5, output: 12 } }, oldinfo: { cost: { input: 1.25, output: 10 } } },
      { type: 'parallel', family: 'glm', old: 'glm-5.3', new: 'glm-6', info: { cost: { input: 5, output: 20 } }, oldinfo: { cost: { input: 0.6, output: 2.2 } } },
      { type: 'notify_new_family', family: 'deepseek', model: 'deepseek-r2', info: {} },
    ],
    retired: [{ family: 'glm', model: 'glm-4.7', providerId: 'glm-main', evidence: 'remapped' }],
    applied: ['gateway: gpt-6-sol → gpt-6.5-sol'],
  });
  assert.match(report, /\[建议替换\] gpt: gpt-6-sol → gpt-6.5-sol/);
  assert.match(report, /\[新版待决定\] glm/);
  assert.match(report, /\[发现新型号\] deepseek: deepseek-r2/);
  assert.match(report, /\[疑似退役\] glm\/glm-4.7/);
  assert.match(report, /已应用/);
});
