import { writeFileSync, renameSync, mkdirSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function atomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 });
  renameSync(tmp, file);
}

/** Backups live beside the state file; retain ten per format, as Inbox did for YAML. */
export function backupConfig(stateFile, text, nowMs, extension = 'yaml') {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const name = `config-backup-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}.${extension}`;
  writeFileSync(join(dir, name), text, { mode: 0o600 });
  try {
    const olds = readdirSync(dir).filter(f => f.startsWith('config-backup-') && f.endsWith(`.${extension}`)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 10))) rmSync(join(dir, f));
  } catch { /* Cleanup failure must not block applying a config. */ }
  return name;
}
