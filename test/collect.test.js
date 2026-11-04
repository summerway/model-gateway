// Cross-platform collector behavior and compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDevice, runCollect } from '../src/collect/index.js';
import { validateCodexBatch } from '../src/monitor/codex-local.js';

function fixture(t, count = 1) {
  const home = mkdtempSync(join(tmpdir(), 'mg17-collect-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const claude = join(home, '.claude', 'projects');
  const codex = join(home, '.codex', 'sessions');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(join(claude, 's.jsonl'), Array.from({ length: count }, (_, i) => JSON.stringify({
    type: 'assistant', timestamp,
    message: { id: `msg-${i}`, model: 'claude-test', content: 'private body', usage: { input_tokens: 10, output_tokens: 2 } },
  })).join('\n') + '\n');
  const meta = [
    { type: 'session_meta', payload: { id: 'session', originator: 'codex_cli', model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-test' } },
  ];
  const events = Array.from({ length: count }, (_, i) => ({
    type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: i + 1, output_tokens: i + 1 },
      last_token_usage: { input_tokens: 1, output_tokens: 1 },
    } },
  }));
  writeFileSync(join(codex, 's.jsonl'), [...meta, ...events].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const sent = [];
  const opts = {
    argv: ['--once'], home, platform: process.platform,
    env: { MODEL_GATEWAY_URL: 'https://gateway.example', USAGE_SYNC_KEY: 'test-key', USAGE_SYNC_STATE_DIR: join(home, 'state') },
    defaultDevice: 'default-device', log: () => {},
    fetchFn: async (url, request) => {
      assert.equal(url.href, 'https://gateway.example/internal/usage/observed');
      assert.equal(request.headers.authorization, 'Bearer test-key');
      const batch = JSON.parse(request.body);
      assert.ok(!request.body.includes('private body'));
      sent.push(batch);
      return { ok: true, json: async () => ({ accepted: batch.events.length }) };
    },
  };
  return { home, sent, opts };
}

test('--once pushes both sources and persists acknowledged cursors', async (t) => {
  const { home, sent, opts } = fixture(t);
  assert.equal(await runCollect(opts), 0);
  assert.deepEqual(sent.map((b) => [b.source, b.device, b.events.length]), [['codex', 'default-device', 1], ['claude-code', 'default-device', 1]]);
  assert.ok(existsSync(join(home, 'state', 'codex-usage.json')));
  assert.ok(existsSync(join(home, 'state', 'claude-usage.json')));
  assert.equal(await runCollect(opts), 0);
  assert.equal(sent.length, 2, 'second run does not resend acknowledged events');
  assert.equal(validateCodexBatch(sent[0]).at(0).device, 'mac');
  assert.equal(validateCodexBatch(sent[0], Date.now(), 'win-pc').at(0).device, 'win-pc');
});

test('--once drains 500-row batches from both sources before exiting', async (t) => {
  const { sent, opts } = fixture(t, 1001);
  assert.equal(await runCollect(opts), 0);
  assert.deepEqual(sent.map((b) => b.events.length), [500, 500, 500, 500, 1, 1]);
  assert.equal(new Set(sent.flatMap((b) => b.events.map((e) => e.id))).size, 2002);
});

test('an exact 500-row batch triggers the final empty scan', async (t) => {
  const { sent, opts } = fixture(t, 500);
  const messages = [];
  assert.equal(await runCollect({ ...opts, log: (line) => messages.push(line) }), 0);
  assert.equal(sent.length, 2);
  assert.equal(messages.filter((line) => line.includes('已同步 0 条')).length, 2);
});

for (const [args, deviceEnv, expected] of [
  [['--device', 'cli-device'], 'env-device', 'cli-device'],
  [[], 'env-device', 'env-device'],
  [[], undefined, 'default-device'],
]) {
  test(`device priority: ${expected}`, async (t) => {
    const { sent, opts } = fixture(t);
    await runCollect({ ...opts, argv: ['--once', '--sources=claude-code', ...args], env: { ...opts.env, USAGE_SYNC_DEVICE: deviceEnv } });
    assert.deepEqual(sent.map((b) => b.device), [expected]);
  });
}

test('normalizeDevice produces a bounded hostname slug', () => {
  assert.equal(normalizeDevice('MacBook-Pro.local'), 'macbook-pro-local');
  assert.equal(normalizeDevice('--- A_B ---'), 'a-b');
  assert.equal(normalizeDevice('...'), 'device');
  assert.equal(normalizeDevice('A'.repeat(40)).length, 32);
});

test('failure keeps the failed cursor and still attempts the other source', async (t) => {
  const { home, opts } = fixture(t);
  const attempted = [];
  const code = await runCollect({ ...opts, fetchFn: async (_url, request) => {
    const batch = JSON.parse(request.body);
    attempted.push(batch.source);
    if (batch.source === 'codex') return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ accepted: batch.events.length }) };
  } });
  assert.equal(code, 1);
  assert.deepEqual(attempted, ['codex', 'claude-code']);
  assert.equal(existsSync(join(home, 'state', 'codex-usage.json')), false);
  assert.equal(existsSync(join(home, 'state', 'claude-usage.json')), true);
});

test('env-file uses a whitelist and overrides env; loose POSIX permissions fail', async (t) => {
  const { home, sent, opts } = fixture(t);
  const file = join(home, 'collect.env');
  writeFileSync(file, 'USAGE_SYNC_DEVICE="file-device"\nUSAGE_SYNC_KEY=\'test-key\'\nMODEL_GATEWAY_CONFIG_DIR=/ignored\n', { mode: 0o600 });
  const argv = ['--once', '--env-file', file];
  assert.equal(await runCollect({ ...opts, argv }), 0);
  assert.equal(sent[0].device, 'file-device');
  assert.equal(opts.env.USAGE_SYNC_DEVICE, undefined, 'caller env is not mutated');
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644);
    await assert.rejects(runCollect({ ...opts, argv }), /600/);
    // An empty sources list avoids any filesystem writes with simulated Windows paths.
    assert.equal(await runCollect({ ...opts, platform: 'win32', argv: [...argv, '--sources='] }), 0);
  }
});

test('default config/collect.env is optional; legacy shell does not implicitly read it', async (t) => {
  const { home, sent, opts } = fixture(t);
  mkdirSync(join(home, '.config', 'model-gateway'), { recursive: true });
  writeFileSync(join(home, '.config', 'model-gateway', 'collect.env'), 'USAGE_SYNC_DEVICE=config-device\n', { mode: 0o600 });
  await runCollect(opts);
  assert.equal(sent[0].device, 'config-device');
  const result = spawnSync(process.execPath, ['scripts/mac-usage-sync.js', '--once', '--sources='], {
    encoding: 'utf8', env: { ...process.env, ...opts.env, MODEL_GATEWAY_CONFIG_DIR: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(join(home, 'state', 'claude-usage.json'), 'utf8').includes('offset'));
});

test('win32 default session directories use backslashes (isolated filesystem spy)', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { runCollect } from './src/collect/index.js';
    const seen = [];
    fs.existsSync = (path) => { seen.push(path); return false; };
    for (const name of ['mkdirSync', 'writeFileSync', 'renameSync']) fs[name] = () => {};
    syncBuiltinESMExports();
    const code = await runCollect({
      argv: ['--once'], platform: 'win32', home: 'C:\\\\Users\\\\tester',
      env: { MODEL_GATEWAY_URL: 'https://gateway.example', USAGE_SYNC_KEY: 'test' }, log: () => {},
    });
    console.log(JSON.stringify({ code, seen }));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { code, seen } = JSON.parse(result.stdout);
  assert.equal(code, 0);
  assert.ok(seen.includes('C:\\Users\\tester\\.codex\\sessions'));
  assert.ok(seen.includes('C:\\Users\\tester\\.claude\\projects'));
  assert.ok(seen.includes('C:\\Users\\tester\\AppData\\Local\\model-gateway\\state\\codex-usage.json'));
});

test('legacy script preserves mac default, explicit env-file, and --sources', async (t) => {
  const { home, opts } = fixture(t);
  const sent = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const batch = JSON.parse(body);
    sent.push(batch);
    res.end(JSON.stringify({ accepted: batch.events.length }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const file = join(home, 'legacy.env');
  writeFileSync(file, `MODEL_GATEWAY_URL=http://127.0.0.1:${server.address().port}\nUSAGE_SYNC_KEY=test-key\n`, { mode: 0o600 });
  const env = {
    ...process.env, ...opts.env,
    CLAUDE_PROJECTS_DIR: join(home, '.claude', 'projects'), CODEX_SESSION_DIR: join(home, '.codex', 'sessions'),
  };
  delete env.USAGE_SYNC_DEVICE;
  await promisify(execFile)(process.execPath, ['scripts/mac-usage-sync.js', '--env-file', file, '--once', '--sources=claude-code'], { env });
  assert.deepEqual(sent.map((b) => [b.source, b.device]), [['claude-code', 'mac']]);
});
