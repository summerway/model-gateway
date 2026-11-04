#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findConfigFile } from '../src/config.js';
import { parseYaml } from '../src/yaml.js';

export function migrateConfig(configDir = process.env.MODEL_GATEWAY_CONFIG_DIR ?? 'config') {
  const source = findConfigFile(configDir);
  if (!['.yaml', '.yml'].includes(extname(source))) throw new Error('No YAML config found');
  const target = join(dirname(source), 'config.json');
  const backup = `${source}.bak`;
  if (existsSync(target)) throw new Error('config.json already exists; refusing to overwrite');
  if (existsSync(backup)) throw new Error(`${backup} already exists; refusing to overwrite`);
  const config = parseYaml(readFileSync(source, 'utf8'));
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { renameSync(source, backup); }
  catch (error) { unlinkSync(target); throw error; }
  console.log('YAML 注释不会保留');
  console.log(`Migrated ${source} → ${target}; backup: ${backup}`);
  return { source, target, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { migrateConfig(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
