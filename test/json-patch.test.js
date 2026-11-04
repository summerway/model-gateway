import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../src/admin/json-patch.js';

const cases = [
  ['A.1 object add', { foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux' }], { foo: 'bar', baz: 'qux' }],
  ['A.2 array add', { foo: ['bar', 'baz'] }, [{ op: 'add', path: '/foo/1', value: 'qux' }], { foo: ['bar', 'qux', 'baz'] }],
  ['A.3 object remove', { baz: 'qux', foo: 'bar' }, [{ op: 'remove', path: '/baz' }], { foo: 'bar' }],
  ['A.4 array remove', { foo: ['bar', 'qux', 'baz'] }, [{ op: 'remove', path: '/foo/1' }], { foo: ['bar', 'baz'] }],
  ['A.5 replace', { baz: 'qux', foo: 'bar' }, [{ op: 'replace', path: '/baz', value: 'boo' }], { baz: 'boo', foo: 'bar' }],
  ['A.6 move', { foo: { bar: 'baz', waldo: 'fred' }, qux: { corge: 'grault' } }, [{ op: 'move', from: '/foo/waldo', path: '/qux/thud' }], { foo: { bar: 'baz' }, qux: { corge: 'grault', thud: 'fred' } }],
  ['A.7 array move', { foo: ['all', 'grass', 'cows', 'eat'] }, [{ op: 'move', from: '/foo/1', path: '/foo/3' }], { foo: ['all', 'cows', 'eat', 'grass'] }],
  ['A.8 test', { baz: 'qux', foo: ['a', 2, 'c'] }, [{ op: 'test', path: '/baz', value: 'qux' }, { op: 'test', path: '/foo/1', value: 2 }], { baz: 'qux', foo: ['a', 2, 'c'] }],
  ['A.10 nested add', { foo: 'bar' }, [{ op: 'add', path: '/child', value: { grandchild: {} } }], { foo: 'bar', child: { grandchild: {} } }],
  ['A.11 ignore extra members', { foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux', xyz: 123 }], { foo: 'bar', baz: 'qux' }],
  ['A.14 escape order', { '/': 9, '~1': 10 }, [{ op: 'test', path: '/~01', value: 10 }], { '/': 9, '~1': 10 }],
  ['A.16 append array', { foo: ['bar'] }, [{ op: 'add', path: '/foo/-', value: ['abc', 'def'] }], { foo: ['bar', ['abc', 'def']] }],
  ['copy detached value', { a: { n: 1 } }, [{ op: 'copy', from: '/a', path: '/b' }, { op: 'replace', path: '/a/n', value: 2 }], { a: { n: 2 }, b: { n: 1 } }],
  ['root replace', { a: 1 }, [{ op: 'replace', path: '', value: [1] }], [1]],
  ['object equality ignores key order', { a: { x: 1, y: 2 } }, [{ op: 'test', path: '/a', value: { y: 2, x: 1 } }], { a: { x: 1, y: 2 } }],
];
for (const [name, input, patch, expected] of cases) test(name, () => {
  const original = structuredClone(input);
  const originalPatch = structuredClone(patch);
  assert.deepEqual(applyPatch(input, patch), expected);
  assert.deepEqual(input, original);
  assert.deepEqual(patch, originalPatch);
});

for (const [name, input, patch, code] of [
  ['A.9 test failure', { baz: 'qux' }, [{ op: 'test', path: '/baz', value: 'bar' }], 'patch_test_failed'],
  ['A.12 nonexistent parent', { foo: 'bar' }, [{ op: 'add', path: '/baz/bat', value: 'qux' }], 'patch_invalid'],
  // A.13 duplicate object members are resolved by JSON.parse before patch evaluation.
  ['A.13 duplicate op leaves unknown op', {}, JSON.parse('[{"op":"add","path":"/baz","value":"qux","op":"xyz"}]'), 'patch_invalid'],
  ['A.15 number is not string', { '/': 9 }, [{ op: 'test', path: '/~1', value: '9' }], 'patch_test_failed'],
  ['leading zero index', [1], [{ op: 'remove', path: '/00' }], 'patch_invalid'],
  ['negative index', [1], [{ op: 'remove', path: '/-1' }], 'patch_invalid'],
  ['out of bounds', [], [{ op: 'add', path: '/1', value: 2 }], 'patch_invalid'],
  ['append only for add', [], [{ op: 'remove', path: '/-' }], 'patch_invalid'],
  ['invalid escape', {}, [{ op: 'add', path: '/~2', value: 1 }], 'patch_invalid'],
  ['missing path', {}, [{ op: 'add', value: 1 }], 'patch_invalid'],
  ['missing value', {}, [{ op: 'add', path: '/a' }], 'patch_invalid'],
  ['move into descendant', { a: {} }, [{ op: 'move', from: '/a', path: '/a/b' }], 'patch_invalid'],
  ['prototype traversal', {}, [{ op: 'add', path: '/__proto__/polluted', value: true }], 'patch_invalid'],
  ['patch must be array', {}, {}, 'patch_invalid'],
]) test(name, () => {
  const original = structuredClone(input);
  assert.throws(() => applyPatch(input, patch), error => error.code === code);
  assert.deepEqual(input, original);
});

test('own __proto__ is a JSON member and cannot pollute prototypes', () => {
  const value = applyPatch({}, [{ op: 'add', path: '/__proto__', value: { polluted: true } }]);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});
