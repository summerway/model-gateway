// Service plans and CLI installation behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servicePlan } from '../src/collect/service.js';

const unix = { nodePath: '/opt/Node App/node', binPath: '/opt/Gateway App/bin/model-gateway.js', envFile: '/home/Test User/collect.env', home: '/home/Test User' };

test('darwin: LaunchAgent interval, argument array, logs, and bootstrap/bootout', () => {
  const plan = servicePlan({ ...unix, platform: 'darwin', uid: 501 });
  const path = '/home/Test User/Library/LaunchAgents/local.model-gateway.collect.plist';
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, path);
  const text = plan.files[0].content;
  assert.match(text, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(text, /<string>\/opt\/Node App\/node<\/string>/);
  assert.match(text, /<string>collect<\/string>\s*<string>--once<\/string>/);
  assert.match(text, /<string>\/home\/Test User\/collect.env<\/string>/);
  assert.equal(text.match(/\/home\/Test User\/\.local\/state\/model-gateway\/collect.log/g).length, 2);
  assert.deepEqual(plan.install, [['launchctl', 'bootstrap', 'gui/501', path]]);
  assert.deepEqual(plan.uninstall, [['launchctl', 'bootout', 'gui/501/local.model-gateway.collect']]);
  const escaped = servicePlan({ ...unix, platform: 'darwin', envFile: '/tmp/A&B<test>.env', stateDir: '/state folder' });
  assert.ok(escaped.files[0].content.includes('A&amp;B&lt;test&gt;.env'));
  assert.ok(escaped.files[0].content.includes('/state folder/collect.log'));
});

test('linux: oneshot plus timer, quoted ExecStart, install/uninstall commands', () => {
  const plan = servicePlan({ ...unix, platform: 'linux' });
  assert.deepEqual(plan.files.map((f) => f.path), [
    '/home/Test User/.config/systemd/user/model-gateway-collect.service',
    '/home/Test User/.config/systemd/user/model-gateway-collect.timer',
  ]);
  assert.match(plan.files[0].content, /Type=oneshot/);
  assert.ok(plan.files[0].content.includes('ExecStart="/opt/Node App/node" "/opt/Gateway App/bin/model-gateway.js" "collect" "--once" "--env-file" "/home/Test User/collect.env"'));
  assert.match(plan.files[1].content, /OnBootSec=1min\nOnUnitActiveSec=5min/);
  assert.match(plan.files[1].content, /\[Install\]\nWantedBy=timers.target/);
  assert.deepEqual(plan.install, [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'model-gateway-collect.timer']]);
  assert.deepEqual(plan.uninstall, [['systemctl', '--user', 'disable', '--now', 'model-gateway-collect.timer'], ['systemctl', '--user', 'daemon-reload']]);
  const escaped = servicePlan({ ...unix, platform: 'linux', envFile: '/tmp/100%/$HOME/"quoted".env' });
  assert.ok(escaped.files[0].content.includes('/tmp/100%%/$$HOME/\\"quoted\\".env'));
});

test('win32: schtasks recurrence and one /TR argument with quoted paths', () => {
  const opts = {
    platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    binPath: 'C:\\Gateway App\\bin\\model-gateway.js', envFile: 'C:\\Users\\Test User\\collect.env', home: 'C:\\Users\\Test User',
  };
  const plan = servicePlan(opts);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.install, [[
    'schtasks', '/Create', '/SC', 'MINUTE', '/MO', '5', '/TN', 'model-gateway-collect', '/TR',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Gateway App\\bin\\model-gateway.js" "collect" "--once" "--env-file" "C:\\Users\\Test User\\collect.env"', '/F',
  ]]);
  assert.deepEqual(plan.uninstall, [['schtasks', '/Delete', '/TN', 'model-gateway-collect', '/F']]);
  assert.equal(servicePlan({ ...opts, intervalMin: 12 }).install[0][5], '12');
});

test('reject unsupported platforms, relative paths, and invalid intervals', () => {
  assert.throws(() => servicePlan({ ...unix, platform: 'other' }), /平台/);
  assert.throws(() => servicePlan({ ...unix, platform: 'linux', nodePath: './node' }), /绝对路径/);
  for (const intervalMin of [0, -1, 1.5, NaN]) assert.throws(() => servicePlan({ ...unix, platform: 'linux', intervalMin }), /正整数/);
});

function cliFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'mg17-service-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    MODEL_GATEWAY_CONFIG_DIR: join(home, 'config folder'), USAGE_SYNC_STATE_DIR: join(home, 'state folder'),
  };
  const run = (...args) => spawnSync(process.execPath, ['bin/model-gateway.js', 'collect', ...args], { encoding: 'utf8', env });
  return { home, env, run };
}

test('CLI --print reports files/commands and creates nothing', (t) => {
  const { home, run } = cliFixture(t);
  for (const action of ['install', 'uninstall']) {
    const res = run(action, '--print');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /launchctl|systemctl|schtasks/);
    assert.equal(existsSync(join(home, 'config folder')), false);
    assert.equal(existsSync(join(home, 'state folder')), false);
    assert.equal(existsSync(join(home, 'Library')), false);
    assert.equal(existsSync(join(home, '.config')), false);
  }
});

test('CLI installs a 600 template, handles scheduler errors, and removes files in order', { skip: process.platform === 'win32' }, (t) => {
  const { home, env, run } = cliFixture(t);
  const fakeBin = join(home, 'fake-bin');
  mkdirSync(fakeBin);
  const recorder = join(home, 'scheduler.cjs');
  const commandsFile = join(home, 'commands.jsonl');
  const unitDir = process.platform === 'darwin' ? join(home, 'Library', 'LaunchAgents') : join(home, '.config', 'systemd', 'user');
  const manifest = join(unitDir, process.platform === 'darwin' ? 'local.model-gateway.collect.plist' : 'model-gateway-collect.service');
  writeFileSync(recorder, `
    const fs = require('node:fs');
    fs.appendFileSync(process.env.TEST_COMMANDS, JSON.stringify({ args: process.argv.slice(2), exists: fs.existsSync(process.env.TEST_MANIFEST) }) + '\\n');
    if (process.env.TEST_FAIL === '1') { console.error('scheduler failed'); process.exit(3); }
  `);
  for (const name of ['launchctl', 'systemctl']) {
    const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    writeFileSync(join(fakeBin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o755 });
  }
  env.PATH = fakeBin + ':' + process.env.PATH;
  env.TEST_COMMANDS = commandsFile;
  env.TEST_MANIFEST = manifest;
  const installed = run('install', '--interval', '7');
  assert.equal(installed.status, 0, installed.stderr);
  const envFile = join(home, 'config folder', 'collect.env');
  const template = readFileSync(envFile, 'utf8');
  assert.match(template, /^MODEL_GATEWAY_URL=\nUSAGE_SYNC_KEY=\nUSAGE_SYNC_DEVICE=[a-z0-9-]+\n$/);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.ok(existsSync(manifest));
  assert.ok(existsSync(join(home, 'state folder')));
  assert.match(installed.stdout, /请填写/);
  writeFileSync(envFile, 'keep existing template\n');
  env.TEST_FAIL = '1';
  const failed = run('install');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /scheduler failed/);
  assert.equal(readFileSync(envFile, 'utf8'), 'keep existing template\n');
  env.TEST_FAIL = '0';
  const removed = run('uninstall');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(manifest), false);
  assert.equal(existsSync(envFile), true, 'uninstall preserves config and cursors');
  const records = readFileSync(commandsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const removal = records.find((r) => r.args.includes('bootout') || r.args.includes('disable'));
  assert.equal(removal.exists, true, 'stop service before deleting files');
  if (process.platform === 'linux') assert.equal(records.at(-1).exists, false, 'reload after deleting units');
});
