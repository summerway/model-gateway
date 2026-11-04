// Service manifests and commands for the observed usage collector.
import { posix, win32 } from 'node:path';
import { resolvePaths } from '../paths.js';

const currentUid = process.getuid?.() ?? 0;
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const systemdArg = (value) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$') + '"';
// Windows command-line quoting; spawnSync passes /TR as one argument without a shell.
const windowsArg = (value) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export function servicePlan({
  platform, nodePath, binPath, envFile, home, intervalMin = 5,
  stateDir = resolvePaths({ platform, home, env: {} }).stateDir, uid = currentUid,
}) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`不支持的平台：${platform}`);
  if (!Number.isSafeInteger(intervalMin) || intervalMin < 1) throw new Error('--interval 必须为正整数分钟');
  const path = platform === 'win32' ? win32 : posix;
  for (const value of [nodePath, binPath, envFile, home, stateDir]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error('服务路径必须为不含换行的绝对路径');
  }
  const args = [nodePath, binPath, 'collect', '--once', '--env-file', envFile];
  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', 'local.model-gateway.collect.plist');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.model-gateway.collect</string>
  <key>ProgramArguments</key><array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>${intervalMin * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(stateDir, 'collect.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(stateDir, 'collect.log'))}</string>
</dict></plist>
`;
    return {
      files: [{ path: plist, content }],
      install: [['launchctl', 'bootstrap', `gui/${uid}`, plist]],
      uninstall: [['launchctl', 'bootout', `gui/${uid}/local.model-gateway.collect`]],
    };
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user');
    return {
      files: [
        { path: path.join(dir, 'model-gateway-collect.service'), content: `[Unit]
Description=model-gateway observed usage collector

[Service]
Type=oneshot
ExecStart=${args.map(systemdArg).join(' ')}
` },
        { path: path.join(dir, 'model-gateway-collect.timer'), content: `[Unit]
Description=Collect local subscription usage every ${intervalMin} minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=${intervalMin}min

[Install]
WantedBy=timers.target
` },
      ],
      install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'model-gateway-collect.timer']],
      uninstall: [['systemctl', '--user', 'disable', '--now', 'model-gateway-collect.timer'], ['systemctl', '--user', 'daemon-reload']],
    };
  }
  return {
    files: [],
    install: [['schtasks', '/Create', '/SC', 'MINUTE', '/MO', String(intervalMin), '/TN', 'model-gateway-collect', '/TR', args.map(windowsArg).join(' '), '/F']],
    uninstall: [['schtasks', '/Delete', '/TN', 'model-gateway-collect', '/F']],
  };
}
