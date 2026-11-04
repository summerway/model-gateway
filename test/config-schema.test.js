// config-schema.test.js — MG9：schema 与 validateConfig 不漂移；example 通过；未知键被发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '../src/yaml.js';
import { validateConfig } from '../src/config.js';
import { loadConfigSchema, validateSchema, declaredModels, lookupModelsDev } from '../src/config-schema.js';

const schema = loadConfigSchema();
const example = parseYaml(readFileSync(new URL('../config/config.example.yaml', import.meta.url), 'utf8'));

test('config.example.yaml 通过 schema 与 validateConfig', () => {
  assert.deepEqual(validateSchema(schema, example), []);
  assert.doesNotThrow(() => validateConfig(example));
});

test('schema 顶层键 = validateConfig 输出顶层键（防白名单与 schema 漂移）', () => {
  const out = Object.keys(validateConfig(example)).filter((k) => k !== 'source').sort();
  assert.deepEqual(Object.keys(schema.properties).sort(), out);
});

test('未知键、错误类型、非 env 引用都会报出路径', () => {
  const bad = structuredClone(example);
  bad.jobs.activate.modle = 'typo';
  bad.newSection = {};
  bad.providers[0].apiKeyRef = 'sk-literal';
  bad.gateway.port = '8080';
  const errors = validateSchema(schema, bad);
  for (const path of ['$.jobs.activate.modle', '$.newSection', '$.providers[0].apiKeyRef', '$.gateway.port']) {
    assert.ok(errors.some((e) => e.startsWith(path)), `missing error for ${path}: ${errors.join(' | ')}`);
  }
});

test('topology schema validates metadata shapes and detects unknown nested keys', () => {
  const raw = structuredClone(example);
  raw.topology = {
    appGroups: [{ id: 'knowledge', label: '知识应用', icon: 'knowledge', apps: ['kb-service'] }],
    collectors: [{ id: 'sync', label: '本地采集' }],
    directConnections: [{ app: 'claude-code', device: 'mac', providerId: 'claude', collectorId: 'sync' }],
  };
  assert.deepEqual(validateSchema(schema, raw), []);
  raw.topology.appGroups[0].apiKey = 'env:SHOULD_NOT_EXIST';
  raw.topology.directConnections[0].device = 'invalid device';
  raw.topology.collectors[0].label = '';
  const errors = validateSchema(schema, raw);
  for (const path of ['$.topology.appGroups[0].apiKey', '$.topology.directConnections[0].device', '$.topology.collectors[0].label']) {
    assert.ok(errors.some((e) => e.startsWith(path)), errors.join(' | '));
  }
});

test('declaredModels 覆盖 providers / claude / embeddings / activate', () => {
  const models = declaredModels(example);
  for (const m of ['glm-5.3', 'gpt-6-sol', 'text-embedding-v4']) assert.ok(models.includes(m), m);
});

test('lookupModelsDev：任意 provider 精确命中（不依赖 type 字段），格式差异给候选', () => {
  const api = {
    zai: { models: { 'glm-5.3': {} } },
    openai: { models: { 'gpt-6-sol': {}, 'gpt-image-2': { type: 'image' } } },
    cortecs: { models: { 'claude-haiku-5.5': {} } },
  };
  const r = lookupModelsDev(api, ['glm-5.3', 'gpt-6-sol', 'claude-haiku-5-5', 'text-embedding-v4']);
  assert.deepEqual(r.found, ['glm-5.3', 'gpt-6-sol']);
  assert.deepEqual(r.missing, [
    { id: 'claude-haiku-5-5', similar: ['cortecs:claude-haiku-5.5'] },
    { id: 'text-embedding-v4', similar: [] },
  ]);
});
