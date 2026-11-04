// usage-store.test.js — UsageLog 记录 / 聚合查询 / 保留期清理。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLog, bucketStart, UNMARKED_CLIENT } from '../src/monitor/store.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function rec(log, { at, provider = 'glm-primary', model = 'glm-5.3', upstream = model, ...rest } = {}) {
  return log.record({
    ts: new Date(at).toISOString(),
    providerId: provider, model, upstreamModel: upstream,
    usage: rest.usage ?? { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0 },
    reported: rest.reported ?? true,
    ...rest,
  });
}

test('record/query: 聚合四项 token、成功率、未上报、成本', () => {
  const log = new UsageLog();
  const now = Date.now();
  rec(log, { at: now - 1000, usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0 } });
  rec(log, { at: now - 500, provider: 'deepseek', ok: false, status: 500, usage: null, reported: false });
  rec(log, { at: now - 250, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 20 }, reported: true });

  const r = log.query({
    from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour',
    priceOf: (x) => (x.model === 'glm-5.3' && x.usage ? 0.123456 : null),
  });
  assert.equal(r.totals.requests, 3);
  assert.equal(r.totals.ok, 2);
  assert.equal(r.totals.failed, 1);
  assert.equal(r.totals.unreported, 0); // 失败请求不计未上报
  assert.equal(r.totals.input, 110);
  assert.equal(r.totals.output, 55);
  assert.equal(r.totals.cacheRead, 1000);
  assert.equal(r.totals.cacheWrite, 20);
  assert.equal(r.totals.tokens, 1185);
  // 成本只对有定价的两条 glm 记录累加
  assert.ok(Math.abs(r.totals.cost - (0.123456 * 2)) < 1e-9);
  assert.equal(r.logs.length, 3);
  assert.ok(r.logs[0].ts >= r.logs[1].ts); // 新的在前
  assert.equal(typeof r.logs[0].cost, 'number'); // 单条成本注入
});

test('query: logs 明细默认上限 50 条（/usage 页请求明细），logLimit 可覆盖', () => {
  const log = new UsageLog();
  const now = Date.now();
  for (let i = 0; i < 120; i++) rec(log, { at: now - (120 - i) * 1000 });
  const q = { from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour' };
  assert.equal(log.query(q).logs.length, 50); // 默认 50， newest-first
  assert.equal(log.query({ ...q, logLimit: 5 }).logs.length, 5); // 显式覆盖
});

test('record/query: provider/model 筛选', () => {
  const log = new UsageLog();
  const now = Date.now();
  rec(log, { at: now, provider: 'glm-primary', model: 'glm-5.3' });
  rec(log, { at: now, provider: 'glm-backup', model: 'glm-5.3' });
  rec(log, { at: now, provider: 'deepseek', model: 'deepseek-flash' });
  const base = { from: new Date(now - 1000), to: new Date(now + 1000), unit: 'hour' };
  assert.equal(log.query({ ...base, provider: 'glm-primary' }).totals.requests, 1);
  assert.equal(log.query({ ...base, model: 'deepseek-flash' }).totals.requests, 1);
  assert.equal(log.query({ ...base, provider: 'glm-backup', model: 'glm-5.3' }).totals.requests, 1);
  assert.equal(log.query({ ...base, provider: 'glm-backup', model: 'deepseek-flash' }).totals.requests, 0);
});

test('query: 小时桶分桶 + 空桶补齐 + day 桶', () => {
  const log = new UsageLog();
  const t0 = new Date(2026, 8, 29, 0, 0, 0).getTime(); // 本地 09-29 00:00
  rec(log, { at: t0 + 10 * 60_000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  rec(log, { at: t0 + 65 * 60_000, usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } });

  const r = log.query({ from: new Date(t0), to: new Date(t0 + 3 * HOUR), unit: 'hour' });
  assert.equal(r.buckets.length, 3);
  assert.equal(r.buckets[0].input, 1);
  assert.equal(r.buckets[1].input, 2);
  assert.equal(r.buckets[2].input, 0); // 空桶补零

  const d = log.query({ from: new Date(t0 - 2 * DAY), to: new Date(t0 + 2 * HOUR), unit: 'day' });
  assert.equal(d.buckets.length, 3);
  assert.equal(d.buckets[2].input, 3); // 当日两条合并
});

test('cleanup: 保留期外明细清除，日聚合保留，重启后持久', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-store-'));
  const file = join(dir, 'usage.jsonl');
  try {
    const now = Date.now();
    let clock = now;
    const log = new UsageLog({ file, retentionDays: 35, now: () => clock });
    rec(log, { at: now - 40 * DAY });
    rec(log, { at: now - 30 * DAY });
    rec(log, { at: now - 1000 });
    assert.equal(log.size, 3);
    clock += HOUR; // 时间前进，触发保留期
    const dropped = log.cleanup();
    assert.equal(dropped, 1);
    assert.equal(log.size, 2);
    // 日聚合长期保留：明细清理不影响
    assert.equal(log.queryDaily({ from: '2000-01-01', to: '2999-12-31' }).reduce((a, r) => a + r.records, 0), 3);
    log.close();
    // 重启加载：35 天外不再回来
    const log2 = new UsageLog({ file, retentionDays: 35, now: () => clock });
    assert.equal(log2.size, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bucketStart: hour/day 桶起点对齐本地时间', () => {
  const t = new Date(2026, 8, 29, 13, 47, 21).getTime();
  const h = new Date(bucketStart(t, 'hour'));
  assert.equal(h.getHours(), 13); assert.equal(h.getMinutes(), 0); assert.equal(h.getSeconds(), 0);
  const d = new Date(bucketStart(t, 'day'));
  assert.equal(d.getDate(), 29); assert.equal(d.getHours(), 0);
});

test('query: logLimit 截尾取最新', () => {
  const log = new UsageLog();
  const now = Date.now();
  for (let i = 0; i < 5; i++) rec(log, { at: now - (5 - i) * 1000 });
  const r = log.query({ from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour', logLimit: 2 });
  assert.equal(r.logs.length, 2);
  assert.ok(r.logs[0].ts >= r.logs[1].ts);
});

test('query: clientAbort 单列不计失败（成功率口径）；无标记的历史失败行保守计失败', () => {
  const log = new UsageLog();
  const now = Date.now();
  rec(log, { at: now - 3000 });
  rec(log, { at: now - 2000, ok: false, status: 500, usage: null, reported: false }); // 上游错误
  rec(log, { at: now - 1500, ok: false, status: null, usage: null, reported: false }); // 历史行（无标记）→ 失败
  rec(log, { at: now - 1000, ok: false, status: null, clientAbort: true, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  const r = log.query({ from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour' });
  assert.equal(r.totals.requests, 4);
  assert.equal(r.totals.ok, 1);
  assert.equal(r.totals.failed, 2); // 上游错误 + 历史无标记行
  assert.equal(r.totals.clientAborts, 1);
  assert.equal(r.logs.find((x) => x.clientAbort)?.clientAbort, true);
  // 落盘回读：clientAbort 字段保留
  assert.equal(log.buf.find((x) => x.clientAbort)?.clientAbort, true);
  // #17 status='abort'：仅 logs 池过滤出中断行（totals/buckets 口径不变），logLimit 仍取最新 N 条
  const only = log.query({ from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour', status: 'abort' });
  assert.equal(only.logs.length, 1);
  assert.equal(only.logs[0].clientAbort, true);
  assert.equal(only.totals.requests, 4, '聚合口径不受 status 筛选影响');
  assert.equal(only.totals.clientAborts, 1);
  assert.equal(only.buckets.reduce((a, b) => a + b.requests, 0), 4, '桶图不受 status 筛选影响');
  // 白名单外值忽略：不筛选
  assert.equal(log.query({ from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour', status: 'weird' }).logs.length, 4);
});

test('query: 中断行在 logLimit 窗口外时仍可由 status=abort 捞回', () => {
  const log = new UsageLog();
  const now = Date.now();
  rec(log, { at: now - 3000, ok: false, status: null, clientAbort: true, usage: null, reported: false });
  for (let i = 0; i < 3; i++) rec(log, { at: now - 2000 + i });
  const base = { from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour' };
  assert.equal(log.query(base).logs.length, 4);
  const only = log.query({ ...base, status: 'abort', logLimit: 2 });
  assert.equal(only.logs.length, 1, 'abort 池内取最新 logLimit 条（不与全量竞争窗口）');
  assert.ok(only.logs[0].clientAbort);
});

test('record/query: client 字段（per-app 归因）+ client 筛选；__unmarked__ 匹配空 client', () => {
  const log = new UsageLog();
  const now = Date.now();
  rec(log, { at: now - 3000, client: 'pi-nas' });
  rec(log, { at: now - 2000, client: 'shared' });
  rec(log, { at: now - 1000 }); // 未传 client → null（新代码落盘口径）
  const q = { from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour' };
  assert.equal(log.query(q).totals.requests, 3);
  assert.equal(log.query({ ...q, client: 'pi-nas' }).totals.requests, 1);
  assert.equal(log.query({ ...q, client: 'shared' }).totals.requests, 1);
  assert.equal(log.query({ ...q, client: UNMARKED_CLIENT }).totals.requests, 1); // null client 行
  assert.equal(log.query({ ...q, client: 'nobody' }).totals.requests, 0);
  assert.equal(log.query({ ...q, client: 'pi-nas' }).logs[0].client, 'pi-nas');
  assert.equal(log.buf.find((r) => r.client === null).client, null); // 显式 null 落盘
});

test('load: JSONL 旧格式行无 client 字段读取不报错（视为未标记）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-store-legacy-'));
  const file = join(dir, 'usage.jsonl');
  try {
    const now = Date.now();
    const oldLine = {
      ts: new Date(now - 2000).toISOString(), path: '/v1/chat/completions',
      providerId: 'glm-primary', model: 'glm-5.3', upstreamModel: 'glm-5.3',
      stream: false, status: 200, ok: true, latencyMs: 5,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, reported: true,
    };
    const newLine = { ...structuredClone(oldLine), ts: new Date(now - 1000).toISOString(), client: 'kb-service' };
    writeFileSync(file, [JSON.stringify(oldLine), JSON.stringify(newLine)].join('\n') + '\n');
    const log = new UsageLog({ file });
    assert.equal(log.size, 2); // 旧行解析不报错
    const q = { from: new Date(now - HOUR), to: new Date(now + 1000), unit: 'hour' };
    assert.equal(log.query({ ...q, client: 'kb-service' }).totals.requests, 1);
    assert.equal(log.query({ ...q, client: UNMARKED_CLIENT }).totals.requests, 1); // 旧无 client 行 → 未标记
    assert.equal(log.query(q).totals.requests, 2);
    assert.ok(log.query(q).logs.every((r) => !('ua' in r)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record: shared UA 截断并持久化，其他来源和空 UA 不写字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-store-ua-'));
  const file = join(dir, 'usage.jsonl');
  try {
    const log = new UsageLog({ file });
    rec(log, { at: Date.now(), client: 'shared', ua: 'a'.repeat(150) });
    rec(log, { at: Date.now(), client: 'kb-service', ua: 'private-client' });
    rec(log, { at: Date.now(), client: 'shared', ua: '' });
    rec(log, { at: Date.now(), client: 'shared' });
    const reloaded = new UsageLog({ file });
    assert.equal(reloaded.buf[0].ua, 'a'.repeat(120));
    assert.ok(reloaded.buf.slice(1).every((r) => !('ua' in r)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('queryClients: 每来源当日/窗口累计(total)+全期(totalAll)汇总 + 窗口趋势桶（空桶补齐、排序）', () => {
  const log = new UsageLog();
  const today = new Date(); today.setHours(3, 0, 0, 0);
  const t0 = today.getTime();
  const d = (n) => t0 - n * DAY;
  rec(log, { at: t0 - 1000, client: 'pi-nas', usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } });
  rec(log, { at: t0 - 500, client: 'pi-nas', usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 } });
  rec(log, { at: d(3), client: 'kb-service', usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 } });
  rec(log, { at: d(1), client: 'shared', usage: null, reported: false }); // 无 usage → 0 token 但计请求
  rec(log, { at: d(2) }); // 历史 unmarked
  const cs = log.queryClients({ from: new Date(d(6)), to: new Date(t0 + 1000), unit: 'day' });
  // 排序：total.tokens 降序 → kb-service(10000) > 未标记(1150,rec 默认 usage) > pi-nas(450) > shared(0)
  assert.deepEqual(cs.map((c) => c.client), ['kb-service', null, 'pi-nas', 'shared']);
  const kb = cs[0], um = cs[1], pi = cs[2], sh = cs[3];
  assert.deepEqual(kb.total, { requests: 1, tokens: 10000 });
  assert.deepEqual(kb.today, { requests: 0, tokens: 0 }); // 3 天前
  assert.deepEqual(pi.total, { requests: 2, tokens: 450 });
  assert.deepEqual(pi.today, { requests: 2, tokens: 450 });
  assert.deepEqual(sh.today, { requests: 0, tokens: 0 });
  assert.equal(sh.total.requests, 1); // 无 usage 仍计请求
  assert.deepEqual(um.total, { requests: 1, tokens: 1150 }); // rec 默认 usage：100+50+1000
  // 趋势桶：7 天窗口 day 桶全量补齐（含空桶），kb-service 的 10000 落在 3 天前那桶
  assert.equal(kb.buckets.length, 7);
  assert.ok(kb.buckets.every((b) => typeof b.t === 'string'));
  const kbHit = kb.buckets.find((b) => b.tokens > 0);
  assert.ok(kbHit && kbHit.tokens === 10000 && kbHit.requests === 1);
  // pi-nas 记录在 t0（今日 03:00），窗口 [d(6), t0+1s) 含今日 → 当日桶应有值
  const lastBucket = pi.buckets[pi.buckets.length - 1];
  assert.equal(lastBucket.tokens, 450);
  // provider/model 筛选照常生效
  const cs2 = log.queryClients({ from: new Date(d(6)), to: new Date(t0 + 1000), unit: 'day', provider: 'nobody' });
  assert.equal(cs2.length, 0);
  // 窗口外排除：窗口缩到 [d(2), t0+1s) 后，kb-service（d(3)）不进 total，但 totalAll 仍全量
  const cs3 = log.queryClients({ from: new Date(d(2)), to: new Date(t0 + 1000), unit: 'day' });
  const kb3 = cs3.find((c) => c.client === 'kb-service');
  assert.deepEqual(kb3.total, { requests: 0, tokens: 0 });
  assert.deepEqual(kb3.totalAll, { requests: 1, tokens: 10000 });
  const pi3 = cs3.find((c) => c.client === 'pi-nas');
  assert.deepEqual(pi3.total, { requests: 2, tokens: 450 });
  assert.deepEqual(pi3.totalAll, { requests: 2, tokens: 450 });
  // 排序跟窗口 total：窗口内 kb-service 为 0 → 不再榜首
  assert.notEqual(cs3[0].client, 'kb-service');
});
