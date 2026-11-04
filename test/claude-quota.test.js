import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseClaudeUsageBody, readClaudeCredentials, probeClaudeUsage, parseIsoMs,
  CLAUDE_API_BASE, CLAUDE_USAGE_PATH,
} from '../src/ops/claude-quota.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));

test('parseClaudeUsageBody: limits[] contract — scoped window wins, weekly = max, weeklyModels detail', () => {
  const r = parseClaudeUsageBody(fixture('claude-usage.json'));
  assert.equal(r.ok, true);
  // ISO 微秒（.123456）截到毫秒
  assert.equal(r.tiers.fiveHour.usedPercent, 42.5);
  assert.equal(r.tiers.fiveHour.resetMs, Date.parse('2026-10-18T14:23:45.123Z'));
  assert.equal(r.tiers.fiveHour.resetsAt, '2026-10-18T14:23:45.123Z');
  // weekly = 已用%最高者：Opus 4.1 scoped 72 > sonnet legacy 55.2 > 全局 31
  assert.equal(r.tiers.weekly.usedPercent, 72);
  assert.equal(r.tiers.weekly.resetMs, Date.parse('2026-10-21T09:00:00.000Z'));
  const names = r.tiers.weeklyModels.map((m) => m.name);
  assert.deepEqual(names, ['Opus 4.1', 'sonnet', '全局']);
  assert.equal(r.tiers.weeklyModels[0].usedPercent, 72);
  assert.equal(r.tiers.weeklyModels[2].usedPercent, 31);
});

test('parseClaudeUsageBody: scoped limits[] 覆盖同名 legacy 窗口（weekly_all 覆盖 seven_day 全局）', () => {
  const r = parseClaudeUsageBody({
    five_hour: { utilization: 10, resets_at: '2026-10-18T14:23:45Z' },
    seven_day: { utilization: 30, resets_at: '2026-10-21T09:00:00Z' },
    limits: [{ kind: 'weekly_all', group: '7d', percent: 25, resets_at: '2026-10-21T09:00:00Z', scope: null }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.tiers.weeklyModels.length, 1);
  assert.equal(r.tiers.weeklyModels[0].name, '全局');
  assert.equal(r.tiers.weeklyModels[0].usedPercent, 25); // limits 覆盖 legacy 30
});

test('parseClaudeUsageBody: legacy-only body（无 limits[]）—— weekly ← seven_day*', () => {
  const r = parseClaudeUsageBody(fixture('claude-usage-legacy.json'));
  assert.equal(r.ok, true);
  assert.equal(r.tiers.weekly.usedPercent, 12);
  assert.equal(r.tiers.weeklyModels.length, 1); // 七天全局；null 桶（seven_day_opus）跳过
  assert.equal(r.tiers.weeklyModels[0].name, '全局');
});

test('parseClaudeUsageBody: idle — five_hour.resets_at 缺失 → resetMs null，不报错', () => {
  const r = parseClaudeUsageBody(fixture('claude-usage-idle.json'));
  assert.equal(r.ok, true);
  assert.equal(r.tiers.fiveHour.usedPercent, 0);
  assert.equal(r.tiers.fiveHour.resetMs, null);
  assert.equal(r.tiers.fiveHour.resetsAt, null);
});

test('parseClaudeUsageBody: extra_usage 字段不参与窗口解析（不报错不进 tiers）', () => {
  const r = parseClaudeUsageBody(fixture('claude-usage.json'));
  assert.ok(!JSON.stringify(r.tiers).includes('extra'));
});

test('parseClaudeUsageBody: 完全无窗口 → ok:false', () => {
  const r = parseClaudeUsageBody({ five_hour: null, seven_day: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /no usage windows/);
});

test('readClaudeCredentials: claudeAiOauth 拼写 + 秒级 expiresAt 归一毫秒', () => {
  const text = JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-fake', refreshToken: 'rt', expiresAt: 1792300800 }, // 秒
  });
  const fs = { readFileSync: () => text };
  const c = readClaudeCredentials('/creds', { fs });
  assert.equal(c.ok, true);
  assert.equal(c.accessToken, 'sk-ant-fake');
  assert.equal(c.expiresAt, 1792300800 * 1000);
});

test('readClaudeCredentials: claude.ai_oauth / claude_ai_oauth 兼容拼写 + 毫秒级原样', () => {
  for (const key of ['claude.ai_oauth', 'claude_ai_oauth']) {
    const fs = { readFileSync: () => JSON.stringify({ [key]: { accessToken: 'a', expiresAt: 1792300800123 } }) };
    const c = readClaudeCredentials('/creds', { fs });
    assert.equal(c.ok, true, key);
    assert.equal(c.expiresAt, 1792300800123);
  }
});

test('readClaudeCredentials: 缺文件/坏 JSON/缺 accessToken → ok:false', () => {
  const missing = readClaudeCredentials('/nope', { fs: { readFileSync: () => { throw new Error('ENOENT'); } } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ENOENT/);
  const bad = readClaudeCredentials('/creds', { fs: { readFileSync: () => 'not json' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid JSON/);
  const noOauth = readClaudeCredentials('/creds', { fs: { readFileSync: () => '{}' } });
  assert.equal(noOauth.ok, false);
  assert.match(noOauth.error, /claudeAiOauth/);
});

test('probeClaudeUsage: URL/头契约（Bearer + oauth beta + Accept）与解析透传', async () => {
  const credsText = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 99999999999999 } });
  const body = fixture('claude-usage.json');
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body };
  };
  const r = await probeClaudeUsage({
    credentialFile: '/creds',
    fetch: fetchFn,
    fs: { readFileSync: () => credsText },
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CLAUDE_API_BASE}${CLAUDE_USAGE_PATH}`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(r.status, 200);
  assert.equal(r.tiers.weekly.usedPercent, 72);
});

test('probeClaudeUsage: 预检 —— 凭据 expiresAt 已过 → 不发 HTTP，tokenExpired 标记（401 风暴根因补丁）', async () => {
  // 真实毫秒级时钟（epochToMs 对小数值按秒处理，勿用 1e6 量级 fixture）
  const T0 = 1_900_000_000_000;
  const credsText = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: T0 - 60_000 } });
  const r = await probeClaudeUsage({
    credentialFile: '/creds',
    fetch: async () => { throw new Error('expired creds must short-circuit before fetch'); },
    fs: { readFileSync: () => credsText },
    now: () => T0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.tokenExpired, true);
  assert.match(r.error, /expired at/);
  // 未注入 now → 默认 Date.now（真实时钟，~2026）：expiresAt 取远过去（2023）
  const pastCreds = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 1_700_000_000_000 } });
  const r2 = await probeClaudeUsage({
    credentialFile: '/creds',
    fetch: async () => { throw new Error('must not fetch'); },
    fs: { readFileSync: () => pastCreds },
  });
  assert.equal(r2.tokenExpired, true);
});

test('probeClaudeUsage: 401 → auth failed；non-JSON → error；凭证不可读 → credentials 前缀', async () => {
  const credsText = JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } });
  const fs = { readFileSync: () => credsText };
  const authFail = await probeClaudeUsage({
    credentialFile: '/creds', fs,
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal(authFail.ok, false);
  assert.match(authFail.error, /auth failed \(HTTP 401\)/);

  const nonJson = await probeClaudeUsage({
    credentialFile: '/creds', fs,
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }),
  });
  assert.equal(nonJson.ok, false);
  assert.match(nonJson.error, /non-JSON/);

  const noCreds = await probeClaudeUsage({
    credentialFile: '/creds',
    fs: { readFileSync: () => { throw new Error('ENOENT'); } },
    fetch: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(noCreds.ok, false);
  assert.match(noCreds.error, /credentials:/);
});

test('parseIsoMs: 微秒截位/无效输入', () => {
  assert.equal(parseIsoMs('2026-10-18T14:23:45.123456+00:00'), Date.parse('2026-10-18T14:23:45.123Z'));
  assert.equal(parseIsoMs('2026-10-18T14:23:45.123Z'), Date.parse('2026-10-18T14:23:45.123Z'));
  assert.equal(parseIsoMs(''), null);
  assert.equal(parseIsoMs(null), null);
  assert.equal(parseIsoMs('not-a-date'), null);
});
