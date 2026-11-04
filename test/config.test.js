// config.test.js — config loading + validation + secret refs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateConfig, resolveRef, ConfigError } from '../src/config.js';

const VALID = {
  gateway: { keys: ['env:GW_KEY'] },
  providers: [
    {
      id: 'glm',
      type: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      apiKeyRef: 'env:GLM_KEY',
      models: ['glm-5.3'],
    },
  ],
  jobs: { activate: { model: 'glm-5.3-flash' } },
};

test('validateConfig accepts a minimal valid config and applies defaults', () => {
  const cfg = validateConfig(structuredClone(VALID));
  assert.equal(cfg.gateway.host, '0.0.0.0');
  assert.equal(cfg.gateway.port, 8080);
  assert.equal(cfg.jobs.probe.intervalSec, 300);
  assert.equal(cfg.jobs.probe.cacheTtlSec, 300);
  assert.equal(cfg.jobs.probe.backoffStartSec, 60);
  assert.equal(cfg.jobs.probe.backoffMaxSec, 3600);
  assert.equal(cfg.jobs.activate.delaySec, 60);
  assert.equal(cfg.jobs.activate.maxTokens, 1);
  assert.equal(cfg.jobs.activate.model, 'glm-5.3-flash');
  assert.deepEqual(cfg.topology, { appGroups: [], collectors: [], directConnections: [] });
});

test('topology normalizes display metadata and supports direct-only clients without gateway keys', () => {
  const raw = structuredClone(VALID);
  raw.observedUsage = { enabled: true, apiKeyRef: 'env:USAGE_SYNC_KEY' };
  raw.topology = {
    appGroups: [{ id: 'tools', label: ' 工具 ', icon: 'business', apps: ['shared', 'claude-code'] }],
    collectors: [{ id: 'mac-sync', label: ' Mac 采集 ' }],
    directConnections: [
      { app: 'claude-code', device: 'mac', providerId: 'claude', collectorId: 'mac-sync' },
      { app: 'codex', device: 'mac', providerId: 'codex-local' },
    ],
  };
  const cfg = validateConfig(raw);
  assert.equal(cfg.topology.appGroups[0].label, '工具');
  assert.equal(cfg.topology.collectors[0].label, 'Mac 采集');
  assert.deepEqual(cfg.topology.directConnections, raw.topology.directConnections);
  assert.deepEqual(cfg.gateway.keys.map((k) => k.app), ['shared']);
});

test('topology rejects duplicate memberships and invalid provider or collector references', () => {
  const valid = {
    appGroups: [{ id: 'one', label: 'One', apps: ['shared'] }],
    collectors: [{ id: 'sync', label: 'Sync' }],
    directConnections: [{ app: 'direct', device: 'nas', providerId: 'glm', collectorId: 'sync' }],
  };
  const cases = [
    [null, /topology: expected a mapping/],
    [{ appGroups: {} }, /topology.appGroups.*list/],
    [{ collectors: null }, /topology.collectors.*list/],
    [{ appGroups: [{ id: 'one', label: 'One', apps: ['shared', 'shared'] }] }, /duplicate shared/],
    [{ appGroups: [...valid.appGroups, { id: 'two', label: 'Two', apps: ['shared'] }] }, /duplicate shared/],
    [{ appGroups: [...valid.appGroups, { id: 'one', label: 'Two', apps: ['direct'] }] }, /duplicate one/],
    [{ appGroups: [{ id: 'one', label: 'One', apps: ['missing'] }] }, /unknown app/],
    [{ collectors: [...valid.collectors, ...valid.collectors] }, /duplicate sync/],
    [{ directConnections: [...valid.directConnections, ...valid.directConnections] }, /duplicate/],
    [{ directConnections: [{ ...valid.directConnections[0], providerId: 'missing' }] }, /unknown provider/],
    [{ directConnections: [{ ...valid.directConnections[0], collectorId: 'missing' }] }, /unknown collector/],
    [{ directConnections: [{ ...valid.directConnections[0], device: 'Mac desktop' }] }, /device/],
    [{ appGroups: [{ ...valid.appGroups[0], icon: 'https://example.test/icon.svg' }] }, /icon/],
    [{ collectors: [{ id: 'sync', label: '  ' }] }, /label/],
  ];
  for (const [override, error] of cases) {
    const raw = structuredClone(VALID);
    raw.topology = override === null ? null : { ...valid, ...override };
    assert.throws(() => validateConfig(raw), error);
  }
});

test('validateConfig: activate.codexModel/prompt/giveUpAfterSec passthrough (2026-09-25 regression: codexModel 被白名单丢弃)', () => {
  const raw = structuredClone(VALID);
  raw.jobs.activate.codexModel = 'gpt-6-luna';
  raw.jobs.activate.giveUpAfterSec = 900;
  raw.jobs.activate.prompt = 'say ok';
  const cfg = validateConfig(raw);
  assert.equal(cfg.jobs.activate.codexModel, 'gpt-6-luna');
  assert.equal(cfg.jobs.activate.giveUpAfterSec, 900);
  assert.equal(cfg.jobs.activate.prompt, 'say ok');
});

test('validateConfig: activate.codexModel 缺省 → null；prompt 缺省不覆盖（键不存在）', () => {
  const cfg = validateConfig(structuredClone(VALID));
  assert.equal(cfg.jobs.activate.codexModel, null);
  assert.equal(cfg.jobs.activate.giveUpAfterSec, 900);
  assert.ok(!('prompt' in cfg.jobs.activate), 'prompt key must be absent so activator default survives');
});

test('validateConfig: activate.codexModel 非字符串拒绝', () => {
  const raw = structuredClone(VALID);
  raw.jobs.activate.codexModel = 42;
  assert.throws(() => validateConfig(raw), ConfigError);
});

test('validateConfig: activate.claudeModel passthrough / 缺省 null / 非字符串拒绝（codexModel 2026-09-25 丢键事故同型预防）', () => {
  const raw = structuredClone(VALID);
  raw.jobs.activate.claudeModel = 'claude-haiku-5-5';
  const cfg = validateConfig(raw);
  assert.equal(cfg.jobs.activate.claudeModel, 'claude-haiku-5-5');

  assert.equal(validateConfig(structuredClone(VALID)).jobs.activate.claudeModel, null);

  const bad = structuredClone(VALID);
  bad.jobs.activate.claudeModel = 42;
  assert.throws(() => validateConfig(bad), ConfigError);
});

test('validateConfig: activate.claudeRunner/claudeCliTimeoutSec —— 白名单透传 + 默认 host-cli/180（2026-10-19 新键，丢键事故同型预防）', () => {
  const raw = structuredClone(VALID);
  raw.jobs.activate.claudeRunner = 'host-cli';
  raw.jobs.activate.claudeCliTimeoutSec = 240;
  const cfg = validateConfig(raw);
  assert.equal(cfg.jobs.activate.claudeRunner, 'host-cli');
  assert.equal(cfg.jobs.activate.claudeCliTimeoutSec, 240);

  // 缺省：host-cli / 180
  const def = validateConfig(structuredClone(VALID)).jobs.activate;
  assert.equal(def.claudeRunner, 'host-cli');
  assert.equal(def.claudeCliTimeoutSec, 180);

  // direct 已被指纹门控证死，不留开关
  const bad = structuredClone(VALID);
  bad.jobs.activate.claudeRunner = 'direct';
  assert.throws(() => validateConfig(bad), /host-cli/);

  const bad2 = structuredClone(VALID);
  bad2.jobs.activate.claudeCliTimeoutSec = 0;
  assert.throws(() => validateConfig(bad2), ConfigError);
});

test('validateConfig: claude 节归一 —— enabled 时 credentialFile/sessionDir 必填', () => {
  const raw = structuredClone(VALID);
  raw.claude = {
    enabled: true,
    credentialFile: '/app/claude-config/.credentials.json',
    sessionDir: '/app/claude-config/projects',
    displayName: 'Claude',
    badge: 'Pro',
    models: ['claude-opus-5-5'],
  };
  const cfg = validateConfig(raw);
  assert.deepEqual(cfg.claude, {
    enabled: true,
    credentialFile: '/app/claude-config/.credentials.json',
    sessionDir: '/app/claude-config/projects',
    displayName: 'Claude',
    badge: 'Pro',
    models: ['claude-opus-5-5'],
  });
});

test('validateConfig: claude 节缺省/禁用 → null；enabled 缺省视为 true', () => {
  assert.equal(validateConfig(structuredClone(VALID)).claude, null);

  const off = structuredClone(VALID);
  off.claude = { enabled: false }; // 禁用时无需路径
  assert.equal(validateConfig(off).claude, null);

  const implicit = structuredClone(VALID);
  implicit.claude = { credentialFile: '/c', sessionDir: '/s' }; // enabled 缺省 → true
  assert.equal(validateConfig(implicit).claude.enabled, true);

  const disp = structuredClone(VALID);
  disp.claude = { credentialFile: '/c', sessionDir: '/s', models: ['claude-opus-5-5'] };
  assert.deepEqual(validateConfig(disp).claude.models, ['claude-opus-5-5']);
  const noModels = structuredClone(VALID);
  noModels.claude = { credentialFile: '/c', sessionDir: '/s' };
  assert.deepEqual(validateConfig(noModels).claude.models, []); // normalize → 总是数组
});

test('validateConfig: claude 节负例 —— 缺路径/坏类型', () => {
  for (const [mutate, msg] of [
    [(r) => { r.claude = { enabled: true }; }, 'claude.credentialFile'],
    [(r) => { r.claude = { enabled: true, credentialFile: '/c' }; }, 'claude.sessionDir'],
    [(r) => { r.claude = { enabled: 'yes', credentialFile: '/c', sessionDir: '/s' }; }, 'claude.enabled'],
    [(r) => { r.claude = { credentialFile: '/c', sessionDir: '/s', displayName: 42 }; }, 'claude.displayName'],
    [(r) => { r.claude = { credentialFile: '/c', sessionDir: '/s', models: 'claude-opus-5-5' }; }, 'claude.models'],
    [(r) => { r.claude = { credentialFile: '/c', sessionDir: '/s', models: [] }; }, 'claude.models'],
    [(r) => { r.claude = { credentialFile: '/c', sessionDir: '/s', models: ['ok', 42] }; }, 'claude.models'],
    [(r) => { r.claude = 'nope'; }, 'claude:'],
  ]) {
    const bad = structuredClone(VALID);
    mutate(bad);
    assert.throws(() => validateConfig(bad), ConfigError, msg);
  }
});

test('validateConfig rejects: no providers / bad type / baseUrl without chat/completions / dup ids / empty keys', () => {
  const cases = [
    { ...structuredClone(VALID), providers: [] },
    { ...structuredClone(VALID), providers: [{ ...VALID.providers[0], type: 'nope' }] },
    { ...structuredClone(VALID), providers: [{ ...VALID.providers[0], baseUrl: 'https://x.example/v1' }] },
    {
      ...structuredClone(VALID),
      providers: [structuredClone(VALID.providers[0]), structuredClone(VALID.providers[0])],
    },
    { ...structuredClone(VALID), gateway: { keys: [] } },
  ];
  for (const c of cases) assert.throws(() => validateConfig(c), ConfigError);
});

test('validateConfig: gateway.keys 保留 note，兼容裸字符串 / 缺省 app / 显式 shared', () => {
  for (const shared of ['env:MODEL_GATEWAY_KEY', { key: 'env:MODEL_GATEWAY_KEY' }, { key: 'env:MODEL_GATEWAY_KEY', app: 'shared' }]) {
    const raw = structuredClone(VALID);
    raw.gateway.keys = [shared,
      { key: 'env:GATEWAY_KEY_PI_AGENT', app: 'pi-agent', note: 'models.json provider apiKey' },
      { key: 'literal-legacy', app: 'karakeep', note: '' },
    ];
    assert.deepEqual(validateConfig(raw).gateway.keys, [
      { key: 'env:MODEL_GATEWAY_KEY', app: 'shared' },
      { key: 'env:GATEWAY_KEY_PI_AGENT', app: 'pi-agent', note: 'models.json provider apiKey' },
      { key: 'literal-legacy', app: 'karakeep', note: '' },
    ]);
  }
});

test('validateConfig: 重复 app / env 名（包括 fallback）/ 字面量引用拒绝', () => {
  for (const keys of [
    [{ key: 'env:A', app: 'same' }, { key: 'env:B', app: 'same' }],
    ['env:A', { key: 'env:B', app: 'shared' }],
    [{ key: 'env:A', app: 'a' }, { key: 'env:A', app: 'b' }],
    [{ key: 'env:A:x', app: 'a' }, { key: 'env:A:y', app: 'b' }],
    [{ key: 'env:A', app: 'a' }, { key: 'env:A:x', app: 'b' }],
    [{ key: 'literal-key', app: 'a' }, { key: 'literal-key', app: 'b' }],
  ]) {
    const raw = structuredClone(VALID);
    raw.gateway.keys = keys;
    assert.throws(() => validateConfig(raw), /gateway\.keys.*duplicate/);
  }
});

test('validateConfig: app slug 和 note 类型校验', () => {
  for (const app of ['PI', '-pi', 'pi_agent', 'pi.agent', 'pi agent', '__unmarked__', null]) {
    const raw = structuredClone(VALID);
    raw.gateway.keys = [{ key: 'env:A', app }];
    assert.throws(() => validateConfig(raw), /gateway\.keys.*app/);
  }
  for (const note of [null, 42, {}, [], true]) {
    const raw = structuredClone(VALID);
    raw.gateway.keys = [{ key: 'env:A', app: 'pi-agent', note }];
    assert.throws(() => validateConfig(raw), /gateway\.keys.*note/);
  }
});

test('validateConfig: gateway.keys 负例 —— 空条目/缺 key/坏 app 类型/空 app/数组形态', () => {
  for (const bad of [
    [{}],
    [{ key: '', app: 'x' }],
    [{ app: 'x' }],
    [{ key: 'k', app: 42 }],
    [{ key: 'k', app: '' }],
    [42],
    [['k']],
    ['ok', { key: 'k2', app: 'y' }, { nope: 1 }],
  ]) {
    const raw = structuredClone(VALID);
    raw.gateway.keys = bad;
    assert.throws(() => validateConfig(raw), /gateway\.keys/, JSON.stringify(bad));
  }
});

test('validateConfig: activate.model required when activation enabled', () => {
  const cfg = structuredClone(VALID);
  delete cfg.jobs;
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test('resolveRef: env / env+default / literal', () => {
  const env = { SET_VAR: 'value-1' };
  assert.equal(resolveRef('env:SET_VAR', env), 'value-1');
  assert.equal(resolveRef('env:MISSING_VAR', env), null);
  assert.equal(resolveRef('env:MISSING_VAR:fallback', env), 'fallback');
  assert.equal(resolveRef('plain-literal', env), 'plain-literal');
  assert.equal(resolveRef(null, env), null);
});

test('validateConfig: visionRouting 合法声明归一化（per-provider map，modelDefs 形状不变）', () => {
  const raw = structuredClone(VALID);
  raw.providers[0].models = [
    { id: 'glm-5.3', modalities: ['text'], visionRouting: { strategy: 'reroute', target: 'glm-5.3-flash' } },
    { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
  ];
  const cfg = validateConfig(raw);
  assert.deepEqual(cfg.providers[0].visionRouting, { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash' } });
  assert.deepEqual(cfg.providers[0].modelDefs, { 'glm-5.3': ['text'], 'glm-5.3-flash': ['text', 'image'] });
  assert.deepEqual(cfg.providers[0].models, ['glm-5.3', 'glm-5.3-flash']);
});

test('validateConfig: visionRouting 负例 —— strategy 仅 reroute / target 非空 / 非对象形态', () => {
  const mk = (vr) => () => {
    const raw = structuredClone(VALID);
    raw.providers[0].models = [
      { id: 'glm-5.3', modalities: ['text'], visionRouting: vr },
      { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
    ];
    return raw;
  };
  assert.throws(() => validateConfig(mk({ strategy: 'transcribe', target: 'glm-5.3-flash' })()),
    /visionRouting\.strategy: only 'reroute' is supported/);
  assert.throws(() => validateConfig(mk({ strategy: 'reroute', target: '' })()),
    /visionRouting\.target: required non-empty string/);
  assert.throws(() => validateConfig(mk({ strategy: 'reroute' })()),
    /visionRouting\.target: required non-empty string/);
  assert.throws(() => validateConfig(mk(['reroute', 'glm-5.3-flash'])()),
    /visionRouting: must be a mapping/);
});

test('validateConfig: visionRouting.uncertain —— consumed 合法归一；pixels/缺省不写入；非法值拒绝', () => {
  const mkModels = (vr) => {
    const raw = structuredClone(VALID);
    raw.providers[0].models = [
      { id: 'glm-5.3', modalities: ['text'], visionRouting: vr },
      { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
    ];
    return raw;
  };
  assert.deepEqual(validateConfig(mkModels({ strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'consumed' })).providers[0].visionRouting,
    { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'consumed' } });
  assert.deepEqual(validateConfig(mkModels({ strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'pixels' })).providers[0].visionRouting,
    { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash' } }, 'pixels 等价缺省，不写入归一形态');
  assert.throws(() => validateConfig(mkModels({ strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'strip' })),
    /visionRouting\.uncertain: only 'pixels' or 'consumed' are supported/);
});

test('validateConfig: visionRouting.uncertain 跨 provider 声明不一致 → 拒绝', () => {
  const raw = structuredClone(VALID);
  const mkModels = (vr) => [
    { id: 'glm-5.3', modalities: ['text'], visionRouting: vr },
    { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
  ];
  raw.providers = [
    { ...raw.providers[0], models: mkModels({ strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'consumed' }) },
    { ...raw.providers[0], id: 'glm-2', models: mkModels({ strategy: 'reroute', target: 'glm-5.3-flash' }) },
  ];
  assert.throws(() => validateConfig(raw), /visionRouting declarations differ across providers/);
});

test('validateConfig: visionRouting 负例 —— target 未在目录中声明', () => {
  const raw = structuredClone(VALID);
  raw.providers[0].models = [
    { id: 'glm-5.3', modalities: ['text'], visionRouting: { strategy: 'reroute', target: 'no-such-model' } },
  ];
  assert.throws(() => validateConfig(raw), /target: "no-such-model" is not declared by any provider/);
});

test('validateConfig: visionRouting 负例 —— target 未声明 image 模态', () => {
  const raw = structuredClone(VALID);
  raw.providers[0].models = [
    { id: 'glm-5.3', modalities: ['text'], visionRouting: { strategy: 'reroute', target: 'text-only-model' } },
    { id: 'text-only-model', modalities: ['text'] },
  ];
  assert.throws(() => validateConfig(raw),
    /target: "text-only-model" must declare image modality/);
});

test('validateConfig: visionRouting 负例 —— 配置方自己声明了 image 模态（仅 text-only 可配）', () => {
  const raw = structuredClone(VALID);
  raw.providers[0].models = [
    { id: 'glm-5.3', modalities: ['text', 'image'], visionRouting: { strategy: 'reroute', target: 'glm-5.3-flash' } },
    { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
  ];
  assert.throws(() => validateConfig(raw),
    /model "glm-5.3" already declares image modality/);
});

test('validateConfig: visionRouting 负例 —— 同一模型跨 provider 声明不一致', () => {
  const raw = structuredClone(VALID);
  raw.providers[0].models = [
    { id: 'glm-5.3', modalities: ['text'], visionRouting: { strategy: 'reroute', target: 'glm-5.3-flash' } },
    { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
  ];
  raw.providers.push({
    id: 'glm-backup',
    type: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyRef: 'env:GLM_BACKUP_KEY',
    models: [
      { id: 'glm-5.3', modalities: ['text'], visionRouting: { strategy: 'reroute', target: 'text-only-model' } },
      { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
    ],
  });
  assert.throws(() => validateConfig(raw),
    /visionRouting declarations differ across providers/);
});

test('validateConfig: visionRouting 一致声明跨 provider 通过（各声明方均合法）', () => {
  const raw = structuredClone(VALID);
  raw.providers[0].models = [
    { id: 'glm-5.3', modalities: ['text'], visionRouting: { strategy: 'reroute', target: 'glm-5.3-flash' } },
    { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
  ];
  raw.providers.push({
    id: 'glm-backup',
    type: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyRef: 'env:GLM_BACKUP_KEY',
    models: [
      { id: 'glm-5.3', modalities: ['text'], visionRouting: { strategy: 'reroute', target: 'glm-5.3-flash' } },
      { id: 'glm-5.3-flash', modalities: ['text', 'image'] },
    ],
  });
  const cfg = validateConfig(raw);
  assert.deepEqual(cfg.providers[1].visionRouting['glm-5.3'], { strategy: 'reroute', target: 'glm-5.3-flash' });
});

test('loadConfig: reads YAML then JSON, prefers yaml; missing dir throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgw-cfg-'));
  try {
    writeFileSync(join(dir, 'config.yaml'), [
      'gateway:',
      '  keys:',
      '    - env:GW_KEY',
      'providers:',
      '  - id: a',
      '    type: openai',
      '    baseUrl: https://a.example/v1/chat/completions',
      '    apiKeyRef: env:A_KEY',
      '    models:',
      '      - m1',
      'jobs:',
      '  activate:',
      '    model: m1',
    ].join('\n'));
    const cfg = loadConfig(dir);
    assert.equal(cfg.providers[0].id, 'a');
    assert.equal(cfg.jobs.activate.model, 'm1');

    writeFileSync(join(dir, 'config.json'), JSON.stringify(VALID));
    // YAML wins over JSON by basename priority order.
    const cfg2 = loadConfig(dir);
    assert.equal(cfg2.providers[0].id, 'a');

    assert.throws(() => loadConfig(join(dir, 'nope')), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: JSON-only directory works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgw-cfg-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(VALID));
    const cfg = loadConfig(dir);
    assert.equal(cfg.providers[0].type, 'glm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: YAML 块序列 visionRouting 解析并挂载（与 config.example.yaml 同写法）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgw-cfg-'));
  try {
    writeFileSync(join(dir, 'config.yaml'), [
      'gateway:',
      '  keys:',
      '    - env:GW_KEY',
      'providers:',
      '  - id: a',
      '    type: openai',
      '    baseUrl: https://a.example/v1/chat/completions',
      '    apiKeyRef: env:A_KEY',
      '    models:',
      '      - id: glm-5.3',
      '        modalities:',
      '          - text',
      '        visionRouting:',
      '          strategy: reroute',
      '          target: glm-5.3-flash',
      '      - id: glm-5.3-flash',
      '        modalities:',
      '          - text',
      '          - image',
      'jobs:',
      '  activate:',
      '    model: glm-5.3-flash',
    ].join('\n'));
    const cfg = loadConfig(dir);
    assert.deepEqual(cfg.providers[0].visionRouting, { 'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig loads the shipped config.example.yaml', () => {
  // The example must be valid as-is（含 visionRouting 示例条目）。
  const dir = mkdtempSync(join(tmpdir(), 'mgw-cfg-'));
  try {
    const example = readFileSync(new URL('../config/config.example.yaml', import.meta.url), 'utf8');
    writeFileSync(join(dir, 'config.yaml'), example);
    const cfg = loadConfig(dir);
    assert.ok(cfg.providers.length >= 1);
    assert.deepEqual(cfg.providers[0].visionRouting, {
      'glm-5.3': { strategy: 'reroute', target: 'glm-5.3-flash', uncertain: 'consumed' },
    });
    assert.deepEqual(cfg.providers[0].modelDefs['glm-5.3-flash'], ['text', 'image']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateConfig: gateway.timeouts / gateway.circuit 缺省默认（issue #3）', () => {
  const cfg = validateConfig(structuredClone(VALID));
  assert.deepEqual(cfg.gateway.timeouts, { requestSec: 120, streamSec: 300 });
  assert.deepEqual(cfg.gateway.circuit, { enabled: true, failureThreshold: 3, cooldownSec: 120 });
});

test('validateConfig: gateway.timeouts / gateway.circuit 覆盖透传与非法值拒绝（issue #3）', () => {
  const raw = structuredClone(VALID);
  raw.gateway.timeouts = { requestSec: 60, streamSec: 600 };
  raw.gateway.circuit = { enabled: false, failureThreshold: 5, cooldownSec: 30 };
  const cfg = validateConfig(raw);
  assert.deepEqual(cfg.gateway.timeouts, { requestSec: 60, streamSec: 600 });
  assert.deepEqual(cfg.gateway.circuit, { enabled: false, failureThreshold: 5, cooldownSec: 30 });

  for (const [mutate, msg] of [
    [(r) => { r.gateway.timeouts = { requestSec: 0 }; }, 'requestSec must be positive'],
    [(r) => { r.gateway.circuit = { failureThreshold: 0 }; }, 'failureThreshold integer >= 1'],
    [(r) => { r.gateway.circuit = { cooldownSec: -1 }; }, 'cooldownSec positive'],
    [(r) => { r.gateway.circuit = { enabled: 'yes' }; }, 'enabled boolean'],
  ]) {
    const bad = structuredClone(VALID);
    mutate(bad);
    assert.throws(() => validateConfig(bad), ConfigError, msg);
  }
});

test('validateConfig: anthropicBaseUrl optional passthrough base (trailing slash trimmed; /v1/messages rejected)', () => {
  const ok = structuredClone(VALID);
  ok.providers[0].anthropicBaseUrl = 'https://open.bigmodel.cn/api/anthropic/';
  assert.equal(validateConfig(ok).providers[0].anthropicBaseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(validateConfig(structuredClone(VALID)).providers[0].anthropicBaseUrl, null);
  for (const bad of ['ftp://x', 'https://x/api/anthropic/v1/messages', 42]) {
    const cfg = structuredClone(VALID);
    cfg.providers[0].anthropicBaseUrl = bad;
    assert.throws(() => validateConfig(cfg), /anthropicBaseUrl/);
  }
});
