import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigChanges } from '../src/admin/config-changes.js';
import { createRequestHandler } from '../src/gateway/router.js';
import { validateConfig } from '../src/config.js';
import { ModelInbox } from '../src/ops/model-inbox.js';
import { EventLog } from '../src/events.js';
import { UsageLog } from '../src/monitor/store.js';

process.env.MG14_ADMIN = 'synthetic-admin';
process.env.MG14_DEVICE = 'synthetic-device';
process.env.MG14_ACCESS = 'synthetic-access';
const rawConfig = () => ({
  gateway: { adminKeyRef: 'env:MG14_ADMIN', keys: [{ key: 'env:MG14_GATEWAY', app: 'cli' }] },
  dashboard: { accessKeyRef: 'env:MG14_ACCESS' },
  providers: [{ id: 'codex', type: 'codex', models: ['gpt-6-sol'] }],
  jobs: { probe: { intervalSec: 300 }, activate: { enabled: false } },
  observedUsage: { enabled: true, devices: [{ name: 'mac-mini', keyRef: 'env:MG14_DEVICE' }] },
});
const addModel = [{ op: 'add', path: '/providers/0/models/-', value: 'gpt-6-luna' }];

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mg14-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = options.raw ?? rawConfig();
  const configPath = join(dir, options.yaml ? 'config.yaml' : 'config.json');
  const original = options.yaml
    ? 'gateway:\n  keys:\n    - env:MG14_GATEWAY\nproviders:\n  - id: codex\n    type: codex\n    models:\n      - gpt-6-sol\njobs:\n  activate:\n    enabled: false\n'
    : JSON.stringify(raw, null, 2) + '\n';
  writeFileSync(configPath, original, { mode: 0o640 });
  const config = validateConfig(raw);
  const catalog = { providers: config.providers };
  const events = new EventLog(100, { file: null });
  const inbox = new ModelInbox({ file: join(dir, 'inbox.json'), configPath, events });
  let time = Date.now();
  let reloads = 0;
  let reloadOk = true;
  const configChanges = new ConfigChanges({ configPath, stateFile: inbox.file, events,
    serial: fn => inbox.serial(fn), now: () => time,
    reloadCatalog: async () => {
      reloads++;
      if (reloadOk && !options.yaml) catalog.providers = validateConfig(JSON.parse(readFileSync(configPath, 'utf8'))).providers;
      return reloadOk;
    },
  });
  const usageLog = new UsageLog({ file: null, dbFile: null });
  t.after(() => usageLog.close());
  const handler = createRequestHandler({ config, catalog, events, configChanges, inboxStore: inbox, usageLog });
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: options.remote ?? '203.0.113.1', configurable: true });
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = async (path, { method = 'GET', body, token = 'synthetic-admin', headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/v1${path}`, {
      method, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { dir, configPath, original, configChanges, request, inbox, events, usageLog,
    reloads: () => reloads, failReload: () => { reloadOk = false; }, expire: () => { time += 15 * 60 * 1000; } };
}
const preview = (f, patch = addModel) => f.request('/config/changes', { method: 'POST', body: { patch, reason: 'test change' } });
const apply = (f, id) => f.request(`/config/changes/${id}/apply`, { method: 'POST' });
const expectError = (result, status, code) => {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
  assert.equal(typeof result.body.error.message, 'string');
  assert.equal(typeof result.body.error.details, 'object');
};

test('legacy rejects Admin status; contract remains public in both modes', async t => {
  const raw = rawConfig(); delete raw.gateway.adminKeyRef;
  const f = await fixture(t, { raw, remote: '127.0.0.1' });
  const denied = await f.request('/status');
  expectError(denied, 403, 'admin_key_required');
  assert.equal(denied.body.error.details.hint, '配置 gateway.adminKeyRef 后启用 Admin API');
  assert.equal((await f.request('/openapi.json', { token: null })).body.openapi, '3.1.0');
});

test('token mode requires admin Bearer and rejects cookies and device tokens for reads', async t => {
  const f = await fixture(t);
  expectError(await f.request('/status', { token: null }), 401, 'unauthorized');
  expectError(await f.request('/status', { token: 'wrong' }), 401, 'unauthorized');
  expectError(await f.request('/status', { token: 'synthetic-device' }), 403, 'forbidden');
  // A correctly signed dashboard session still cannot authorize Admin.
  const { createHmac } = await import('node:crypto');
  const exp = Date.now() + 60000;
  const signed = createHmac('sha256', 'synthetic-access').update(String(exp)).digest('hex');
  expectError(await f.request('/status', { token: null, headers: { cookie: `mg_session=${exp}.${signed}` } }), 401, 'unauthorized');
  const status = await f.request('/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.mode, 'token');
  assert.equal(status.body.format, 'json');
  assert.equal(status.body.writable, true);
  assert.equal((await f.request('/openapi.json', { token: null })).status, 200);
});

test('effective config redacts literals and preserves env references without resolving', async t => {
  const raw = rawConfig();
  raw.gateway.keys.push({ key: 'synthetic-literal', app: 'test' });
  const f = await fixture(t, { raw });
  const result = await f.request('/config');
  assert.equal(result.body.config.gateway.keys[0].key, 'env:MG14_GATEWAY');
  assert.equal(result.body.config.gateway.keys[1].key, '***');
  assert.equal(result.body.config.gateway.adminKeyRef, 'env:MG14_ADMIN');
  assert.ok(!JSON.stringify(result.body).includes('synthetic-literal'));
  assert.ok(!JSON.stringify(result.body).includes('synthetic-admin'));
});

test('preview then apply backs up JSON, reloads providers, preserves permissions and records event', async t => {
  const f = await fixture(t);
  const p = await preview(f);
  assert.equal(p.status, 200);
  assert.equal(p.body.restartRequired, false);
  assert.deepEqual(p.body.diff, [{ path: '/providers/0/models/1', before: null, after: 'gpt-6-luna' }]);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
  const result = await apply(f, p.body.changeId);
  assert.equal(result.status, 200);
  assert.equal(readFileSync(join(f.dir, result.body.backup), 'utf8'), f.original);
  assert.match(result.body.backup, /\.json$/);
  assert.equal(f.reloads(), 1);
  assert.equal(statSync(f.configPath).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')).providers[0].models, ['gpt-6-sol', 'gpt-6-luna']);
  const event = f.events.buf.find(e => e.type === 'admin_config_applied');
  assert.equal(event.changeId, p.body.changeId);
  assert.equal(event.reason, 'test change');
  assert.deepEqual(event.paths, ['/providers/0/models/-']);
  assert.equal((await f.request('/models')).body.data.length, 2);
  const jobs = await preview(f, [{ op: 'replace', path: '/jobs/probe/intervalSec', value: 600 }]);
  assert.equal(jobs.body.restartRequired, true);
  assert.ok(jobs.body.warnings.length);
});

test('invalid patch, failed test, secret literals, invalid config and malformed body use structured errors', async t => {
  const f = await fixture(t);
  expectError(await preview(f, [{ op: 'replace', path: '/missing', value: 1 }]), 400, 'patch_invalid');
  expectError(await preview(f, [{ op: 'test', path: '/providers/0/id', value: 'other' }]), 409, 'patch_test_failed');
  for (const [path, value] of [
    ['/providers/0/apiKeyRef', 'literal'], ['/gateway/keys/0/key', 'literal'], ['/otherRef', 'literal'],
  ]) expectError(await preview(f, [{ op: 'add', path, value }]), 422, 'secret_literal_forbidden');
  expectError(await preview(f, [{ op: 'replace', path: '/providers', value: [] }]), 422, 'config_invalid');
  expectError(await f.request('/config/changes', { method: 'POST', body: null }), 400, 'patch_invalid');
});

test('expired or unknown changes cannot apply', async t => {
  const f = await fixture(t);
  const p = await preview(f);
  f.expire();
  expectError(await apply(f, p.body.changeId), 404, 'change_not_found');
  expectError(await apply(f, 'missing'), 404, 'change_not_found');
  assert.equal(f.reloads(), 0);
});

test('apply detects external file edits', async t => {
  const f = await fixture(t);
  const p = await preview(f);
  writeFileSync(f.configPath, f.original + '\n');
  expectError(await apply(f, p.body.changeId), 409, 'config_changed');
  assert.equal(f.reloads(), 0);
});

test('YAML can preview but apply returns migration hint', async t => {
  const f = await fixture(t, { yaml: true });
  const p = await preview(f);
  assert.equal(p.status, 200);
  const result = await apply(f, p.body.changeId);
  expectError(result, 409, 'config_readonly');
  assert.equal(result.body.error.details.hint, 'npm run config:migrate');
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
});

test('reload false restores file, reloads again, and records no successful apply', async t => {
  const f = await fixture(t);
  const p = await preview(f);
  f.failReload();
  expectError(await apply(f, p.body.changeId), 500, 'reload_failed');
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
  assert.equal(f.reloads(), 2);
  assert.equal(f.events.buf.some(e => e.type === 'admin_config_applied'), false);
});

test('rollback restores latest backup and rejects edits made after apply', async t => {
  const f = await fixture(t);
  let p = await preview(f);
  assert.equal((await apply(f, p.body.changeId)).status, 200);
  assert.equal((await f.request('/config/rollback', { method: 'POST' })).status, 200);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
  assert.ok(f.events.buf.some(e => e.type === 'admin_config_rollback'));
  p = await preview(f);
  await apply(f, p.body.changeId);
  const current = readFileSync(f.configPath, 'utf8') + '\n';
  writeFileSync(f.configPath, current);
  expectError(await f.request('/config/rollback', { method: 'POST' }), 409, 'config_changed');
  assert.equal(readFileSync(f.configPath, 'utf8'), current);
});

test('explicit reload records an event', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/reload', { method: 'POST' })).status, 200);
  assert.equal(f.reloads(), 1);
  assert.ok(f.events.buf.some(e => e.type === 'admin_reload'));
});

test('Inbox dismiss uses real preview/apply; Inbox errors retain status', async t => {
  const f = await fixture(t);
  await f.inbox.reconcile([{ providerId: 'codex', kind: 'upgrade', model: 'gpt-6-luna', old: 'gpt-6-sol' }]);
  const id = f.inbox.items[0].id;
  assert.equal((await f.request('/inbox')).body.pending, 1);
  const result = await f.request(`/inbox/${id}/dismiss`, { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(f.inbox.items[0].status, 'dismissed');
  expectError(await f.request(`/inbox/${id}/dismiss`, { method: 'POST' }), 409, 'inbox_error');
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
});

test('Admin writes wait for the shared Inbox transaction queue', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = f.inbox.serial(async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await ready;
  const p = f.configChanges.preview({ patch: addModel });
  const pending = f.configChanges.apply(p.changeId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reloads(), 0);
  assert.equal(readFileSync(f.configPath, 'utf8'), f.original);
  release(); await hold; await pending;
  assert.equal(f.reloads(), 1);
});

test('device token imports through the existing receiver and binds device identity', async t => {
  const f = await fixture(t);
  const body = { source: 'codex', device: 'evil', events: [{
    id: 'a'.repeat(64), ts: new Date().toISOString(), model: 'gpt-6-sol', client: 'cli',
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  }] };
  const post = () => f.request('/usage/observed', { method: 'POST', token: 'synthetic-device', body });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).body.imported, 0);
  const result = await f.request('/usage?range=today&groupBy=device,model&kind=observed&device=mac-mini&client=codex&provider=codex-local&model=gpt-6-sol');
  assert.equal(result.status, 200);
  assert.equal(result.body.rows.length, 1);
  assert.equal(result.body.rows[0].device, 'mac-mini');
  assert.equal(result.body.rows[0].usage.input, 10);
  const other = await f.request('/usage?range=today&groupBy=device&device=evil');
  assert.equal(other.body.rows.length, 0);
  expectError(await f.request('/usage?groupBy=invalid'), 400, 'request_failed');
});

test('read resources reuse internal snapshots without triggering quota refresh', async t => {
  const f = await fixture(t);
  for (const path of ['/providers?force=all', '/models', '/quota', '/usage?range=7d', '/events', '/inbox']) {
    const result = await f.request(path);
    assert.equal(result.status, 200, path + JSON.stringify(result.body));
  }
  expectError(await f.request('/nonexistent'), 404, 'not_found');
});

test('migration CLI handles yaml/yml, refuses existing targets, and keeps original backup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mg14-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const ext of ['yaml', 'yml']) {
    const source = join(dir, `config.${ext}`);
    const text = '# comment\nproviders:\n  - id: codex\n    type: codex\n    models:\n      - gpt-6-sol\n';
    writeFileSync(source, text);
    const cli = ext === 'yaml' ? ['scripts/config-migrate.js', dir] : ['bin/model-gateway.js', 'config', 'migrate', dir];
    const result = spawnSync(process.execPath, cli, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /YAML 注释不会保留/);
    assert.equal(readFileSync(source + '.bak', 'utf8'), text);
    assert.equal(existsSync(source), false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).providers[0].id, 'codex');
    writeFileSync(source, text);
    const conflict = spawnSync(process.execPath, cli, { encoding: 'utf8' });
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /already exists/);
    assert.equal(readFileSync(source, 'utf8'), text);
    rmSync(source); rmSync(source + '.bak'); rmSync(join(dir, 'config.json'));
  }
});
