// usage-daily-groupby.test.js — MG6a：/internal/usage/daily?groupBy= 维度合并、
// /internal/usage/activity（activeDays / 连续天数 / 峰值日）与 /internal/usage/devices。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { UsageLog, localDay } from '../src/monitor/store.js';
import { createRequestHandler } from '../src/gateway/router.js';
import { EventLog } from '../src/events.js';

const usage = (input, output = 1) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
const served = (ts, extra = {}) => ({ ts, path: '/v1/chat/completions', client: 'pi-agent', providerId: 'glm', model: 'glm-5.3', status: 200, ok: true, usage: usage(10), reported: true, ...extra });
const observedClaude = (ts, extra = {}) => ({ eventId: `ev-${ts}`, ts, model: 'claude-opus-5-5', client: 'claude-sub-sync', providerId: 'claude', path: 'claude-code', usage: usage(20), reported: true, ...extra });
const observedCodex = (ts, extra = {}) => ({ eventId: `cx-${ts}`, ts, model: 'gpt-6-sol', client: 'codex-local-cli', providerId: 'codex-local', path: 'codex-local', usage: usage(30), reported: true, ...extra });

// 固定「现在」，本地日期（今天 - daysAgo）的正午落点——稳定在该日历日内，避开午夜与夏令时边界
const nowMs = Date.now();
const now = new Date(nowMs);
const noonAgo = (daysAgo) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12).toISOString();
const dayAgo = (daysAgo) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12).getTime());
const newLog = () => new UsageLog({ now: () => nowMs });

// glm-5.3 有定价（input/1e3 美元），其余模型定价未知 → 验证 costUnknownRecords
const pricing = { costOf: (u, model) => (model === 'glm-5.3' ? u.input / 1000 : null), costFor: () => null };

async function startServer(t, usageLog) {
  const handler = createRequestHandler({
    config: { gateway: { keys: [] } }, catalog: { providers: [] }, events: new EventLog({ file: null }),
    usageLog, pricing,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('groupBy=day,client：day 升序、其次 tokens 降序；行只含所选维度与聚合字段', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(0)));
  log.record(served(noonAgo(0)));
  log.record(served(noonAgo(0), { client: 'kb-service' }));
  log.record(served(noonAgo(1)));
  const base = await startServer(t, log);
  const data = await (await fetch(`${base}/internal/usage/daily?groupBy=day,client`)).json();
  assert.deepEqual(data.rows, [
    { day: dayAgo(1), client: 'pi-agent', records: 1, requests: 1, usage: usage(10), tokens: 11, cost: 0.01, costUnknownRecords: 0 },
    { day: dayAgo(0), client: 'pi-agent', records: 2, requests: 2, usage: usage(20, 2), tokens: 22, cost: 0.02, costUnknownRecords: 0 },
    { day: dayAgo(0), client: 'kb-service', records: 1, requests: 1, usage: usage(10), tokens: 11, cost: 0.01, costUnknownRecords: 0 },
  ]);
});

test('groupBy=client（无 day）：按 tokens 降序合并全窗口', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(0)));
  log.record(served(noonAgo(3), { client: 'kb-service', usage: usage(30) }));
  const base = await startServer(t, log);
  const data = await (await fetch(`${base}/internal/usage/daily?groupBy=client`)).json();
  assert.deepEqual(data.rows, [
    { client: 'kb-service', records: 1, requests: 1, usage: usage(30), tokens: 31, cost: 0.03, costUnknownRecords: 0 },
    { client: 'pi-agent', records: 1, requests: 1, usage: usage(10), tokens: 11, cost: 0.01, costUnknownRecords: 0 },
  ]);
  const byModel = await (await fetch(`${base}/internal/usage/daily?groupBy=model&model=glm-5.3`)).json();
  assert.deepEqual(byModel.rows, [{ model: 'glm-5.3', records: 2, requests: 2, usage: usage(40, 2), tokens: 42, cost: 0.04, costUnknownRecords: 0 }]);
});

test('groupBy 未知维度（含空值）返回 400；不给 groupBy 时响应与原版一致', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(0)));
  log.record(served(noonAgo(1), { client: 'kb-service' }));
  const base = await startServer(t, log);
  assert.equal((await fetch(`${base}/internal/usage/daily?groupBy=day,bogus`)).status, 400);
  assert.equal((await fetch(`${base}/internal/usage/daily?groupBy=`)).status, 400);
  const data = await (await fetch(`${base}/internal/usage/daily`)).json();
  assert.equal(data.from <= data.to, true);
  assert.equal(data.rows.length, 2);
  assert.deepEqual(data.rows[0], {
    day: dayAgo(1), kind: 'served', client: 'kb-service', providerId: 'glm', model: 'glm-5.3',
    upstreamModel: 'glm-5.3', device: 'gateway', records: 1, requests: 1, usage: usage(10), cost: 0.01,
  });
});

test('groupBy 合并时未知定价行计入 costUnknownRecords，cost 只累加已知部分', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(0), { client: 'kb-service', model: 'mystery-model' }));
  log.record(served(noonAgo(0), { client: 'kb-service' }));
  log.record(served(noonAgo(0)));
  const base = await startServer(t, log);
  const { rows } = await (await fetch(`${base}/internal/usage/daily?groupBy=client`)).json();
  assert.deepEqual(rows, [
    { client: 'kb-service', records: 2, requests: 2, usage: usage(20, 2), tokens: 22, cost: 0.01, costUnknownRecords: 1 },
    { client: 'pi-agent', records: 1, requests: 1, usage: usage(10), tokens: 11, cost: 0.01, costUnknownRecords: 0 },
  ]);
});

test('activity：days 升序、activeDays / currentStreak / longestStreak / peakDay / 汇总', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(0)));
  log.record(served(noonAgo(0)));
  log.record(served(noonAgo(1)));
  log.importObserved([observedClaude(noonAgo(2))]); // observed：requests 0、定价未知
  // dayAgo(3) 留空 → 连续段断开
  log.record(served(noonAgo(4)));
  for (let i = 0; i < 5; i++) log.record(served(noonAgo(5)));
  log.record(served(noonAgo(10)));
  const base = await startServer(t, log);
  const q = `from=${dayAgo(30)}&to=${dayAgo(0)}`;
  const data = await (await fetch(`${base}/internal/usage/activity?${q}`)).json();
  assert.equal(data.from, dayAgo(30));
  assert.equal(data.to, dayAgo(0));
  assert.deepEqual(data.days.map((d) => d.day), [10, 5, 4, 2, 1, 0].map(dayAgo));
  const d2 = data.days.find((d) => d.day === dayAgo(2));
  assert.deepEqual(d2, { day: dayAgo(2), tokens: 21, cost: 0, requests: 0, records: 1 });
  assert.deepEqual(data.stats, {
    activeDays: 6, currentStreak: 3, longestStreak: 3,
    peakDay: { day: dayAgo(5), tokens: 55 },
    totalTokens: 131, totalCost: 0.1,
  });
});

test('activity：今天还没用 → currentStreak 从昨天起算（今天不算中断）', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(1)));
  log.record(served(noonAgo(2)));
  log.record(served(noonAgo(2)));
  const base = await startServer(t, log);
  const data = await (await fetch(`${base}/internal/usage/activity`)).json();
  assert.equal(data.to, dayAgo(0));
  assert.deepEqual(data.days.map((d) => d.day), [dayAgo(2), dayAgo(1)]);
  assert.deepEqual(data.stats, {
    activeDays: 2, currentStreak: 2, longestStreak: 2,
    peakDay: { day: dayAgo(2), tokens: 22 },
    totalTokens: 33, totalCost: 0.03,
  });
});

test('activity/daily 筛选参数生效；无匹配时 stats 归零、peakDay 为 null', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(0)));
  log.importObserved([observedClaude(noonAgo(0))]);
  const base = await startServer(t, log);
  const onlyServed = await (await fetch(`${base}/internal/usage/activity?kind=served`)).json();
  assert.deepEqual(onlyServed.days, [{ day: dayAgo(0), tokens: 11, cost: 0.01, requests: 1, records: 1 }]);
  const onlyPi = await (await fetch(`${base}/internal/usage/activity?client=pi-agent`)).json();
  assert.equal(onlyPi.stats.activeDays, 1);
  const none = await (await fetch(`${base}/internal/usage/activity?device=mac`)).json();
  assert.deepEqual(none, {
    from: none.from, to: none.to, days: [],
    stats: { activeDays: 0, currentStreak: 0, longestStreak: 0, peakDay: null, totalTokens: 0, totalCost: 0 },
  });
  const daily = await (await fetch(`${base}/internal/usage/daily?groupBy=client&client=pi-agent`)).json();
  assert.deepEqual(daily.rows.map((r) => r.client), ['pi-agent']);
  const badRange = await fetch(`${base}/internal/usage/activity?from=2026-12-01&to=2026-01-01`);
  assert.equal(badRange.status, 400);
});

test('devices：按 device×kind 汇总 lastSeen 与近 7 天记录数，lastSeen 降序', async (t) => {
  const log = newLog();
  log.record(served(noonAgo(8))); // 7 天外：计入 lastSeen 竞争、不计 records7d
  log.record(served(noonAgo(2))); // gateway/served：今天起 7 天内 1 条
  log.importObserved([observedClaude(noonAgo(3))]); // nas/observed
  const macTs = noonAgo(0); // mac/observed：最近一条
  log.importObserved([observedCodex(macTs)]);
  const base = await startServer(t, log);
  const { devices } = await (await fetch(`${base}/internal/usage/devices`)).json();
  assert.deepEqual(devices.map((d) => d.device), ['mac', 'gateway', 'nas']);
  assert.deepEqual(devices, [
    { device: 'mac', kind: 'observed', lastSeen: macTs, records7d: 1 },
    { device: 'gateway', kind: 'served', lastSeen: noonAgo(2), records7d: 1 },
    { device: 'nas', kind: 'observed', lastSeen: noonAgo(3), records7d: 1 },
  ]);
});
