import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../src/admin/routes.js';

const spec = JSON.parse(readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
test('OpenAPI 3.1 and exported Admin routes agree in both directions', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.components.schemas.Config.$ref, '../config/config.schema.json');
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
  const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item).filter(m => methods.has(m)).map(m => `${m.toUpperCase()} ${path}`));
  const implemented = ROUTES.map(({ method, path }) => `${method} ${path}`);
  assert.equal(new Set(implemented).size, implemented.length);
  assert.deepEqual(implemented.sort(), documented.sort());
});

test('OpenAPI declares public contract and the only device-token exception', () => {
  assert.deepEqual(spec.security, [{ adminBearer: [] }]);
  assert.deepEqual(spec.paths['/openapi.json'].get.security, []);
  assert.deepEqual(spec.paths['/usage/observed'].post.security, [{ adminBearer: [] }, { deviceBearer: [] }]);
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      assert.ok(op.responses['200'], `${method} ${path}`);
      for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1])) {
        assert.ok(op.parameters?.some(p => p.in === 'path' && p.name === name && p.required));
      }
    }
  }
});
