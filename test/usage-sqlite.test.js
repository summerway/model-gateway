// usage-sqlite.test.js — MG5：node:sqlite 存储的迁移、日聚合、kind/device、保留期与 /internal/usage/daily。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLog, localDay } from '../src/monitor/store.js';
import { createRequestHandler } from '../src/gateway/router.js';
import { EventLog } from '../src/events.js';

const DAY = 24 * 60 * 60 * 1000;
const usage = (input) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 });
const served = (ts, extra = {}) => ({ ts, path: '/v1/chat/completions', client: 'pi-agent', providerId: 'glm', model: 'glm-5.3', status: 200, ok: true, usage: usage(10), reported: true, ...extra });

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-sqlite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('迁移：旧 usage.jsonl 一次性导入、跳过非 claude observed、改名备份、重启幂等', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'usage.jsonl');
  const now = Date.now();
  const iso = (ago) => new Date(now - ago).toISOString();
  const lines = [
    served(iso(5000)),
    { ...served(iso(4000)), client: 'claude-sub-sync', path: 'claude-code', providerId: 'claude', model: 'glm-5.3' }, // 重复计数 → 跳过
    { ...served(iso(3000)), client: 'claude-sub-sync', path: 'claude-code', providerId: 'claude', model: '<synthetic>' }, // 跳过
    { ...served(iso(2000)), client: 'claude-sub-sync', path: 'claude-code', providerId: 'claude', model: 'claude-opus-5-5' },
    { eventId: 'e1', kind: 'subscription', ts: iso(1000), model: 'gpt-6-sol', client: 'codex-local-app', providerId: 'codex-local', path: 'codex-local', ok: null, usage: usage(7), reported: true },
    served(iso(200 * DAY)), // 保留期外
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot-json\n');
  const log = new UsageLog({ file, now: () => now });
  assert.equal(log.size, 3);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.migrated`), true);
  assert.equal(existsSync(join(dir, 'usage.db')), true);
  const rows = log.buf;
  assert.deepEqual(rows.map((r) => [r.kind, r.device]), [['served', 'gateway'], ['observed', 'nas'], ['observed', 'mac']]);
  assert.equal(rows[1].ok, null);
  log.close();
  // 重启：库非空，不重复导入（即使旧文件被放回）
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const again = new UsageLog({ file, now: () => now });
  assert.equal(again.size, 3);
  again.close();
});

test('日聚合与明细合计一致；observed 不计请求数；kind 筛选', () => {
  const now = Date.now();
  const log = new UsageLog({ now: () => now });
  log.record(served(new Date(now - 3000).toISOString()));
  log.record(served(new Date(now - 2000).toISOString(), { ok: false, status: 502, usage: null, reported: false }));
  log.importObserved([{ eventId: 'x1', ts: new Date(now - 1000).toISOString(), model: 'gpt-6-sol', client: 'codex-local-cli', providerId: 'codex-local', path: 'codex-local', usage: usage(5), reported: true }]);
  assert.equal(log.importObserved([{ eventId: 'x1', ts: new Date(now - 1000).toISOString(), model: 'gpt-6-sol', client: 'codex-local-cli', usage: usage(5), reported: true }]), 0, 'eventId 幂等');

  const q = { from: new Date(now - DAY), to: new Date(now + 1000), unit: 'hour' };
  const all = log.query(q);
  assert.equal(all.totals.requests, 2);
  assert.equal(all.totals.subscriptionRecords, 1);
  assert.equal(all.totals.input, 15);
  assert.equal(log.query({ ...q, kind: 'served' }).totals.input, 10);
  assert.equal(log.query({ ...q, kind: 'observed' }).totals.requests, 0);

  const daily = log.queryDaily({ from: localDay(now - DAY), to: localDay(now) });
  const sum = daily.reduce((a, r) => ({ records: a.records + r.records, requests: a.requests + r.requests, input: a.input + r.usage.input }), { records: 0, requests: 0, input: 0 });
  assert.deepEqual(sum, { records: 3, requests: 2, input: all.totals.input });
  assert.deepEqual(daily.map((r) => r.device).sort(), ['gateway', 'mac']);
  assert.equal(log.queryDaily({ from: localDay(now), to: localDay(now), kind: 'observed' })[0]?.client, 'codex');
});

test('默认保留 90 天：89 天前保留，91 天前清除', () => {
  const now = Date.now();
  const log = new UsageLog({ now: () => now });
  log.record(served(new Date(now - 89 * DAY).toISOString()));
  log.record(served(new Date(now - 91 * DAY).toISOString()));
  assert.equal(log.cleanup(), 1);
  assert.equal(log.size, 1);
});

test('GET /internal/usage/daily：日期默认窗口、筛选与 cost', async (t) => {
  const now = Date.now();
  const usageLog = new UsageLog();
  usageLog.record(served(new Date(now - 1000).toISOString()));
  usageLog.record(served(new Date(now - 500).toISOString(), { client: 'kb-service' }));
  const handler = createRequestHandler({
    config: { gateway: { keys: [] } }, catalog: { providers: [] }, events: new EventLog({ file: null }),
    usageLog, pricing: { costOf: (u) => u.input / 1000, costFor: () => null },
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/internal/usage/daily`;
  const all = await (await fetch(base)).json();
  assert.equal(all.to, localDay(now));
  assert.equal(all.rows.length, 2);
  assert.equal(all.rows[0].cost, 0.01);
  const one = await (await fetch(`${base}?client=kb-service`)).json();
  assert.deepEqual(one.rows.map((r) => r.client), ['kb-service']);
  assert.equal((await fetch(`${base}?from=2026-12-01&to=2026-01-01`)).status, 400);
});
