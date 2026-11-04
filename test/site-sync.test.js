import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('committed site vendor files match scripts/sync-site.js output', () => {
  const run = spawnSync(process.execPath, ['scripts/sync-site.js', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `sync-site --check failed:\n${run.stdout}${run.stderr}`);
});
