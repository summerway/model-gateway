import { isDeepStrictEqual } from 'node:util';
import { AdminError } from './errors.js';

const invalid = (message) => { throw new AdminError(400, 'patch_invalid', message); };
const own = (object, key) => Object.hasOwn(object, key);
const container = (value) => value !== null && typeof value === 'object';

function pointer(value) {
  if (typeof value !== 'string' || (value !== '' && !value.startsWith('/')) || /~(?![01])/.test(value)) invalid('Invalid JSON Pointer');
  return value === '' ? [] : value.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function index(array, key, add = false) {
  if (add && key === '-') return array.length;
  if (!/^(0|[1-9]\d*)$/.test(key)) invalid('Invalid array index');
  const n = Number(key);
  if (!Number.isSafeInteger(n) || n >= array.length + (add ? 1 : 0)) invalid('Array index out of bounds');
  return n;
}

function get(document, parts) {
  let node = document;
  for (const part of parts) {
    if (!container(node)) invalid('Pointer parent does not exist');
    const key = Array.isArray(node) ? index(node, part) : part;
    if (!own(node, key)) invalid('Pointer does not exist');
    node = node[key];
  }
  return node;
}

function write(document, parts, operation, value) {
  if (!parts.length) return operation === 'remove' ? undefined : structuredClone(value);
  const parent = get(document, parts.slice(0, -1));
  if (!container(parent)) invalid('Pointer parent is not a container');
  const key = parts.at(-1);
  if (Array.isArray(parent)) {
    const n = index(parent, key, operation === 'add');
    if (operation === 'remove') parent.splice(n, 1);
    else if (operation === 'add') parent.splice(n, 0, structuredClone(value));
    else parent[n] = structuredClone(value);
  } else {
    if (operation !== 'add' && !own(parent, key)) invalid('Pointer does not exist');
    if (operation === 'remove') delete parent[key];
    else Object.defineProperty(parent, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  return document;
}

/** RFC 6902, evaluated on a detached document. Own-property access prevents prototype traversal. */
export function applyPatch(document, patch) {
  if (!Array.isArray(patch)) invalid('patch must be an array');
  let result = structuredClone(document);
  for (const entry of patch) {
    if (!entry || !['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(entry.op)) invalid('Unknown patch operation');
    const parts = pointer(entry.path);
    if (['add', 'replace', 'test'].includes(entry.op) && !own(entry, 'value')) invalid('value is required');
    if (entry.op === 'test') {
      if (!isDeepStrictEqual(get(result, parts), entry.value)) throw new AdminError(409, 'patch_test_failed', 'JSON Patch test failed');
    } else if (entry.op === 'copy' || entry.op === 'move') {
      const from = pointer(entry.from);
      const value = structuredClone(get(result, from));
      if (entry.op === 'move') {
        if (parts.length > from.length && from.every((part, i) => part === parts[i])) invalid('Cannot move into a child');
        result = write(result, from, 'remove');
      }
      result = write(result, parts, 'add', value);
    } else result = write(result, parts, entry.op, entry.value);
  }
  return result;
}
