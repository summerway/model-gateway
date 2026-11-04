// paths.test.js — resolvePaths 平台默认目录与显式 env 覆盖（MG16）
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePaths } from '../src/paths.js';

const HOME = '/home/tester';
const WIN_HOME = 'C:\\Users\\tester';

test('linux: XDG 变量设置时优先', () => {
  const { configDir, dataDir } = resolvePaths({
    platform: 'linux',
    home: HOME,
    env: { XDG_CONFIG_HOME: '/xdg/cfg', XDG_DATA_HOME: '/xdg/data' },
  });
  assert.equal(configDir, '/xdg/cfg/model-gateway');
  assert.equal(dataDir, '/xdg/data/model-gateway');
});

test('linux: XDG 未设置时回退 ~/.config 与 ~/.local/share', () => {
  const { configDir, dataDir } = resolvePaths({ platform: 'linux', home: HOME, env: {} });
  assert.equal(configDir, '/home/tester/.config/model-gateway');
  assert.equal(dataDir, '/home/tester/.local/share/model-gateway');
});

test('linux: XDG 空串视为未设置', () => {
  const { configDir } = resolvePaths({ platform: 'linux', home: HOME, env: { XDG_CONFIG_HOME: '' } });
  assert.equal(configDir, '/home/tester/.config/model-gateway');
});

test('darwin: 同 Linux 的 XDG 规则（不用 ~/Library）', () => {
  const { configDir, dataDir } = resolvePaths({ platform: 'darwin', home: '/Users/t', env: {} });
  assert.equal(configDir, '/Users/t/.config/model-gateway');
  assert.equal(dataDir, '/Users/t/.local/share/model-gateway');
});

test('win32: %APPDATA%/%LOCALAPPDATA%（path.win32 拼接，可在 mac 上测）', () => {
  const { configDir, dataDir } = resolvePaths({
    platform: 'win32',
    home: WIN_HOME,
    env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
  });
  assert.equal(configDir, 'C:\\Users\\tester\\AppData\\Roaming\\model-gateway');
  assert.equal(dataDir, 'C:\\Users\\tester\\AppData\\Local\\model-gateway');
});

test('win32: APPDATA 缺失时回退 home\\AppData\\Roaming|Local', () => {
  const { configDir, dataDir } = resolvePaths({ platform: 'win32', home: WIN_HOME, env: {} });
  assert.equal(configDir, 'C:\\Users\\tester\\AppData\\Roaming\\model-gateway');
  assert.equal(dataDir, 'C:\\Users\\tester\\AppData\\Local\\model-gateway');
});

test('显式 MODEL_GATEWAY_CONFIG_DIR / MODEL_GATEWAY_DATA_DIR 优先（含混搭平台默认）', () => {
  const explicit = resolvePaths({
    platform: 'linux',
    home: HOME,
    env: { MODEL_GATEWAY_CONFIG_DIR: '/etc/mg', MODEL_GATEWAY_DATA_DIR: '/var/lib/mg' },
  });
  assert.deepEqual(explicit, { configDir: '/etc/mg', dataDir: '/var/lib/mg', stateDir: '/home/tester/.local/state/model-gateway' });

  const half = resolvePaths({
    platform: 'linux',
    home: HOME,
    env: { MODEL_GATEWAY_DATA_DIR: '/var/lib/mg' },
  });
  assert.equal(half.configDir, '/home/tester/.config/model-gateway');
  assert.equal(half.dataDir, '/var/lib/mg');
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: stateDir 使用 XDG_STATE_HOME 或 ~/.local/state`, () => {
    assert.equal(resolvePaths({ platform, home: HOME, env: {} }).stateDir, '/home/tester/.local/state/model-gateway');
    assert.equal(resolvePaths({ platform, home: HOME, env: { XDG_STATE_HOME: '/xdg/state' } }).stateDir, '/xdg/state/model-gateway');
    assert.equal(resolvePaths({ platform, home: HOME, env: { XDG_STATE_HOME: '' } }).stateDir, '/home/tester/.local/state/model-gateway');
    assert.equal(resolvePaths({ platform, home: HOME, env: { XDG_STATE_HOME: '/xdg/state', USAGE_SYNC_STATE_DIR: '/explicit/state' } }).stateDir, '/explicit/state');
  });
}

test('win32: stateDir 使用 LOCALAPPDATA、home 回退与显式覆盖', () => {
  const opts = { platform: 'win32', home: WIN_HOME };
  assert.equal(resolvePaths({ ...opts, env: {} }).stateDir, 'C:\\Users\\tester\\AppData\\Local\\model-gateway\\state');
  assert.equal(resolvePaths({ ...opts, env: { LOCALAPPDATA: 'D:\\Local' } }).stateDir, 'D:\\Local\\model-gateway\\state');
  assert.equal(resolvePaths({ ...opts, env: { LOCALAPPDATA: '', USAGE_SYNC_STATE_DIR: '' } }).stateDir, 'C:\\Users\\tester\\AppData\\Local\\model-gateway\\state');
  assert.equal(resolvePaths({ ...opts, env: { LOCALAPPDATA: 'D:\\Local', USAGE_SYNC_STATE_DIR: 'E:\\state' } }).stateDir, 'E:\\state');
});
