// device-agent.test.js — MG28：指纹、agent 检测、前置钩子解析、collect 的入网模式与心跳顺序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAgents, fingerprint, runHook } from '../src/collect/device.js';
import { runCollect } from '../src/collect/index.js';

const exec = (table) => async (file, args) => table(file, args) ?? { code: 0, stdout: '', stderr: '' };

test('fingerprint：Mac 读 IOPlatformUUID 与 hw.model；DEVICE_UUID 覆盖；Linux 读 machine-id', async () => {
  const mac = await fingerprint({ platform: 'darwin', env: {}, exec: exec((f) => f.endsWith('ioreg')
    ? { code: 0, stdout: '  "IOPlatformUUID" = "ABCD-1234-EF"\n', stderr: '' }
    : { code: 0, stdout: 'Mac18,5\n', stderr: '' }) });
  assert.equal(mac.uuid, 'ABCD-1234-EF');
  assert.equal(mac.model, 'Mac18,5');
  assert.equal(mac.platform, 'mac');
  const linux = await fingerprint({ platform: 'linux', env: { DEVICE_PLATFORM: 'nas' }, readFile: () => 'deadbeef01\n' });
  assert.deepEqual([linux.uuid, linux.platform, linux.model], ['deadbeef01', 'nas', null]);
  assert.equal((await fingerprint({ platform: 'linux', env: { DEVICE_UUID: 'OVERRIDE-1' }, readFile: () => 'x' })).uuid, 'OVERRIDE-1');
});

test('detectAgents：~ 展开、任一路径存在即检测到；文件缺失或 v1 → []', () => {
  const dist = JSON.stringify({ version: 2, agents: { 'claude-code': { detect: ['~/.claude'] }, pi: { detect: ['~/.pi', '/share/Container/pi-agent'] }, codex: { detect: ['~/.codex'] } } });
  const present = new Set(['/home/u/.claude', '/share/Container/pi-agent']);
  assert.deepEqual(detectAgents({ file: '/d.json', home: '/home/u', readFile: () => dist, exists: (p) => present.has(p) }), [
    { agent: 'claude-code', path: '/home/u/.claude' }, { agent: 'pi', path: '/share/Container/pi-agent' },
  ]);
  assert.deepEqual(detectAgents({ file: '/d.json', home: '/h', readFile: () => { throw new Error('ENOENT'); } }), []);
  assert.deepEqual(detectAgents({ file: '/d.json', home: '/h', readFile: () => '{"endpoints":{}}' }), []);
  assert.deepEqual(detectAgents({ file: null, home: '/h' }), []);
});

test('runHook：解析 converge 报告的 ok / changed；失败带最后一行错误', async () => {
  const at = () => new Date('2026-11-06T00:00:00Z');
  const okRep = await runHook('x', { now: at, exec: exec(() => ({ code: 0, stdout: 'Already up to date.\n{\n "ok": true,\n "endpoints": {"a": {"changed": 2}, "b": {"changed": 1}}\n}\n', stderr: '' })) });
  assert.deepEqual(okRep, { ok: true, at: '2026-11-06T00:00:00.000Z', changed: 3 });
  const bad = await runHook('x', { now: at, exec: exec(() => ({ code: 2, stdout: '', stderr: 'error: this machine is not a registered device\n' })) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a registered device/);
  assert.equal(await runHook('', {}), null);
});

test('collect：只有入网 key → 钩子、心跳、不推用量；有设备 token → 心跳后推用量', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(String(url).replace(/^https?:\/\/[^/]+/, ''));
    const path = new URL(url).pathname;
    if (path === '/internal/devices/heartbeat') {
      const body = JSON.parse(init.body);
      assert.equal(body.uuid, 'UUID-TEST-0001');
      assert.equal(body.converge.ok, true);
      return new Response(JSON.stringify({ ok: true, device: null, enrolled: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: 0, imported: 0 }), { status: 200 });
  };
  const device = { exec: exec(() => ({ code: 0, stdout: '{"ok": true, "endpoints": {}}', stderr: '' })) };
  const logs = [];
  const base = { MODEL_GATEWAY_URL: 'http://gw.test', DEVICE_UUID: 'UUID-TEST-0001', COLLECT_PRE_HOOK: 'true', USAGE_SYNC_STATE_DIR: '/nonexistent-mg28' };
  const code = await runCollect({ argv: ['--once'], env: { ...base, DEVICE_ENROLL_KEY: 'enroll' }, fetchFn, requireEnvFile: false, log: (m) => logs.push(m), device });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['/internal/devices/heartbeat']);
  assert.ok(logs.some((l) => /待注册/.test(l)));
  await assert.rejects(runCollect({ argv: ['--once'], env: { MODEL_GATEWAY_URL: 'http://gw.test' }, fetchFn, requireEnvFile: false, log: () => {} }), /DEVICE_ENROLL_KEY/);
});
