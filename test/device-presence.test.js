// device-presence.test.js — MG27：设备心跳鉴权（设备 token / 入网 key）、在场视图、admin 详情、设备改名迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../src/auth.js';
import { createRequestHandler } from '../src/gateway/router.js';
import { validateConfig } from '../src/config.js';
import { EventLog } from '../src/events.js';
import { UsageLog } from '../src/monitor/store.js';
import { AgentEndpoints } from '../src/monitor/agent-endpoints.js';
import { buildDeviceView, normalizeHeartbeat } from '../src/monitor/devices.js';

process.env.MG27_ADMIN = 'mg27-admin';
process.env.MG27_DEVICE = 'mg27-device-mini';
process.env.MG27_ENROLL = 'mg27-enroll';

const DIST = {
  version: 2,
  agents: { 'claude-code': { label: 'Claude Code', icon: 'claudecode' }, codex: { label: 'Codex', icon: 'codex' } },
  devices: {
    'mac-mini': { label: 'Mac mini', platform: 'mac' },
    macbook: { label: 'MacBook', platform: 'mac', match: { uuid: 'UUID-BOOK-0001' } },
  },
  endpoints: { 'claude-code': { agent: 'claude-code', devices: ['mac-mini', 'macbook'], dir: '~/.claude/skills' } },
  skills: {},
};

async function setup(t, { now = () => Date.now() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mg27-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'distribution.json');
  writeFileSync(file, JSON.stringify(DIST));
  const config = validateConfig({
    gateway: { keys: ['k'], adminKeyRef: 'env:MG27_ADMIN' },
    providers: [{ id: 'p', type: 'openai', baseUrl: 'https://x/v1/chat/completions', apiKeyRef: 'env:K', models: ['m'] }],
    jobs: { activate: { enabled: false } },
    observedUsage: { enabled: true, enrollKeyRef: 'env:MG27_ENROLL', devices: [{ name: 'mac-mini', keyRef: 'env:MG27_DEVICE' }] },
  });
  const usageLog = new UsageLog({ file: null, now });
  const agentEndpoints = new AgentEndpoints({ file }).load();
  const events = new EventLog(20);
  const handler = createRequestHandler({ config, catalog: { providers: [] }, events, usageLog, agentEndpoints, auth: createAuth(config, { events }) });
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.9', configurable: true });
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, { key, body, method = body ? 'POST' : 'GET' } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { call, usageLog };
}

const beat = (uuid, extra = {}) => ({ uuid, hostname: `host-${uuid.slice(-4)}.local`, model: 'Mac18,5', platform: 'mac', os: 'macOS 27.0', agents: [{ agent: 'claude-code', path: '/Users/x/.claude' }, { agent: 'codex', path: '/Users/x/.codex' }], ...extra });

test('入网 key 只能发心跳（待注册），不能推用量、不能读数据；设备 token 绑定设备名', async (t) => {
  const { call } = await setup(t);
  const enrolled = await call('/internal/devices/heartbeat', { key: 'mg27-enroll', body: beat('UUID-NEW-0001') });
  assert.equal(enrolled.status, 200);
  assert.deepEqual(await enrolled.json(), { ok: true, device: null, enrolled: false });
  assert.equal((await call('/internal/usage/observed', { key: 'mg27-enroll', body: { source: 'codex', events: [] } })).status, 403);
  assert.equal((await call('/internal/devices', { key: 'mg27-enroll' })).status, 403);
  const bound = await call('/internal/devices/heartbeat', { key: 'mg27-device-mini', body: beat('UUID-MINI-0001') });
  assert.deepEqual(await bound.json(), { ok: true, device: 'mac-mini', enrolled: true });
  assert.equal((await call('/internal/devices/heartbeat', { key: 'nope', body: beat('UUID-X-00001') })).status, 401);
  assert.equal((await call('/internal/devices/heartbeat', { key: 'mg27-enroll', body: { uuid: 'bad uuid!' } })).status, 400);
});

test('在场视图：注册表 uuid 待补时按 token 名匹配；看板视图不含 UUID / 路径；admin 视图含详情', async (t) => {
  const { call } = await setup(t);
  await call('/internal/devices/heartbeat', { key: 'mg27-device-mini', body: beat('UUID-MINI-0001', { converge: { ok: true, changed: 2, rev: 'abc123' } }) });
  await call('/internal/devices/heartbeat', { key: 'mg27-enroll', body: beat('UUID-NEW-0001') });
  const board = await (await call('/internal/devices', { key: 'mg27-admin' })).json();
  const mini = board.devices.find((d) => d.id === 'mac-mini');
  assert.equal(mini.online, true);
  assert.deepEqual(mini.endpoints.map((e) => e.app), ['claude-code']);
  assert.deepEqual(mini.unboundAgents, [{ agent: 'codex' }]);
  assert.equal(board.devices.find((d) => d.id === 'macbook').online, false);
  assert.equal(board.unregistered.length, 1);
  assert.equal(board.unregistered[0].hostname, 'host-0001.local');
  assert.ok(!JSON.stringify(board).includes('UUID-'), '看板视图不下发硬件 UUID');
  assert.ok(!JSON.stringify(board).includes('/Users/x'), '看板视图不下发本机路径');
  const admin = await (await call('/admin/v1/devices', { key: 'mg27-admin' })).json();
  const aMini = admin.devices.find((d) => d.id === 'mac-mini');
  assert.equal(aMini.uuid, null);
  assert.equal(aMini.uuidPending, true);
  assert.equal(aMini.heartbeatUuid, 'UUID-MINI-0001');
  assert.equal(aMini.converge.changed, 2);
  assert.equal(admin.unregistered[0].uuid, 'UUID-NEW-0001');
  assert.equal(admin.unregistered[0].detected[0].path, '/Users/x/.claude');
  assert.equal((await call('/admin/v1/devices', { key: 'mg27-device-mini' })).status, 403);
});

test('离线判定：超过 offlineAfterSec 判离线；同 UUID 心跳只保留一行并刷新 lastSeen', () => {
  let t = 1_000_000;
  const log = new UsageLog({ file: null, now: () => t });
  log.upsertPresence({ uuid: 'UUID-BOOK-0001', device: 'macbook', payload: normalizeHeartbeat(beat('UUID-BOOK-0001')) });
  t += 600_000;
  log.upsertPresence({ uuid: 'UUID-BOOK-0001', device: 'macbook', payload: normalizeHeartbeat(beat('UUID-BOOK-0001')) });
  assert.equal(log.listPresence().length, 1);
  const registry = { version: 2, agents: [], devices: [{ id: 'macbook', label: 'MacBook', platform: 'mac', uuid: 'UUID-BOOK-0001' }] };
  const at = (ms) => buildDeviceView({ registry, presence: log.listPresence(), offlineAfterSec: 900, now: ms }).devices[0].online;
  assert.equal(at(t + 900_000), true);
  assert.equal(at(t + 900_001), false);
  assert.equal(log.listPresence()[0].firstSeen, new Date(1_000_000).toISOString());
});

test('renameDevice：明细改名、日聚合合并、dry-run 不写库、幂等', () => {
  const log = new UsageLog({ file: null });
  const ts = new Date().toISOString();
  const row = (device, eventId) => ({ ts, kind: 'observed', device, path: 'codex-local', client: 'codex', providerId: 'codex-local', model: 'gpt-x', eventId, reported: true, usage: { input: 10, output: 5 } });
  log.importSubscription([row('mac', 'e1'), row('mac', 'e2'), row('macbook', 'e3')]);
  assert.deepEqual(log.renameDevice('mac', 'macbook', { dryRun: true }), { records: 2, daily: 1 });
  assert.equal(log.queryDevices().some((d) => d.device === 'mac'), true);
  assert.deepEqual(log.renameDevice('mac', 'macbook'), { records: 2, daily: 1 });
  const today = log.queryDaily({ from: '2000-01-01', to: '2999-12-31' });
  assert.deepEqual(today.map((r) => `${r.device}:${r.records}:${r.usage.input}`), ['macbook:3:30']);
  assert.deepEqual(log.renameDevice('mac', 'macbook'), { records: 0, daily: 0 });
});

test('validateConfig：enrollKeyRef 只收 env 引用，offlineAfterSec 默认 900 且 ≥60', () => {
  const base = (observedUsage) => ({ gateway: { keys: ['k'] }, providers: [{ id: 'p', type: 'openai', baseUrl: 'https://x/v1/chat/completions', apiKeyRef: 'env:K', models: ['m'] }], jobs: { activate: { enabled: false } }, observedUsage });
  assert.equal(validateConfig(base({ enabled: true, apiKeyRef: 'env:A' })).observedUsage.offlineAfterSec, 900);
  assert.equal(validateConfig(base({ enabled: true, apiKeyRef: 'env:A', enrollKeyRef: 'env:E' })).observedUsage.enrollKeyRef, 'env:E');
  assert.throws(() => validateConfig(base({ enabled: true, apiKeyRef: 'env:A', enrollKeyRef: 'literal' })), /enrollKeyRef/);
  assert.throws(() => validateConfig(base({ enabled: true, apiKeyRef: 'env:A', offlineAfterSec: 10 })), /offlineAfterSec/);
});

test('评审修复：已绑定 UUID 不能被入网 key / 其他设备 token 覆盖；未注册行有上限；精简视图不含 os / 钩子错误 / 注册设备 hostname', async (t) => {
  const { call, usageLog } = await setup(t);
  await call('/internal/devices/heartbeat', { key: 'mg27-device-mini', body: beat('UUID-MINI-0001', { converge: { ok: false, error: "fatal: cannot change to '/Users/secret/skills'" } }) });
  assert.equal((await call('/internal/devices/heartbeat', { key: 'mg27-enroll', body: beat('UUID-MINI-0001') })).status, 409);
  assert.equal(usageLog.listPresence()[0].device, 'mac-mini');
  const board = await (await call('/internal/devices', { key: 'mg27-admin' })).json();
  const text = JSON.stringify(board);
  for (const leak of ['/Users/secret', 'macOS 27.0', 'host-0001.local']) assert.ok(!text.includes(leak), leak);
  assert.equal(board.devices.find((d) => d.id === 'mac-mini').converge.ok, false);
  const admin = await (await call('/admin/v1/devices', { key: 'mg27-admin' })).json();
  assert.match(admin.devices.find((d) => d.id === 'mac-mini').converge.error, /secret/);
  const log = new UsageLog({ file: null });
  for (let i = 0; i < 50; i++) assert.equal(log.upsertPresence({ uuid: `UUID-RAND-${String(i).padStart(4, '0')}`, payload: {} }).ok, true);
  assert.deepEqual(log.upsertPresence({ uuid: 'UUID-RAND-9999', payload: {} }), { ok: false, reason: 'too_many_unregistered' });
  assert.equal(log.upsertPresence({ uuid: 'UUID-RAND-0001', payload: {} }).ok, true, '已有行仍可刷新');
});

test('评审修复：注册 UUID 命中但心跳来自其他设备 token → 不匹配', () => {
  const registry = { version: 2, agents: [], devices: [{ id: 'macbook', label: 'MacBook', platform: 'mac', uuid: 'U-BOOK-0001' }] };
  const presence = [{ uuid: 'U-BOOK-0001', device: 'mac-mini', lastMs: Date.now(), lastSeen: new Date().toISOString(), payload: {} }];
  const view = buildDeviceView({ registry, presence });
  assert.equal(view.devices[0].online, false);
  assert.equal(view.unregistered.length, 1);
});

test('assignServedDevice：按 client 回填历史 served 设备；截止日当天按明细拆分；dry-run 不写；幂等', () => {
  const log = new UsageLog({ file: null });
  const rec = (ts, client, input) => ({ ts, kind: 'served', path: '/v1/chat/completions', client, providerId: 'p', model: 'm', status: 200, ok: true, reported: true, usage: { input, output: 1 } });
  log.record(rec('2026-11-04T10:00:00+08:00', 'mac-pi', 10));
  log.record(rec('2026-11-06T00:10:00+08:00', 'mac-pi', 20));   // 截止日当天、截止前 → 归 macbook
  log.record(rec('2026-11-06T09:00:00+08:00', 'mac-pi', 40));   // 截止后 → 留 gateway
  log.record(rec('2026-11-05T10:00:00+08:00', 'pi-agent', 5));
  log.record(rec('2026-11-05T11:00:00+08:00', 'shared', 7));
  const rules = [{ client: 'pi-agent', device: 'nas' }, { client: 'mac-pi', device: 'macbook', before: '2026-11-06T00:40:00+08:00' }];
  assert.deepEqual(log.assignServedDevice(rules, { dryRun: true }).map((r) => [r.client, r.records, r.daily]), [['pi-agent', 1, 1], ['mac-pi', 2, 1]]);
  assert.ok(log.buf.every((r) => r.device === 'gateway'));
  log.assignServedDevice(rules);
  assert.deepEqual(log.buf.map((r) => `${r.client}@${r.device}`), ['mac-pi@macbook', 'pi-agent@nas', 'shared@gateway', 'mac-pi@macbook', 'mac-pi@gateway']);
  const daily = log.queryDaily({ from: '2026-11-01', to: '2026-11-30' }).map((r) => `${r.day} ${r.client}@${r.device} n=${r.records} in=${r.usage.input}`).sort();
  assert.deepEqual(daily, [
    '2026-11-04 mac-pi@macbook n=1 in=10',
    '2026-11-05 pi-agent@nas n=1 in=5',
    '2026-11-05 shared@gateway n=1 in=7',
    '2026-11-06 mac-pi@gateway n=1 in=40',
    '2026-11-06 mac-pi@macbook n=1 in=20',
  ]);
  assert.deepEqual(log.assignServedDevice(rules).map((r) => r.records), [0, 0]);
});
