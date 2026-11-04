// yaml.test.js — subset YAML parser tests (the config/ loader depends on it).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../src/yaml.js';

test('parses the config.example.yaml shape: nested maps, seq of maps, seq of scalars, numbers/bools', () => {
  const doc = parseYaml(`
gateway:
  host: 0.0.0.0
  port: 8080
  keys:
    - env:MODEL_GATEWAY_KEY
    - "literal-key"

providers:
  - id: glm-primary
    type: glm
    baseUrl: https://open.bigmodel.cn/api/paas/v4/chat/completions
    apiKeyRef: env:GLM_API_KEY
    models:
      - glm-5.3
      - glm-5.3-flash
  - id: deepseek
    type: openai
    baseUrl: https://api.deepseek.com/v1/chat/completions
    apiKeyRef: env:DEEPSEEK_API_KEY:sk-default
    models:
      - deepseek-flash

jobs:
  probe:
    enabled: true
    intervalSec: 300
  activate:
    enabled: false
`);
  assert.equal(doc.gateway.host, '0.0.0.0');
  assert.equal(doc.gateway.port, 8080);
  assert.deepEqual(doc.gateway.keys, ['env:MODEL_GATEWAY_KEY', 'literal-key']);
  assert.equal(doc.providers.length, 2);
  assert.equal(doc.providers[0].id, 'glm-primary');
  assert.equal(doc.providers[0].type, 'glm');
  assert.equal(doc.providers[0].baseUrl, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.deepEqual(doc.providers[0].models, ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(doc.providers[1].apiKeyRef, 'env:DEEPSEEK_API_KEY:sk-default');
  assert.equal(doc.jobs.probe.enabled, true);
  assert.equal(doc.jobs.probe.intervalSec, 300);
  assert.equal(doc.jobs.activate.enabled, false);
});

test('env:VAR colon does not split as a mapping key', () => {
  const doc = parseYaml('apiKeyRef: env:GLM_API_KEY');
  assert.equal(doc.apiKeyRef, 'env:GLM_API_KEY');
});

test('comments and blank lines ignored; inline comments stripped', () => {
  const doc = parseYaml(`
# leading comment
a: 1  # trailing comment
b: "x # not comment"

# blank above
`);
  assert.equal(doc.a, 1);
  assert.equal(doc.b, 'x # not comment');
});

test('scalars: numbers, bools, null, quoted strings with escapes', () => {
  const doc = parseYaml(`
i: 42
f: 3.5
neg: -1
t: true
f2: false
n: null
s: "hello \\"world\\""
single: 'it''s'
plain: hello world
url: https://example.com/x
`);
  assert.equal(doc.i, 42);
  assert.equal(doc.f, 3.5);
  assert.equal(doc.neg, -1);
  assert.equal(doc.t, true);
  assert.equal(doc.f2, false);
  assert.equal(doc.n, null);
  assert.equal(doc.s, 'hello "world"');
  assert.equal(doc.single, "it's");
  assert.equal(doc.plain, 'hello world');
  assert.equal(doc.url, 'https://example.com/x');
});

test('sequence nested under key at same indent', () => {
  const doc = parseYaml(`
list:
  - a
  - b
empty: null
`);
  assert.deepEqual(doc.list, ['a', 'b']);
  assert.equal(doc.empty, null);
});

test('hash inside quoted scalar preserved; hash mid-word not a comment', () => {
  const doc = parseYaml(`
color: "#ff0000"
anchor: mid#word
`);
  assert.equal(doc.color, '#ff0000');
  assert.equal(doc.anchor, 'mid#word');
});

test('empty document yields empty object', () => {
  assert.deepEqual(parseYaml(''), {});
  assert.deepEqual(parseYaml('# only comments\n\n'), {});
});

test('invalid mapping line throws YamlError', () => {
  assert.throws(() => parseYaml('just a scalar\nsecond line'), YamlError);
});
