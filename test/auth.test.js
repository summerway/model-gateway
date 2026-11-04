import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../src/auth.js';
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequestHandler } from '../src/gateway/router.js';
import { validateConfig } from '../src/config.js';
import { parseYaml } from '../src/yaml.js';
import { loadConfigSchema, validateSchema } from '../src/config-schema.js';
import { EventLog } from '../src/events.js';

// Synthetic test credentials, isolated to this test process.
process.env.MG13_ADMIN = 'test-admin';
process.env.MG13_ACCESS = 'test-access';
process.env.MG13_DEVICE = 'test-device';
process.env.MG13_OLD = 'test-old';
const tokenConfig = (dashboard = true) => ({
  gateway: { keys: [], adminKeyRef: 'env:MG13_ADMIN' },
  dashboard: dashboard ? { accessKeyRef: 'env:MG13_ACCESS' } : {},
  observedUsage: { enabled: true, apiKeyRef: 'env:MG13_OLD', devices: [{ name: 'mac-mini', keyRef: 'env:MG13_DEVICE' }] },
});
const bearer = (key) => ({ authorization: `Bearer ${key}` });
const request = (method = 'GET', headers = {}, remoteAddress = '203.0.113.1', url = '/') => ({ method, headers, socket: { remoteAddress }, url });

async function gateway(t, config = tokenConfig(), options = {}) {
  const events = new EventLog(50);
  const imported = [];
  const delays = [];
  let time = Date.now();
  const auth = createAuth(config, { events, now: () => time, sleep: async (ms) => { delays.push(ms); } });
  const handler = createRequestHandler({ config, catalog: { providers: [] }, events,
    inboxStore: options.inboxStore,
    ...(options.defaultAuth ? {} : { auth }),
    ...(options.usage ? { usageLog: { importSubscription: (rows) => { imported.push(...rows); return rows.length; } } } : {}),
  });
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: options.remote ?? '203.0.113.1', configurable: true });
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const get = (path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: 'manual', ...init });
  const login = (key = 'test-access', path = '/login?next=/', headers = {}) => get(path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ key }),
  });
  return { auth, events, imported, delays, get, login, expire: () => { time += 31 * 86400000; } };
}

test('legacy keeps private IP trust and public pages', async (t) => {
  const gw = await gateway(t, { gateway: { keys: [] } }, { remote: '192.168.1.2' });
  assert.equal(gw.auth.mode, 'legacy');
  assert.equal((await gw.get('/internal/quota')).status, 200);
  assert.equal((await gw.get('/')).status, 200);
  const publicGw = await gateway(t, { gateway: { keys: [] } }, { defaultAuth: true });
  assert.equal((await publicGw.get('/internal/quota')).status, 403);
  assert.equal((await publicGw.get('/')).status, 200);
});

test('token mode requires admin Bearer regardless of IP and resolves env on every request', async (t) => {
  const gw = await gateway(t);
  assert.equal((await gw.get('/internal/quota')).status, 401);
  assert.equal((await gw.get('/internal/quota', { headers: bearer('wrong') })).status, 401);
  assert.equal((await gw.get('/internal/quota', { headers: { 'x-api-key': 'test-admin' } })).status, 401);
  assert.equal((await gw.get('/internal/quota', { headers: bearer('test-admin') })).status, 200);
  assert.equal(gw.events.buf.some((e) => e.type === 'security_legacy_ip_trust'), false);
  process.env.MG13_ADMIN = 'rotated-admin';
  try {
    assert.equal((await gw.get('/internal/quota', { headers: bearer('test-admin') })).status, 401);
    assert.equal((await gw.get('/internal/quota', { headers: bearer('rotated-admin') })).status, 200);
  } finally { process.env.MG13_ADMIN = 'test-admin'; }
  const local = await gateway(t, tokenConfig(), { remote: '127.0.0.1', defaultAuth: true });
  assert.equal((await local.get('/internal/quota')).status, 401);
});

test('device tokens bind observed device, restrict paths and accept the old alias', async (t) => {
  const gw = await gateway(t, tokenConfig(), { usage: true });
  const ev = { id: 'a'.repeat(64), ts: new Date().toISOString(), model: 'gpt-6-sol', client: 'cli', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  const post = (key, device, path = '/internal/usage/observed') => gw.get(path, { method: 'POST', headers: { ...bearer(key), 'content-type': 'application/json' }, body: JSON.stringify({ source: 'codex', device, events: [ev] }) });
  assert.equal((await post('test-device', 'evil')).status, 200);
  assert.equal(gw.imported.at(-1).device, 'mac-mini');
  assert.equal((await post('test-device', 'evil', '/internal/usage/codex')).status, 200);
  assert.equal(gw.imported.at(-1).device, 'mac-mini');
  assert.equal((await gw.get('/internal/quota', { headers: bearer('test-device') })).status, 403);
  assert.equal((await gw.get('/internal/usage/observed', { headers: bearer('test-device') })).status, 403);
  assert.equal((await post('test-old', 'laptop')).status, 200);
  assert.equal(gw.imported.at(-1).device, 'laptop');
  assert.equal((await post('test-old')).status, 200);
  assert.equal(gw.imported.at(-1).device, 'mac');
  assert.equal((await post('test-admin', 'admin-device')).status, 200);
  assert.equal(gw.imported.at(-1).device, 'admin-device');
  assert.equal((await gw.get('/internal/quota', { headers: bearer('test-old') })).status, 403);
});

test('legacy device tokens still require a private address and bind the device', async (t) => {
  const config = tokenConfig(false);
  delete config.gateway.adminKeyRef;
  const gw = await gateway(t, config, { remote: '10.0.0.1', usage: true });
  const ev = { id: 'b'.repeat(64), ts: new Date().toISOString(), model: 'gpt-6-sol', client: 'cli', usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const init = { method: 'POST', headers: { ...bearer('test-device'), 'content-type': 'application/json' }, body: JSON.stringify({ source: 'codex', device: 'evil', events: [ev] }) };
  assert.equal((await gw.get('/internal/usage/observed', init)).status, 200);
  assert.equal(gw.imported[0].device, 'mac-mini');
  const publicGw = await gateway(t, config, { usage: true });
  assert.equal((await publicGw.get('/internal/usage/observed', init)).status, 403);
});

test('login cookie permits reads and Inbox POST only; logout and invalid sessions fail', async (t) => {
  const gw = await gateway(t);
  const response = await gw.login('test-access', '/login?next=/', { 'x-forwarded-proto': 'https' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const setCookie = response.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000', 'Secure']) assert.ok(setCookie.includes(flag));
  const cookie = setCookie.split(';')[0];
  assert.equal((await gw.get('/internal/dashboard', { headers: { cookie } })).status, 200);
  assert.equal((await gw.get('/', { headers: { cookie } })).status, 200);
  assert.equal((await gw.get('/internal/quota', { method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await gw.get('/internal/usage/observed', { method: 'POST', headers: { cookie } })).status, 403);
  assert.deepEqual(gw.auth.gateInternal(request('POST', { cookie }), '/internal/inbox/apply'), { ok: true });
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal(gw.auth.gateInternal(request(method, { cookie }), '/internal/inbox/apply').status, 403);
  assert.equal(gw.auth.gateInternal(request('POST', { cookie }), '/internal/inbox-evil').status, 403);
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0');
  assert.equal((await gw.get('/internal/dashboard', { headers: { cookie: tampered } })).status, 401);
  assert.equal((await gw.get('/', { headers: { cookie: tampered } })).status, 302);
  const logout = await gw.get('/logout');
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), '/login');
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  gw.expire();
  assert.equal((await gw.get('/internal/dashboard', { headers: { cookie } })).status, 401);
  assert.equal((await gw.get('/', { headers: { cookie } })).status, 302);
});

test('login failure delays via injected sleep, unsafe next is ignored and key rotation invalidates cookies', async (t) => {
  const gw = await gateway(t);
  const failed = await gw.login('wrong');
  assert.equal(failed.status, 401);
  assert.match(await failed.text(), /口令不正确/);
  assert.deepEqual(gw.delays, [1000]);
  const form = await gw.get('/login?next=//evil.com');
  assert.equal(form.status, 200);
  assert.match(await form.text(), /输入访问口令/);
  const response = await gw.login('test-access', '/login?next=//evil.com');
  assert.equal(response.headers.get('location'), '/');
  assert.doesNotMatch(response.headers.get('set-cookie'), /Secure/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  process.env.MG13_ACCESS = 'rotated-access';
  try {
    assert.equal((await gw.get('/internal/dashboard', { headers: { cookie } })).status, 401);
    assert.equal((await gw.login('rotated-access')).status, 303);
  } finally { process.env.MG13_ACCESS = 'test-access'; }
});

test('page gates support loopback only without accessKeyRef, login redirects and public assets', async (t) => {
  const gw = await gateway(t, tokenConfig(false), { remote: '127.0.0.1' });
  assert.equal((await gw.get('/')).status, 200);
  const privateGw = await gateway(t, tokenConfig(false), { remote: '192.168.1.2' });
  assert.equal((await privateGw.get('/')).status, 403);
  assert.equal((await privateGw.get('/dashboard/assets/topology.css')).status, 200);
  assert.equal((await privateGw.get('/favicon.png')).status, 200);
  assert.equal((await privateGw.get('/login')).status, 200);
  for (const address of ['::1', '::ffff:127.0.0.1']) assert.equal(gw.auth.gatePage(request('GET', {}, address), '/').ok, true);
  const locked = await gateway(t);
  for (const path of ['/', '/console', '/dashboard', '/usage', '/keys', '/inbox']) {
    const response = await locked.get(path);
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'), 'http://internal');
    assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('next'), path);
  }
  const legacy = await gateway(t, { gateway: { keys: [] }, dashboard: tokenConfig().dashboard }, { remote: '10.0.0.1' });
  assert.equal((await legacy.get('/')).status, 302);
  assert.equal((await legacy.get('/internal/dashboard')).status, 200);
});

test('legacy standalone pages are gated first, then 301-redirected to console views with query dropped', async (t) => {
  // MG24：/usage、/keys、/inbox 旧独立页下线；过门控后 301 到看板对应 hash 视图
  const gw = await gateway(t, { gateway: { keys: [] } }, { remote: '192.168.1.2' });
  for (const [path, location] of [['/usage', '/#usage-summary'], ['/keys', '/#gateway-keys'], ['/inbox', '/#gateway-suggestions']]) {
    const response = await gw.get(`${path}?item=abc&range=7d`);
    assert.equal(response.status, 301, `${path} 应 301`);
    assert.equal(response.headers.get('location'), location, `${path} 定位到看板视图且丢弃查询串`);
    assert.match(response.headers.get('cache-control'), /no-cache/);
  }
});

test('dashboard.public opens pages and reads; Inbox POST only from private origin; writes still need keys', async (t) => {
  const config = { ...tokenConfig(false), dashboard: { public: true } };
  // 反代后面：直连方是内网代理，真实来源看 X-Real-IP
  const proxied = await gateway(t, config, { remote: '172.18.0.5' });
  assert.equal((await proxied.get('/')).status, 200);
  assert.equal((await proxied.get('/internal/dashboard')).status, 200);
  assert.equal((await proxied.get('/internal/quota', { headers: { 'x-real-ip': '203.0.113.9' } })).status, 200);
  assert.equal((await proxied.get('/admin/v1/status')).status, 401);
  assert.equal((await proxied.get('/internal/activator/claude/claim', { method: 'POST' })).status, 401);
  assert.equal((await proxied.get('/internal/usage/observed', { method: 'POST' })).status, 401);
  assert.equal((await proxied.get('/internal/dashboard', { headers: bearer('wrong') })).status, 401);
  const inbox = (headers) => proxied.auth.gateInternal(request('POST', headers, '172.18.0.5'), '/internal/inbox/apply');
  assert.equal(inbox({ 'x-real-ip': '192.168.1.20' }).ok, true);
  assert.equal(inbox({}).ok, true);
  assert.equal(inbox({ 'x-real-ip': '203.0.113.9' }).ok, false);
  const force = (ip) => proxied.auth.gateInternal({ ...request('GET', { 'x-real-ip': ip }, '172.18.0.5'), url: '/internal/dashboard?force=all' }, '/internal/dashboard');
  assert.equal(force('192.168.1.20').ok, true);
  assert.equal(force('203.0.113.9').ok, false);
  // 直连公网：不采信它自带的 X-Real-IP
  const direct = await gateway(t, config, { remote: '203.0.113.1' });
  assert.equal(direct.auth.gateInternal(request('POST', { 'x-real-ip': '10.0.0.1' }, '203.0.113.1'), '/internal/inbox/apply').ok, false);
  assert.equal((await direct.get('/')).status, 200);
  assert.throws(() => validateConfig({ gateway: { keys: ['k'] }, providers: [{ id: 'p', type: 'openai', baseUrl: 'https://x/v1/chat/completions', apiKeyRef: 'env:X', models: ['m'] }], jobs: { activate: { enabled: false } }, dashboard: { public: 'yes' } }), /dashboard.public/);
});

test('health is public in both modes and reads package version', async (t) => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const config of [tokenConfig(), { gateway: { keys: [] } }]) {
    const gw = await gateway(t, config);
    const response = await gw.get('/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, version });
  }
});

test('cookie Inbox POST still requires the existing Origin and CSRF checks', async (t) => {
  const inboxStore = { csrf: 'test-csrf', preview: () => ({ ok: true }) };
  const gw = await gateway(t, tokenConfig(), { inboxStore });
  const login = await gw.login();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const origin = new URL(login.url).origin;
  const post = (headers = {}) => gw.get('/internal/inbox/preview', { method: 'POST',
    headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id: 'test', action: 'test' }),
  });
  assert.equal((await post()).status, 403);
  assert.equal((await post({ origin: 'http://evil.example', 'x-inbox-csrf': 'test-csrf' })).status, 403);
  assert.equal((await post({ origin, 'x-inbox-csrf': 'test-csrf' })).status, 200);
});

test('server startup records exactly one legacy security event', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg13-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = readFileSync(new URL('../config/demo/config.yaml', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'config.yaml'), config.replace('port: 8080', 'port: 0'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url),
    env: { ...process.env, MODEL_GATEWAY_DEMO: '1', MODEL_GATEWAY_CONFIG_DIR: dir, EVENT_LOG_FILE: join(dir, 'events.jsonl') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}`)), 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`startup exited: ${code}: ${output}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  for (let i = 0; i < 2; i++) {
    const { events } = await (await fetch(base + '/internal/events')).json();
    const warnings = events.filter((e) => e.type === 'security_legacy_ip_trust');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].hint, '配置 gateway.adminKeyRef 以启用 token 鉴权');
  }
});

test('auth configuration survives normalization and rejects malformed refs and devices', () => {
  const example = parseYaml(readFileSync(new URL('../config/config.example.yaml', import.meta.url), 'utf8'));
  const raw = { ...example, ...tokenConfig(), gateway: { ...example.gateway, adminKeyRef: 'env:MG13_ADMIN' } };
  const out = validateConfig(raw);
  assert.equal(out.gateway.adminKeyRef, raw.gateway.adminKeyRef);
  assert.deepEqual(out.dashboard, raw.dashboard);
  assert.deepEqual(out.observedUsage.devices, raw.observedUsage.devices);
  assert.deepEqual(validateSchema(loadConfigSchema(), raw), []);
  const devicesOnly = structuredClone(raw);
  delete devicesOnly.observedUsage.apiKeyRef;
  assert.doesNotThrow(() => validateConfig(devicesOnly));
  const legacyAlias = structuredClone(devicesOnly);
  legacyAlias.codexUsage = legacyAlias.observedUsage;
  delete legacyAlias.observedUsage;
  assert.deepEqual(validateConfig(legacyAlias).observedUsage.devices, raw.observedUsage.devices);
  const cases = [
    (c) => { c.gateway.adminKeyRef = 'literal'; },
    (c) => { c.dashboard.accessKeyRef = 'env:KEY:default'; },
    (c) => { c.dashboard = []; },
    (c) => { c.observedUsage.devices = {}; },
    (c) => { c.observedUsage.devices[0].name = 'Bad Device'; },
    (c) => { c.observedUsage.devices.push({ ...c.observedUsage.devices[0] }); },
    (c) => { c.observedUsage.devices[0].keyRef = 'literal'; },
    (c) => { c.observedUsage = { enabled: true, devices: [] }; },
  ];
  for (const mutate of cases) {
    const invalid = structuredClone(raw);
    mutate(invalid);
    assert.throws(() => validateConfig(invalid));
  }
});
