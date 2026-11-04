import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时用 new URL('<相对路径>', import.meta.url) 读取的仓库文件必须被 Dockerfile COPY，
// 否则镜像启动即崩（MG14 的 docs/openapi.json 曾漏拷）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.js') ? [path] : [];
});
const copied = [...readFileSync(join(root, 'Dockerfile'), 'utf8').matchAll(/^COPY\s+(\S+)\s+\S+/gm)].map((m) => m[1].replace(/\/$/, ''));
const covered = (file) => copied.some((src) => file === src || file.startsWith(`${src}/`));

test('Dockerfile 拷贝了 src 运行时读取的所有仓库文件', () => {
  const missing = [];
  for (const file of walk(join(root, 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/new URL\(['"](\.{1,2}\/[^'"$`]+)['"],\s*import\.meta\.url\)/g)) {
      const target = relative(root, resolve(dirname(file), m[1]));
      if (!target.startsWith('..') && !covered(target)) missing.push(`${relative(root, file)} → ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});
