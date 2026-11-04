import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeUsageSync, CLAUDE_SUB_SYNC_CLIENT } from '../src/monitor/claude-usage-sync.js';
import { UsageLog } from '../src/monitor/store.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'claude-usage-sync-'));
}

function assistantLine({ id = `msg_${Math.random().toString(36).slice(2, 10)}`, model = 'claude-sonnet-4-5', ts = '2026-10-18T10:00:00.000Z', usage } = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model,
      usage: usage ?? { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 },
    },
  });
}

const USER_LINE = JSON.stringify({ type: 'user', timestamp: '2026-10-18T09:59:00.000Z', message: { role: 'user', content: 'hi' } });

test('首扫：只记 assistant 行、按 message.id 去重、usage 归一（anthropic 语义）', () => {
  const dir = tmp();
  const proj = join(dir, 'proj-a'); mkdirSync(proj);
  const f = join(proj, 'session.jsonl');
  writeFileSync(f, [
    USER_LINE,
    assistantLine({ id: 'msg_1' }),
    assistantLine({ id: 'msg_1' }), // 同 id 重复行 → 去重
    assistantLine({ id: 'msg_2', usage: { input_tokens: 1, output_tokens: 2 } }),
    JSON.stringify({ type: 'result', subtype: 'success' }), // 非 assistant → 跳过
    'not-json-line', // 脏行 → 跳过
  ].join('\n') + '\n');

  const usageLog = new UsageLog({ file: null });
  const sync = new ClaudeUsageSync({ sessionDir: dir, usageLog });
  const r = sync.scan();
  assert.equal(r.files, 1);
  assert.equal(r.records, 2);
  assert.equal(usageLog.buf.length, 2);

  const rec = usageLog.buf[0];
  assert.equal(rec.providerId, 'claude');
  assert.equal(rec.path, 'claude-code');
  assert.equal(CLAUDE_SUB_SYNC_CLIENT, 'claude-sub-sync');
  // 写入侧归一（4e45c42）：claude-sub-sync → claude-code（与应用密钥页实体对齐）
  assert.ok(usageLog.buf.every((r) => r.client === 'claude-code'));
  assert.equal(rec.model, 'claude-sonnet-4-5');
  assert.equal(rec.upstreamModel, 'claude-sonnet-4-5');
  assert.equal(rec.kind, 'observed');
  assert.equal(rec.device, 'nas');
  assert.equal(rec.ok, null); // observed 无成功状态
  assert.equal(rec.reported, true);
  assert.equal(rec.ts, '2026-10-18T10:00:00.000Z');
  // anthropic 语义：input 不折半；cacheRead/cacheWrite 单列
  assert.equal(rec.usage.input, 100);
  assert.equal(rec.usage.output, 20);
  assert.equal(rec.usage.cacheRead, 5);
  assert.equal(rec.usage.cacheWrite, 10);
});

test('字节游标：半行留到下一轮，完整行追加后只处理增量', () => {
  const dir = tmp();
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, assistantLine({ id: 'm1' }) + '\n');

  const usageLog = new UsageLog({ file: null });
  const sync = new ClaudeUsageSync({ sessionDir: dir, usageLog });
  assert.equal(sync.scan().records, 1);

  // 追加半行（无换行）→ 不消费
  appendFileSync(f, assistantLine({ id: 'm2' }).slice(0, 40));
  assert.equal(sync.scan().records, 0);
  assert.equal(usageLog.buf.length, 1);

  // 补齐剩余部分 + 换行 → 恰好 1 条
  appendFileSync(f, assistantLine({ id: 'm2' }).slice(40) + '\n');
  assert.equal(sync.scan().records, 1);
  assert.equal(usageLog.buf.length, 2);
});

test('状态持久化：重启（新实例同 stateFile）不重复记录；游标续传', () => {
  const dir = tmp();
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, assistantLine({ id: 'm1' }) + '\n' + assistantLine({ id: 'm2' }) + '\n');
  const stateFile = join(dir, 'state.json');

  const log1 = new UsageLog({ file: null });
  const s1 = new ClaudeUsageSync({ sessionDir: dir, usageLog: log1, stateFile });
  assert.equal(s1.scan().records, 2);
  assert.ok(existsSync(stateFile));

  // 新进程：游标已到底 → 0 新记录
  const log2 = new UsageLog({ file: null });
  const s2 = new ClaudeUsageSync({ sessionDir: dir, usageLog: log2, stateFile });
  assert.equal(s2.scan().records, 0);
  assert.equal(log2.buf.length, 0);

  // 追加后 → 只记新行
  appendFileSync(f, assistantLine({ id: 'm3' }) + '\n');
  assert.equal(s2.scan().records, 1);
  assert.equal(log2.buf.length, 1);
});

test('文件截断/回绕：size < cursor → 游标归零重读新内容', () => {
  const dir = tmp();
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, assistantLine({ id: 'm1' }) + '\n' + assistantLine({ id: 'm2' }) + '\n');

  const usageLog = new UsageLog({ file: null });
  const sync = new ClaudeUsageSync({ sessionDir: dir, usageLog });
  assert.equal(sync.scan().records, 2);

  // 文件被截断重写（更短，内容不同）
  writeFileSync(f, assistantLine({ id: 'm9' }) + '\n');
  assert.equal(sync.scan().records, 1);
  assert.equal(usageLog.buf.length, 3);
  assert.equal(usageLog.buf[2].usage.input, 100); // 记的是新行 m9（同 usage 形态）
  // m1/m2 的 id 已离开 seen？—— 本实现 seen 持有期内仍去重，但 m9 是新 id
  assert.ok(usageLog.buf.every((r, i, arr) => arr.findIndex((x) => x === r) === i));
});

test('无 usage / 无 model 的 assistant 行也能记账（usage:null, model 兜底）', () => {
  const dir = tmp();
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: '2026-10-18T11:00:00.000Z', message: { id: 'mx' } }) + '\n');

  const usageLog = new UsageLog({ file: null });
  const sync = new ClaudeUsageSync({ sessionDir: dir, usageLog });
  assert.equal(sync.scan().records, 1);
  assert.equal(usageLog.buf[0].usage, null);
  assert.equal(usageLog.buf[0].model, 'claude-unknown');
});

test('sessionDir 缺省 / 不存在：scan 安全返回 0', () => {
  const sync = new ClaudeUsageSync({ usageLog: new UsageLog({ file: null }) });
  assert.deepEqual(sync.scan(), { files: 0, records: 0 });
  const sync2 = new ClaudeUsageSync({ sessionDir: '/nonexistent/xyz', usageLog: new UsageLog({ file: null }) });
  assert.deepEqual(sync2.scan(), { files: 0, records: 0 });
});

test('游标表瘦身：消失的文件不再保留游标（防状态无界增长）', () => {
  const dir = tmp();
  const f1 = join(dir, 'a.jsonl');
  writeFileSync(f1, assistantLine({ id: 'm1' }) + '\n');
  const f2 = join(dir, 'b.jsonl');
  writeFileSync(f2, assistantLine({ id: 'm2' }) + '\n');
  const stateFile = join(dir, 'state.json');

  const sync = new ClaudeUsageSync({ sessionDir: dir, usageLog: new UsageLog({ file: null }), stateFile });
  assert.equal(sync.scan().files, 2);
  assert.equal(sync.cursors.size, 2);
  assert.ok(readFileSync(stateFile, 'utf8').includes('a.jsonl'));
  assert.ok(readFileSync(stateFile, 'utf8').includes('b.jsonl'));

  // b.jsonl 会话归档移走 → 游标瘦身
  rmSync(f2);
  sync.scan();
  assert.equal(sync.cursors.size, 1);
  assert.ok(!readFileSync(stateFile, 'utf8').includes('b.jsonl'));
});

test('去重规则：Claude Code 经网关跑的非 claude-* 模型不导入（served 已记）', () => {
  const dir = tmp();
  const proj = join(dir, 'proj-glm'); mkdirSync(proj);
  writeFileSync(join(proj, 's.jsonl'), [
    assistantLine({ id: 'g1', model: 'glm-5.3' }),
    assistantLine({ id: 's1', model: '<synthetic>' }),
    assistantLine({ id: 'c1', model: 'claude-opus-5-5' }),
  ].join('\n') + '\n');
  const usageLog = new UsageLog({ file: null });
  const r = new ClaudeUsageSync({ sessionDir: dir, usageLog }).scan();
  assert.equal(r.records, 1);
  assert.deepEqual(usageLog.buf.map((x) => x.model), ['claude-opus-5-5']);
});
