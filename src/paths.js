// paths.js — CLI 持久化默认目录解析（MG16）。
// Linux/macOS 走 XDG（macOS 特意不用 ~/Library/Application Support，CLI 工具惯例，
// 与 docs/plan §3.4 一致）；Windows 走 %APPDATA%/%LOCALAPPDATA%。显式 env 永远优先。
// 路径拼接用平台对应的 path 模块（win32 用 path.win32），便于在任意主机上测试。

import os from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Resolve default config/data/state directories.
 * @param {object} [opts]
 * @param {string} [opts.platform] process.platform（注入以便测试 win32）
 * @param {object} [opts.env] 环境变量（注入以便测试）
 * @param {string} [opts.home] 用户主目录（注入以便测试）
 * @returns {{configDir: string, dataDir: string, stateDir: string}}
 */
export function resolvePaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const isWin = platform === 'win32';
  const join = isWin ? win32.join : posix.join;
  const defaults = isWin
    ? {
        // XDG 空串视为未设置（XDG 规范原文）；Windows env 缺失时回退 home 下默认位置
        configDir: join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'model-gateway'),
        dataDir: join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'model-gateway'),
        stateDir: join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'model-gateway', 'state'),
      }
    : {
        configDir: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'model-gateway'),
        dataDir: join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'model-gateway'),
        stateDir: join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'model-gateway'),
      };
  return {
    configDir: env.MODEL_GATEWAY_CONFIG_DIR || defaults.configDir,
    dataDir: env.MODEL_GATEWAY_DATA_DIR || defaults.dataDir,
    stateDir: env.USAGE_SYNC_STATE_DIR || defaults.stateDir,
  };
}
