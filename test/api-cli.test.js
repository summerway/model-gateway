import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, runApi } from '../scripts/api.js';

const env = { MODEL_GATEWAY_URL: 'http://gw.test:8080', MODEL_GATEWAY_ADMIN_KEY: 'k1' };
const sink = () => { let text = ''; return { write: (s) => { text += s; }, get text() { return text; } }; };

test('api: 相对路径补 /admin/v1，带 admin Bearer', () => {
  const r = buildRequest(['get', 'status'], { env });
  assert.equal(r.url, 'http://gw.test:8080/admin/v1/status');
  assert.equal(r.method, 'GET');
  assert.equal(r.headers.authorization, 'Bearer k1');
  assert.equal(buildRequest(['GET', '/internal/quota'], { env }).url, 'http://gw.test:8080/internal/quota');
  assert.equal(buildRequest(['GET', '/health'], { env: {} }).url, 'http://127.0.0.1:8080/health');
});

test('api: --data 支持 @file、- 与内联 JSON，非法 JSON 报错', () => {
  const readFile = (f) => (f === 'p.json' ? '{"patch":[]}' : '');
  assert.equal(buildRequest(['POST', '/config/changes', '--data', '@p.json'], { env, readFile }).body, '{"patch":[]}');
  assert.equal(buildRequest(['POST', '/reload', '--data', '-'], { env, stdin: () => '{}' }).body, '{}');
  const inline = buildRequest(['POST', '/reload', '--data', '{"a":1}'], { env });
  assert.equal(inline.headers['content-type'], 'application/json');
  assert.throws(() => buildRequest(['POST', '/reload', '--data', 'nope'], { env }), /合法 JSON/);
  assert.throws(() => buildRequest(['FETCH', '/x'], { env }), /用法/);
});

test('api: 原样输出响应体；非 2xx 退出 1，参数错误退出 2', async () => {
  const out = sink(), err = sink();
  const fetchFn = async (url, init) => ({ ok: url.endsWith('/status'), text: async () => JSON.stringify({ url, auth: init.headers.authorization }) });
  assert.equal(await runApi(['GET', 'status'], { env, fetchFn, out, err }), 0);
  assert.deepEqual(JSON.parse(out.text), { url: 'http://gw.test:8080/admin/v1/status', auth: 'Bearer k1' });
  assert.equal(await runApi(['GET', 'events'], { env, fetchFn, out, err }), 1);
  assert.equal(await runApi([], { env, fetchFn, out, err }), 2);
  assert.equal(await runApi(['GET', 'status'], { env, fetchFn: async () => { throw new Error('down'); }, out, err }), 1);
  assert.match(err.text, /请求失败：down/);
});
