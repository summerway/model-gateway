// config-schema.js — config/config.schema.json 的最小 JSON Schema 校验（零依赖）。
// 只实现 schema 里用到的关键字：type / properties / additionalProperties / required / items /
// enum / const / pattern / minLength / minItems / minimum / exclusiveMinimum / oneOf / 本地 $ref。
// 目的是发现「未知键」（validateConfig 会静默丢弃）与明显的类型错误；语义校验仍以 validateConfig 为准。

import { readFileSync } from 'node:fs';

export function loadConfigSchema() {
  return JSON.parse(readFileSync(new URL('../config/config.schema.json', import.meta.url), 'utf8'));
}

const typeOk = (t, v) => (t === 'integer' ? Number.isInteger(v)
  : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : t === 'array' ? Array.isArray(v)
  : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
  : typeof v === t);

/** @returns {string[]} 错误列表（路径: 说明）；空数组 = 通过 */
export function validateSchema(schema, value, root = schema, path = '$') {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], root);
    if (!target) return [`${path}: 无法解析 $ref ${schema.$ref}`];
    return validateSchema(target, value, root, path);
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => validateSchema(s, value, root, path).length === 0);
    if (passing.length === 1) return [];
    if (passing.length > 1) return [`${path}: 同时匹配多个形态`];
    // 选与值类型一致的分支报告详细错误
    const branch = schema.oneOf.find((s) => !s.type || typeOk(s.type, value) || s.$ref) ?? schema.oneOf[0];
    const errs = validateSchema(branch, value, root, path);
    return errs.length ? errs : [`${path}: 不符合任何允许的形态`];
  }
  const errors = [];
  if (schema.type && !typeOk(schema.type, value)) return [`${path}: 应为 ${schema.type}`];
  if ('const' in schema && value !== schema.const) errors.push(`${path}: 只允许 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: 只允许 ${schema.enum.join(' / ')}`);
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) errors.push(`${path}: 不能为空`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: 格式应匹配 ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: 应 ≥ ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: 应 > ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${path}: 至少 ${schema.minItems} 项`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateSchema(schema.items, v, root, `${path}[${i}]`)));
  }
  if (typeOk('object', value) && (schema.properties || schema.additionalProperties !== undefined || schema.required)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: 必填`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validateSchema(sub, v, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: 未知键（validateConfig 会静默丢弃）`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateSchema(schema.additionalProperties, v, root, `${path}.${key}`));
      }
    }
  }
  return errors;
}

/** config 中声明的全部模型名（providers / claude / embeddings / imageGeneration / activate）。 */
export function declaredModels(raw) {
  const out = new Set();
  for (const p of raw?.providers ?? []) for (const m of p?.models ?? []) out.add(typeof m === 'string' ? m : m?.id);
  for (const m of raw?.claude?.models ?? []) out.add(m);
  for (const m of raw?.embeddings?.models ?? []) out.add(m);
  if (raw?.imageGeneration?.model) out.add(raw.imageGeneration.model);
  for (const k of ['model', 'codexModel', 'claudeModel']) if (raw?.jobs?.activate?.[k]) out.add(raw.jobs.activate[k]);
  out.delete(undefined);
  return [...out];
}

const normId = (s) => s.toLowerCase().split('/').pop().replace(/[^a-z0-9]/g, '');

/**
 * 在 models.dev 全量 api.json 中按模型 id 精确查找（任意 provider，不依赖 type 字段——
 * chat 模型大多没有 type）。未找到的给出「归一化后同名」的候选（大小写、分隔符、provider 前缀差异），
 * 用来区分拼写/格式问题与真的未收录。
 * @returns {{ found: string[], missing: { id: string, similar: string[] }[] }}
 */
export function lookupModelsDev(apiJson, ids) {
  const exact = new Set();
  const byNorm = new Map();
  for (const [pid, p] of Object.entries(apiJson ?? {})) {
    for (const mid of Object.keys(p?.models ?? {})) {
      exact.add(mid);
      const key = normId(mid);
      if (!byNorm.has(key)) byNorm.set(key, []);
      byNorm.get(key).push(`${pid}:${mid}`);
    }
  }
  const found = [], missing = [];
  for (const id of ids) {
    if (exact.has(id)) found.push(id);
    else missing.push({ id, similar: (byNorm.get(normId(id)) ?? []).slice(0, 5) });
  }
  return { found, missing };
}
