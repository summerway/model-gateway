#!/usr/bin/env node
// device-rename.js — 用量库设备改名迁移（MG27：历史 observed device='mac' 来自 MacBook → 'macbook'）。
// 默认 dry-run 只报告受影响行数；加 --apply 才写库（明细改名 + 日聚合合并，同一事务，幂等）。
// 用法：node scripts/device-rename.js --db <usage.db> [--from mac] [--to macbook] [--apply]
// 运行前停止网关或在维护窗口执行（WAL 模式下并发写入安全，但统计口径以执行瞬间为准）。
import { existsSync } from 'node:fs';
import { UsageLog } from '../src/monitor/store.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const dbFile = opt('--db', process.env.USAGE_DB_FILE);
const from = opt('--from', 'mac');
const to = opt('--to', 'macbook');
const apply = argv.includes('--apply');
const slug = /^[a-z0-9][a-z0-9-]{0,31}$/;

if (!dbFile || !existsSync(dbFile)) { console.error('用法：node scripts/device-rename.js --db <usage.db> [--from mac] [--to macbook] [--apply]（库文件不存在）'); process.exit(1); }
if (!slug.test(from) || !slug.test(to) || from === to) { console.error('--from / --to 必须是不同的设备 slug'); process.exit(1); }
const log = new UsageLog({ dbFile });
const result = log.renameDevice(from, to, { dryRun: !apply });
console.log(`${apply ? '已迁移' : 'dry-run'}：${from} → ${to}，明细 ${result.records} 行，日聚合 ${result.daily} 行`);
