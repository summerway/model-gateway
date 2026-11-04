// agent-endpoints.test.js — MG8：distribution.json → Agent 映射（类型推导、过期保留、/internal/keys 下发）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEndpoints, parseAgentEndpoints, iconKindOf } from '../src/monitor/agent-endpoints.js';
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
  assert.deepEqual(body.keys[0].agent, { app: 'pi-agent', iconKind: 'pi', location: 'cloud' });
});
