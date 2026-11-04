// Observed source registry, normalized schema and receiver integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCES, sourceById, sourceByPath } from '../src/monitor/sources/index.js';
import { observedAllowed } from '../src/monitor/store.js';
import { createMonitorRoutes } from '../src/monitor/internal-routes.js';
import { validateSchema } from '../src/config-schema.js';
import { runCollect } from '../src/collect/index.js';

const schema = JSON.parse(readFileSync(new URL('../docs/schemas/observed-event.json', import.meta.url), 'utf8'));
const now = Date.now();
const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 };
const event = { id: 'a'.repeat(64), ts: new Date(now).toISOString(), model: 'claude-test', usage };
const normalized = () => sourceById('claude-code').validateBatch({ events: [event] }, { now, device: 'mac' })[0];

test('registry exposes both source ids and stored paths', () => {
  assert.deepEqual([...SOURCES.keys()], ['codex', 'claude-code']);
  assert.equal(sourceByPath('claude-code'), sourceById('claude-code'));
  assert.equal(sourceByPath('codex-local'), sourceById('codex'));
  assert.equal(sourceById('unknown'), undefined);
  assert.equal(sourceByPath('unknown'), undefined);
});

test('observedAllowed preserves official subscriptions and historical paths', () => {
  for (const [kind, path, model, expected] of [
    ['observed', 'claude-code', 'glm-5.3', false],
    ['observed', 'claude-code', 'claude-test', true],
    ['observed', 'claude-code', undefined, false],
    ['observed', 'codex-local', 'anything', true],
    ['observed', 'codex-local', undefined, true],
    ['observed', 'legacy-path', 'glm-5.3', true],
    ['served', 'claude-code', 'glm-5.3', true],
  ]) assert.equal(observedAllowed({ kind, path, model }), expected, `${kind}/${path}/${model}`);
});

test('source adapters produce schema-compliant rows from unchanged push bodies', () => {
  const claude = normalized();
  const codex = sourceById('codex').validateBatch({ events: [{ ...event, model: 'gpt-test', client: 'cli' }] }, { now, device: 'win-pc' })[0];
  assert.deepEqual(validateSchema(schema, claude), []);
  assert.deepEqual(validateSchema(schema, codex), []);
  assert.equal(claude.client, 'claude-sub-sync');
  assert.equal(codex.client, 'codex-local-cli');
  assert.equal(codex.path, 'codex-local');
  assert.equal(codex.device, 'win-pc');
  assert.ok(!Object.hasOwn(codex, 'ok'));
});

test('normalized schema rejects missing fields, extra keys and invalid token counts', () => {
  const missing = normalized();
  delete missing.client;
  const withoutUpstream = normalized();
  delete withoutUpstream.upstreamModel;
  assert.deepEqual(validateSchema(schema, withoutUpstream), []);
  for (const invalid of [
    missing, { ...normalized(), eventId: 'bad' }, { ...normalized(), ts: 1 },
    { ...normalized(), model: null }, { ...normalized(), kind: 'served' },
    { ...normalized(), device: 'Bad Device' }, { ...normalized(), reported: false },
    { ...normalized(), extra: true },
    { ...normalized(), usage: { ...usage, input: -1 } },
    { ...normalized(), usage: { ...usage, output: 1.5 } },
    { ...normalized(), usage: { ...usage, extra: 0 } },
    { ...normalized(), usage: { input: 1 } },
  ]) assert.ok(validateSchema(schema, invalid).length, JSON.stringify(invalid));
});

async function receiver(t, boundDevice) {
  const imported = [];
  const route = createMonitorRoutes({
    config: { observedUsage: { enabled: true } }, catalog: { providers: [] },
    usageLog: { importSubscription(rows) { imported.push(...rows); return rows.length; } },
  });
  const server = createServer((req, res) => {
    req.mgAuthorized = true;
    req.mgDevice = boundDevice;
    const url = new URL(req.url, 'http://localhost');
    route(req, res, url, url.pathname).catch((err) => res.destroy(err));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    imported,
    post: (body, path = 'observed') => fetch(`http://127.0.0.1:${server.address().port}/internal/usage/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

test('receiver returns unknown_source for an unregistered source', async (t) => {
  const { post, imported } = await receiver(t);
  const response = await post({ source: 'unknown', events: [] });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unknown_source' });
  assert.equal(imported.length, 0);
});

test('receiver validates every row before importing any of a source batch', async (t) => {
  const { post, imported } = await receiver(t);
  SOURCES.set('test-invalid', {
    id: 'test-invalid', path: 'test-invalid', allowModel: () => true,
    validateBatch: () => [normalized(), { ...normalized(), usage: { ...usage, input: -1 } }],
  });
  t.after(() => SOURCES.delete('test-invalid'));
  const response = await post({ source: 'test-invalid', events: [] });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: '无效的用量批次' });
  assert.equal(imported.length, 0);
});

test('receiver fills device and keeps the fixed-source codex compatibility endpoint', async (t) => {
  const { post, imported } = await receiver(t, 'bound-device');
  const claude = await post({ source: 'claude-code', device: 'untrusted', events: [event] });
  assert.equal(claude.status, 200);
  assert.deepEqual(await claude.json(), { accepted: 1, imported: 1 });
  const codex = await post({ source: 'unknown', events: [{ ...event, model: 'gpt-test', client: 'app' }] }, 'codex');
  assert.equal(codex.status, 200);
  assert.deepEqual(await codex.json(), { accepted: 1, imported: 1 });
  assert.deepEqual(imported.map((row) => [row.path, row.device]), [['claude-code', 'bound-device'], ['codex-local', 'bound-device']]);
});

test('receiver overrides a plugin-provided device with its own resolved device', async (t) => {
  const { post, imported } = await receiver(t);
  SOURCES.set('test-device', { validateBatch: () => [{ ...normalized(), device: 'wrong' }] });
  t.after(() => SOURCES.delete('test-device'));
  for (const device of [undefined, 'laptop']) {
    const response = await post({ source: 'test-device', device, events: [] });
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.deepEqual(imported.map((row) => row.device), ['mac', 'laptop']);
});

test('collector discovers registered sources without a built-in plan', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'mg18-source-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = 'test-collector';
  const calls = [];
  SOURCES.set(id, {
    id, path: id, allowModel: () => true,
    defaultPaths: ({ platform, home }) => ({ projectsDir: `${home}/${platform}/sessions` }),
    collect: (args) => {
      calls.push(args);
      return { events: [{ ...event }], state: { acknowledged: true } };
    },
  });
  t.after(() => SOURCES.delete(id));
  const stateDir = join(home, 'state');
  assert.equal(await runCollect({
    argv: ['--once', `--sources=${id}`], home, platform: 'linux', defaultDevice: 'test-device',
    env: { MODEL_GATEWAY_URL: 'https://gateway.example', USAGE_SYNC_KEY: 'test', USAGE_SYNC_STATE_DIR: stateDir },
    log: () => {}, requireEnvFile: false,
    fetchFn: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.source, id);
      assert.equal(body.device, 'test-device');
      return { ok: true, json: async () => ({ accepted: body.events.length }) };
    },
  }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].paths, { projectsDir: `${home}/linux/sessions` });
  assert.deepEqual(calls[0].state, {});
  assert.equal(typeof calls[0].now, 'number');
  assert.ok(existsSync(join(stateDir, `${id}-usage.json`)));
});
