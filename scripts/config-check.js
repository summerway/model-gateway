#!/usr/bin/env node
// config-check.js — 改完 config 后的一条命令校验：① schema（未知键、类型）② validateConfig（语义）
// ③ 可选 --models：声明的模型名是否被 models.dev 收录（需要网络；未收录只告警）。
// 用法：npm run config:check [-- path] [--models]   缺省路径 config/config.yaml（不存在则用 example）
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseYaml } from '../src/yaml.js';
import { validateConfig } from '../src/config.js';
import { loadConfigSchema, validateSchema, declaredModels, lookupModelsDev } from '../src/config-schema.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? (existsSync('config/config.yaml') ? 'config/config.yaml' : 'config/config.example.yaml');
const text = readFileSync(file, 'utf8');
const raw = extname(file) === '.json' ? JSON.parse(text) : parseYaml(text);
let failed = false;

const schemaErrors = validateSchema(loadConfigSchema(), raw);
if (schemaErrors.length) { failed = true; console.error(`✖ schema（${schemaErrors.length}）`); for (const e of schemaErrors) console.error(`  ${e}`); }
else console.log('✔ schema');

try { validateConfig(raw, { source: file }); console.log('✔ validateConfig'); }
catch (err) { failed = true; console.error(`✖ validateConfig\n  ${err.message}`); }

if (args.includes('--models')) {
  const url = process.env.MODELS_DEV_URL ?? 'https://models.dev/api.json';
  let apiJson = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    apiJson = await res.json();
  } catch (err) { console.warn(`⚠ models.dev 拉取失败，跳过模型名校验（${err.message}）`); }
  if (apiJson) {
    const { found, missing } = lookupModelsDev(apiJson, declaredModels(raw));
    if (!missing.length) console.log(`✔ models.dev 模型名（${found.length} 个全部收录）`);
    for (const m of missing) {
      console.warn(m.similar.length
        ? `⚠ ${m.id}：models.dev 无同名条目，疑似格式差异，候选 ${m.similar.join(', ')}`
        : `⚠ ${m.id}：models.dev 未收录（无相似名称）`);
    }
  }
}
console.log(failed ? `${file}: 校验未通过` : `${file}: 通过`);
process.exitCode = failed ? 1 : 0;
