// agent-endpoints.test.js — MG8：distribution.json → Agent 映射（类型推导、过期保留、/internal/keys 下发）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEndpoints, parseAgentEndpoints, parseRegistry, keyDeviceMismatches, iconKindOf } from '../src/monitor/agent-endpoints.js';
import { createRequestHandler } from '../src/gateway/router.js';
import { EventLog } from '../src/events.js';
import { validateConfig } from '../src/config.js';

const DIST = {
  endpoints: {
    'claude-code': { path: '/x', type: 'mac-symlink' },
    openclaw: { dist_dir: '/y', type: 'nas-dist-dir' },
    codex: { path: '/x', type: 'mac-symlink' },
    'mac-pi': { path: '/x', type: 'mac-symlink' },
    'pi-agent': { dist_dir: '/y', type: 'nas-dist-dir' },
    hermes: { type: 'ssh-copy' },
  },
};

test('parseAgentEndpoints：位置推导、本地在前、图标类型', () => {
  const agents = parseAgentEndpoints(JSON.stringify(DIST));
  assert.deepEqual(agents.map((a) => `${a.app}:${a.location}:${a.iconKind}`), [
    'claude-code:local:claudecode', 'codex:local:codex', 'mac-pi:local:pi',
    'openclaw:cloud:openclaw', 'pi-agent:cloud:pi', 'hermes:unknown:null',
  ]);
  assert.equal(iconKindOf('pipeline'), null, 'pi 只匹配完整片段');
  assert.throws(() => parseAgentEndpoints('{"endpoints":[]}'));
});

test('AgentEndpoints：读取失败保留上次结果并标 stale；首读失败为空', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'distribution.json');
  const missing = new AgentEndpoints({ file }).load().snapshot();
  assert.deepEqual(missing.agents, []);
  assert.equal(missing.source.stale, true);
  assert.equal(missing.source.error, '文件不存在');
  writeFileSync(file, JSON.stringify(DIST));
  const ep = new AgentEndpoints({ file }).load();
  assert.equal(ep.snapshot().agents.length, 6);
  writeFileSync(file, '{broken');
  const snap = ep.load().snapshot();
  assert.equal(snap.agents.length, 6);
  assert.equal(snap.source.stale, true);
  assert.equal(snap.source.error, 'JSON 解析失败');
  assert.equal(new AgentEndpoints().load().snapshot().source.configured, false);
});

test('validateConfig：agentEndpoints 进白名单', () => {
  const base = { gateway: { keys: ['k'] }, providers: [{ id: 'p', type: 'openai', baseUrl: 'https://x/v1/chat/completions', apiKeyRef: 'env:K', models: ['m'] }], jobs: { activate: { enabled: false } } };
  assert.deepEqual(validateConfig(base).agentEndpoints, { file: null, intervalSec: 600 });
  assert.equal(validateConfig({ ...base, agentEndpoints: { file: '/app/skills/distribution.json' } }).agentEndpoints.file, '/app/skills/distribution.json');
  assert.throws(() => validateConfig({ ...base, agentEndpoints: { intervalSec: 5 } }));
});

test('GET /internal/keys：下发 agents、agentSource，并为每个 key 附 agent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ep-'));
  const file = join(dir, 'distribution.json');
  writeFileSync(file, JSON.stringify(DIST));
  process.env.AGENT_EP_KEY = 'k-test-1234';
  const handler = createRequestHandler({
    config: { gateway: { keys: [{ key: 'env:AGENT_EP_KEY', app: 'pi-agent' }] } }, catalog: { providers: [] },
    events: new EventLog({ file: null }), agentEndpoints: new AgentEndpoints({ file }).load(),
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.AGENT_EP_KEY; });
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/internal/keys`)).json();
  assert.equal(body.agents.length, 6);
  assert.equal(body.agentSource.stale, false);
  assert.deepEqual(body.keys[0].agent, { app: 'pi-agent', iconKind: 'pi', location: 'cloud', label: 'Pi' });
});

// ── MG26：distribution.json v2（agents / devices / endpoints.devices） ──
const DIST_V2 = {
  version: 2,
  agents: {
    'claude-code': { label: 'Claude Code', icon: 'claudecode', detect: ['~/.claude'] },
    pi: { label: 'Pi', icon: 'pi' },
    hermes: { label: 'Hermes' },
  },
  devices: {
    'mac-mini': { label: 'Mac mini', platform: 'mac', match: { uuid: 'U-1' } },
    macbook: { label: 'MacBook', platform: 'mac' },
    nas: { label: 'NAS', platform: 'nas' },
  },
  endpoints: {
    'pi-agent': { agent: 'pi', devices: ['nas'], dir: '/y' },
    'claude-code': { agent: 'claude-code', devices: ['mac-mini', 'macbook'], dir: '~/.claude/skills' },
    'mac-pi': { agent: 'pi', devices: ['macbook'], dir: '~/.agents/skills' },
    spare: { agent: 'hermes', devices: [], dir: '/z' },
  },
  skills: {},
};

test('parseRegistry v2：名称/图标取 agents，设备 Tag 取 devices，按设备顺序排序', () => {
  const reg = parseRegistry(JSON.stringify(DIST_V2));
  assert.equal(reg.version, 2);
  assert.deepEqual(reg.agents.map((a) => `${a.app}:${a.label}:${a.iconKind}:${a.devices.join('+')}:${a.location}`), [
    'claude-code:Claude Code:claudecode:mac-mini+macbook:local',
    'mac-pi:Pi:pi:macbook:local',
    'pi-agent:Pi:pi:nas:cloud',
    'spare:Hermes:null::unknown',
  ]);
  assert.deepEqual(reg.devices.map((d) => `${d.id}:${d.label}:${d.platform}:${d.uuid}`), ['mac-mini:Mac mini:mac:U-1', 'macbook:MacBook:mac:null', 'nas:NAS:nas:null']);
});

test('parseRegistry v2：约束违例整体失败（未知 agent / 未知设备 / platform 混绑 / 未知 version）', () => {
  const bad = (patch) => JSON.stringify({ ...DIST_V2, endpoints: { x: patch } });
  assert.throws(() => parseRegistry(bad({ agent: 'nope', devices: [] })), /agent/);
  assert.throws(() => parseRegistry(bad({ agent: 'pi', devices: ['ghost'] })), /未知设备/);
  assert.throws(() => parseRegistry(bad({ agent: 'pi', devices: ['nas', 'macbook'] })), /platform/);
  assert.throws(() => parseRegistry(JSON.stringify({ ...DIST_V2, version: 3 })), /version/);
});

test('AgentEndpoints：snapshot 不下发硬件 UUID；v1→v2 切换后 version 更新', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ep-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'distribution.json');
  writeFileSync(file, JSON.stringify(DIST));
  const loads = [];
  const ep = new AgentEndpoints({ file, onLoad: (r) => loads.push(r.version) }).load();
  assert.equal(ep.snapshot().source.version, 1);
  writeFileSync(file, JSON.stringify(DIST_V2));
  const snap = ep.load().snapshot();
  assert.equal(snap.source.version, 2);
  assert.equal(snap.source.stale, false);
  assert.ok(snap.devices.every((d) => !('uuid' in d)));
  assert.deepEqual(loads, [1, 2]);
});

test('keyDeviceMismatches：agent key 缺 device / 设备未注册 / 端点未绑定；业务 key 可不带 device', () => {
  const reg = parseRegistry(JSON.stringify(DIST_V2));
  const keys = [
    { app: 'claude-code', device: 'mac-mini' },
    { app: 'claude-code' },
    { app: 'claude-code', device: 'nas' },
    { app: 'mac-pi', device: 'imac' },
    { app: 'karakeep' },
    { app: 'karakeep', device: 'ghost' },
    { app: 'shared' },
  ];
  assert.deepEqual(keyDeviceMismatches(keys, reg), [
    { app: 'claude-code', device: null, reason: 'device_missing' },
    { app: 'claude-code', device: 'nas', reason: 'endpoint_not_bound' },
    { app: 'mac-pi', device: 'imac', reason: 'device_unregistered' },
    { app: 'karakeep', device: 'ghost', reason: 'device_unregistered' },
  ]);
  assert.deepEqual(keyDeviceMismatches(keys, parseRegistry(JSON.stringify(DIST))), [], 'v1 不校验');
});

test('validateConfig：keys[].device 校验，(app, device) 组合唯一', () => {
  const base = (keys) => ({ gateway: { keys }, providers: [{ id: 'p', type: 'openai', baseUrl: 'https://x/v1/chat/completions', apiKeyRef: 'env:K', models: ['m'] }], jobs: { activate: { enabled: false } } });
  const cfg = validateConfig(base([{ key: 'a', app: 'claude-code', device: 'mac-mini' }, { key: 'b', app: 'claude-code', device: 'macbook' }]));
  assert.deepEqual(cfg.gateway.keys.map((k) => `${k.app}@${k.device}`), ['claude-code@mac-mini', 'claude-code@macbook']);
  assert.throws(() => validateConfig(base([{ key: 'a', app: 'claude-code', device: 'mac-mini' }, { key: 'b', app: 'claude-code', device: 'mac-mini' }])), /duplicate app/);
  assert.throws(() => validateConfig(base([{ key: 'a', app: 'claude-code', device: 'Mac Mini' }])), /device/);
});
