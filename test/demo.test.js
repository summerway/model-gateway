import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { isDemo, installFetchGuard } from '../src/demo.js';
import { EventLog } from '../src/events.js';

test('demo is explicitly opt-in', () => {
  assert.equal(isDemo({}), false);
  for (const value of ['', '0', 'true']) assert.equal(isDemo({ MODEL_GATEWAY_DEMO: value }), false);
  assert.equal(isDemo({ MODEL_GATEWAY_DEMO: '1' }), true);
});

test('demo fetch guard blocks external URLs and redirects, permits loopback', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://example.com/redirected' });
      return res.end();
    }
    if (req.url === '/local-redirect') {
      res.writeHead(302, { location: '/ok' });
      return res.end();
    }
    res.end('local');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const events = new EventLog(50, { file: null });
  const restore = installFetchGuard(events);
  t.after(restore);
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(url)).text(), 'local');
  assert.equal(await (await fetch(new URL(url + '/local-redirect'))).text(), 'local');
  for (const target of ['https://example.com/private', 'http://localhost.example.com/', 'http://127.example.com/', new URL('http://192.0.2.1/'),
    new Request('https://example.com/request'), url + '/redirect']) {
    await assert.rejects(fetch(target), /external fetch blocked/);
  }
  assert.equal(events.list({ type: 'demo_fetch_blocked' }).length, 6);
});

test('demo server serves populated real dashboard APIs without outbound attempts', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-gateway-demo-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = await readFile(new URL('../config/demo/config.yaml', import.meta.url), 'utf8');
  await writeFile(join(dir, 'config.yaml'), text.replace('port: 8080', 'port: 0'));
  const env = { ...process.env, MODEL_GATEWAY_DEMO: '1', MODEL_GATEWAY_CONFIG_DIR: dir,
    // Any accidental pricing request hits the guard immediately, regardless of host setup.
    MODELS_DEV_URL: 'https://example.com/demo-must-not-fetch',
    USAGE_LOG_FILE: join(dir, 'should-not-write.jsonl'), USAGE_DB_FILE: join(dir, 'should-not-write.db'),
    EVENT_LOG_FILE: join(dir, 'events.jsonl'),
    MODEL_INBOX_STATE_FILE: join(dir, 'should-not-write-inbox.json'),
    MODEL_GUARD_STATE_FILE: join(dir, 'should-not-write-guard.json'),
    CLAUDE_USAGE_SYNC_STATE_FILE: join(dir, 'should-not-write-sync.json'),
  };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`demo startup timed out: ${output}`)), 10000);
    const exited = code => { clearTimeout(timer); reject(new Error(`demo exited (${code}): ${output}`)); };
    child.once('exit', exited);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.stdout.on('data', () => {
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.off('exit', exited);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
  });
  assert.match(output, /DEMO MODE/);
  const get = async path => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, `${path}: ${output}`);
    return response.json();
  };
  const daily = await get('/internal/usage/daily?groupBy=day');
  assert.ok(daily.rows.length >= 60);
  assert.ok(daily.rows.every(row => row.tokens > 0 && row.cost > 0 && row.costUnknownRecords === 0));
  const deviceData = await get('/internal/usage/devices');
  assert.deepEqual([...new Set(deviceData.devices.map(row => row.device))].sort(), ['linux-box', 'macbook', 'windows-pc']);
  const dashboard = await get('/internal/dashboard');
  assert.equal(dashboard.providers.length, 5);
  assert.ok(dashboard.providers.filter(p => p.quota).length >= 4);
  assert.equal(dashboard.providers.find(p => p.id === 'glm-coding').quota.fiveHour.usedPercent, 93);
  assert.ok(dashboard.providers.find(p => p.id === 'codex').healthy);
  const inbox = await get('/internal/inbox');
  assert.equal(inbox.pending, 1);
  assert.equal(inbox.items[0].kind, 'upgrade');
  assert.ok((await get('/internal/activator'))['glm-coding'].lastResetHandledAt);
  const served = await get('/internal/usage/daily?groupBy=client,provider,model&kind=served');
  assert.equal(new Set(served.rows.map(row => row.client)).size, 5);
  assert.equal(new Set(served.rows.map(row => row.provider)).size, 4);
  const observed = await get('/internal/usage/daily?groupBy=client&kind=observed');
  assert.deepEqual(observed.rows.map(row => row.client).sort(), ['claude-code', 'codex']);
  assert.ok(observed.rows.every(row => row.requests === 0));
  assert.ok((await get('/internal/usage/activity')).stats.activeDays >= 60);
  const usage = await get('/internal/usage?range=30d');
  assert.deepEqual(usage.pricingMissing, []);
  assert.ok(usage.totals.requests > 0);
  const keys = await get('/internal/keys');
  assert.equal(keys.topology.directConnections.length, 3);
  const topologyContext = {};
  runInNewContext(await readFile(new URL('../src/dashboard/topology.js', import.meta.url), 'utf8'), topologyContext);
  const topologyData = { ...keys, providers: dashboard.providers };
  const graph = topologyContext.MGTopology.build(topologyData);
  const markup = topologyContext.MGTopology.html(topologyData);
  for (const device of ['macbook', 'linux-box', 'windows-pc']) {
    assert.ok(graph.nodes.some(node => node.device === device));
    assert.ok(markup.includes(device));
  }
  assert.ok(!/NaN|undefined/.test(markup));
  // Refresh buttons and sidecar polling must also remain offline.
  assert.deepEqual((await get('/internal/dashboard?force=all')).refreshErrors, []);
  const claim = await fetch(base + '/internal/activator/claude/claim', { method: 'POST' });
  assert.equal(await claim.json(), null);
  const events = (await get('/internal/events')).events;
  assert.ok(events.some(event => event.type === 'fallback'));
  assert.ok(events.some(event => event.type === 'activation'));
  assert.ok(!events.some(event => event.type === 'demo_fetch_blocked'), output);
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('should-not-write')));
});
