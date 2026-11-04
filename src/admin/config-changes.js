import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateConfig } from '../config.js';
import { parseYaml } from '../yaml.js';
import { atomic, backupConfig } from '../config-file.js';
import { applyPatch } from './json-patch.js';
import { AdminError } from './errors.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const escape = value => value.replace(/~/g, '~0').replace(/\//g, '~1');
const envRef = value => typeof value === 'string' && value.startsWith('env:');

export function redactConfig(value, path = '') {
  if (Array.isArray(value)) return value.map((v, i) => redactConfig(v, `${path}/${i}`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    (k.endsWith('Ref') && !envRef(v)) || (/^\/gateway\/keys\/\d+$/.test(path) && k === 'key' && !envRef(v))
      ? '***' : redactConfig(v, `${path}/${escape(k)}`),
  ]));
  if (/^\/gateway\/keys\/\d+$/.test(path) && typeof value === 'string' && !envRef(value)) return '***';
  return value;
}

function checkSecrets(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    const p = `${path}/${escape(key)}`;
    if ((key.endsWith('Ref') || /^\/gateway\/keys\/\d+\/key$/.test(p) || (/^\/gateway\/keys\/\d+$/.test(p) && typeof v === 'string')) && !envRef(v)) {
      throw new AdminError(422, 'secret_literal_forbidden', 'Secrets must use env: references', { path: p });
    }
    checkSecrets(v, p);
  }
}

function differences(before, after, path = '') {
  if (isDeepStrictEqual(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(k => differences(before[k], after[k], `${path}/${escape(k)}`));
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}

export class ConfigChanges {
  constructor({ configPath, stateFile, reloadCatalog, events, serial, now = Date.now }) {
    Object.assign(this, { configPath, stateFile: stateFile ?? join(dirname(configPath), 'model-inbox.json'), reloadCatalog, events, now });
    this.previews = new Map();
    let queue = Promise.resolve();
    this.serial = serial ?? (fn => { const next = queue.then(fn); queue = next.catch(() => {}); return next; });
  }

  metadata() {
    const format = extname(this.configPath).slice(1);
    let writable = format === 'json';
    try { accessSync(this.configPath, constants.W_OK); accessSync(dirname(this.configPath), constants.W_OK); } catch { writable = false; }
    return { configPath: this.configPath, format, writable };
  }

  preview(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AdminError(400, 'patch_invalid', 'Expected a patch request object');
    const { patch, reason } = body;
    if (reason !== undefined && typeof reason !== 'string') throw new AdminError(400, 'patch_invalid', 'reason must be a string');
    const before = readFileSync(this.configPath, 'utf8');
    const raw = extname(this.configPath) === '.json' ? JSON.parse(before) : parseYaml(before);
    const next = applyPatch(raw, patch);
    checkSecrets(next);
    try { validateConfig(next, { source: this.configPath }); }
    catch (error) { throw new AdminError(422, 'config_invalid', error.message); }
    const restartRequired = patch.some(op => op.op !== 'test' && [op.path, ...(op.op === 'move' ? [op.from] : [])].some(p => p !== '/providers' && !p.startsWith('/providers/')));
    const changeId = randomUUID();
    const expires = this.now() + 15 * 60 * 1000;
    for (const [id, p] of this.previews) if (p.expires <= this.now()) this.previews.delete(id);
    const diff = differences(redactConfig(raw), redactConfig(next));
    const warnings = restartRequired ? ['Only providers reload immediately; other changes require a restart.'] : [];
    this.previews.set(changeId, { before: hash(before), next, reason, restartRequired, expires, paths: patch.map(op => op.path) });
    return { changeId, diff, warnings, restartRequired, expiresAt: new Date(expires).toISOString() };
  }

  assertJson() {
    if (extname(this.configPath) !== '.json') throw new AdminError(409, 'config_readonly', 'Migrate YAML before applying changes', { hint: 'npm run config:migrate' });
  }

  async writeAndReload(before, after) {
    try {
      atomic(this.configPath, after);
      if (await this.reloadCatalog() === false) throw new Error('reload returned false');
    } catch (error) {
      try {
        if (hash(readFileSync(this.configPath, 'utf8')) === hash(after)) {
          atomic(this.configPath, before);
          await this.reloadCatalog();
        }
      } catch { /* Preserve the original failure. */ }
      throw new AdminError(500, 'reload_failed', 'Config transaction failed; restoration attempted');
    }
  }

  apply(changeId) {
    return this.serial(async () => {
      const p = this.previews.get(changeId);
      if (!p || p.expires <= this.now()) throw new AdminError(404, 'change_not_found', 'Change preview expired or missing');
      this.assertJson();
      const before = readFileSync(this.configPath, 'utf8');
      if (hash(before) !== p.before) throw new AdminError(409, 'config_changed', 'Config changed since preview');
      const backup = backupConfig(this.stateFile, before, this.now(), 'json');
      const after = JSON.stringify(p.next, null, 2) + '\n';
      await this.writeAndReload(before, after);
      this.last = { backup, after: hash(after) };
      this.previews.delete(changeId);
      this.events?.record('admin_config_applied', { changeId, reason: p.reason, paths: p.paths, backup, restartRequired: p.restartRequired });
      return { ok: true, changeId, backup, restartRequired: p.restartRequired };
    });
  }

  rollback() {
    return this.serial(async () => {
      if (!this.last) throw new AdminError(404, 'change_not_found', 'No Admin API backup available');
      this.assertJson();
      const before = readFileSync(this.configPath, 'utf8');
      if (hash(before) !== this.last.after) throw new AdminError(409, 'config_changed', 'Config changed since apply');
      const { backup } = this.last;
      await this.writeAndReload(before, readFileSync(join(dirname(this.stateFile), backup), 'utf8'));
      this.last = null;
      this.events?.record('admin_config_rollback', { backup });
      return { ok: true, backup };
    });
  }

  reload() {
    return this.serial(async () => {
      const ok = await this.reloadCatalog() !== false;
      this.events?.record('admin_reload', { ok });
      if (!ok) throw new AdminError(500, 'reload_failed', 'Catalog reload failed');
      return { ok };
    });
  }
}
