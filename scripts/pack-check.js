#!/usr/bin/env node
// pack-check.js — npm pack 发布物门禁（MG16）：
// 必需文件在（CLI 可用、配置示例在），私有/无关内容不在（test、docs/plan、site、
// 真实 config、secrets、assets）。失败列出违规项并退出 1。
import { spawnSync } from 'node:child_process';

const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
if (res.error) { console.error(`✖ 无法运行 npm pack：${res.error.message}`); process.exit(1); }

let files;
try {
  const parsed = JSON.parse(res.stdout);
  files = (Array.isArray(parsed) ? parsed[0] : parsed).files.map((f) => f.path);
} catch {
  console.error('✖ npm pack --json 输出无法解析：');
  console.error(res.stdout || res.stderr);
  process.exit(1);
}

const MUST_HAVE = ['bin/model-gateway.js', 'src/server.js', 'config/config.example.yaml', 'docs/openapi.json', 'config/config.schema.json'];
const MUST_NOT = [
  [/^test\//, 'test/'],
  [/^docs\/plan\//, 'docs/plan/'],
  [/^site\//, 'site/'],
  [/^config\/config\.yaml$/, 'config/config.yaml'],
  [/^config\/secrets\//, 'config/secrets/'],
  [/^assets\//, 'assets/'],
];

const missing = MUST_HAVE.filter((f) => !files.includes(f));
const banned = files.filter((f) => MUST_NOT.some(([re]) => re.test(f)));

if (missing.length || banned.length) {
  for (const m of missing) console.error(`✖ 缺少必需文件 ${m}`);
  for (const b of banned) console.error(`✖ 不应打包 ${b}`);
  process.exit(1);
}
console.log(`✔ npm pack 清单共 ${files.length} 个文件：必需项齐全，无禁打包项`);
