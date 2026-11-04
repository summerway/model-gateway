// codex-reset-forecast.test.js — codex-reset.com /api/forecast 拉取与归一化。
// 契约：字段映射（probabilities.rounded_* + range_* + confidence + last_reset_at）、
// 节流（intervalSec 内非 force 不重拉）、失败保旧标 stale、单飞并发合并、
// 快照失败态。外链 sourceUrl 固定站点根，卡片可直接跳转。

import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexResetForecast, parseForecastBody } from '../src/ops/jobs/codex-reset-forecast.js';

const NOW = 1_800_000_000_000;

function apiBody(over = {}) {
  return {
    probabilities: { rounded_24h: 22, rounded_48h: 39, range_24h: [0.05, 0.45], range_48h: [0.18, 0.62] },
    confidence: 'low',
    last_reset_at: '2026-10-01T00:00:00Z',
    age_days: 21.4,
    updated_at: '2026-10-22T08:00:00Z',
    context: { state: 'QUIET' },
    official_signal: null,
    cadence: { recent_median_days: 19.5, accelerating: false },
    ...over,
  };
}

function resp(json) {
  return { ok: true, status: 200, json: async () => json };
}

test('parseForecastBody: 字段映射与区间换算（小数→整数百分比）', () => {
  const s = parseForecastBody(apiBody(), { fetchedAtMs: NOW, siteUrl: 'https://codex-reset.com/' });
  assert.equal(s.ok, true);
  assert.equal(s.h24.pct, 22);
  assert.equal(s.h48.pct, 39);
  assert.deepEqual(s.h24.range, [5, 45]);
  assert.deepEqual(s.h48.range, [18, 62]);
  assert.equal(s.confidence, 'low');
  assert.equal(s.lastResetAt, '2026-10-01T00:00:00Z');
  assert.equal(s.ageDays, 21.4);
  assert.equal(s.state, 'QUIET');
  assert.equal(s.cadence.recentMedianDays, 19.5);
  assert.equal(s.sourceUrl, 'https://codex-reset.com/');
  // 官方信号形态：official_signal 出现（context.state 随之变化）
  const s2 = parseForecastBody(apiBody({ official_signal: { kind: 'announcement' }, context: { state: 'SIGNALED' } }), { fetchedAtMs: NOW });
  assert.equal(s2.officialSignal.kind, 'announcement');
  assert.equal(s2.state, 'SIGNALED');
});

test('parseForecastBody: 无 probabilities → 显式失败（站点改版防静默）', () => {
  assert.equal(parseForecastBody({}, {}).ok, false);
  assert.equal(parseForecastBody(null, {}).ok, false);
  assert.equal(parseForecastBody({ probabilities: {} }, {}).ok, false);
});

test('refresh: 成功 → 快照 ok；intervalSec 内节流；force 重拉', async () => {
  let fetched = 0;
  let body = apiBody();
  const t = { now: NOW };
  const f = new CodexResetForecast({ fetch: async () => { fetched += 1; return resp(body); }, now: () => t.now });
  const s1 = await f.refresh();
  assert.equal(s1.ok, true);
  assert.equal(fetched, 1);

  t.now += 60_000; // < intervalSec(默认1800s)
  await f.refresh();
  assert.equal(fetched, 1, '节流期内不重拉');

  body = apiBody({ probabilities: { rounded_24h: 60, rounded_48h: 80, range_24h: [0.4, 0.8], range_48h: [0.6, 0.95] } });
  await f.refresh({ force: true });
  assert.equal(fetched, 2);
  assert.equal(f.snapshot().h24.pct, 60);
  assert.equal(f.snapshot().stale, false, '成功后 stale=false');
});

test('refresh: 失败保旧数据标 stale；从未成功 → 失败快照（不 throw）', async () => {
  let fail = false;
  const t = { now: NOW };
  const f = new CodexResetForecast({ fetch: async () => { if (fail) throw new Error('ECONNRESET'); return resp(apiBody()); }, now: () => t.now });
  await f.refresh();
  fail = true;
  t.now += 3_600_000;
  const s = await f.refresh({ force: true });
  assert.equal(s, null);
  const snap = f.snapshot();
  assert.equal(snap.ok, true);
  assert.equal(snap.stale, true);
  assert.match(snap.error, /ECONNRESET/);

  const fresh = new CodexResetForecast({ fetch: async () => { throw new Error('boom'); }, now: () => t.now });
  await fresh.refresh({ force: true });
  assert.equal(fresh.snapshot().ok, false);
  assert.match(fresh.snapshot().error, /boom/);
});

test('refresh: HTTP 非 200 → 失败；单飞并发合并为一次拉取', async () => {
  let calls = 0;
  const f = new CodexResetForecast({
    fetch: async () => { calls += 1; return { ok: false, status: 503, json: async () => ({}) }; },
    now: () => NOW,
  });
  const results = await Promise.all([f.refresh(), f.refresh(), f.refresh()]);
  assert.equal(calls, 1, '并发单飞');
  assert.deepEqual(results.map((r) => r), [null, null, null]);
  assert.match(f.snapshot().error, /HTTP 503/);
});

test('start/stop: 定时器生命周期（unref 不阻退出；stop 后可重启）', async () => {
  let calls = 0;
  const f = new CodexResetForecast({ intervalSec: 3600, fetch: async () => { calls += 1; return resp(apiBody()); }, now: () => NOW });
  f.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1, 'start 立即拉取一次');
  f.stop();
  const again = f.start(); // 幂等/可重启
  assert.equal(again, f);
  f.stop();
});
