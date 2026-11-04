// glm-quota.test.js — monitor endpoint response parsing (fixtures) + base resolution + request shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGlmQuotaBody, glmQuotaBase, probeGlmQuota } from '../src/ops/glm-quota.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('personal fixture: two TOKENS_LIMIT entries classified by unit (3=5h, 6=weekly)', () => {
  const body = JSON.parse(readFileSync(join(fixtures, 'glm-quota-personal.json'), 'utf8'));
  const parsed = parseGlmQuotaBody(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.level, 'MAX3');
  assert.equal(parsed.tiers.fiveHour.usedPercent, 26.0);
  assert.equal(parsed.tiers.fiveHour.resetMs, 1789560000000);
  assert.equal(parsed.tiers.fiveHour.resetsAt, new Date(1789560000000).toISOString());
  assert.equal(parsed.tiers.weekly.usedPercent, 5.0);
  assert.equal(parsed.tiers.weekly.resetMs, 1789992000000);
});

test('error fixture: success:false → ok:false with msg', () => {
  const body = JSON.parse(readFileSync(join(fixtures, 'glm-quota-error.json'), 'utf8'));
  const parsed = parseGlmQuotaBody(body);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /token is invalid/);
});

test('no-unit fixture: heuristic fallback (earlier/absent reset → 5h first)', () => {
  const body = JSON.parse(readFileSync(join(fixtures, 'glm-quota-no-unit.json'), 'utf8'));
  const parsed = parseGlmQuotaBody(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tiers.fiveHour.usedPercent, 80.0);
  assert.equal(parsed.tiers.weekly.usedPercent, 10.0);
});

test('single old-plan entry (no unit, no reset) degrades to fiveHour only', () => {
  const parsed = parseGlmQuotaBody({
    success: true,
    data: { level: 'LITE', limits: [{ type: 'TOKENS_LIMIT', percentage: 42.5 }] },
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tiers.fiveHour.usedPercent, 42.5);
  assert.equal(parsed.tiers.fiveHour.resetMs, null);
  assert.equal(parsed.tiers.weekly, undefined);
});

test('non-quota entry types skipped; case-insensitive type match', () => {
  const parsed = parseGlmQuotaBody({
    success: true,
    data: {
      limits: [
        { type: 'OTHER_LIMIT', percentage: 99 },
        { type: 'tokens_limit', percentage: 10, nextResetTime: 1789560000001, unit: 3 },
      ],
    },
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tiers.fiveHour.usedPercent, 10);
});

test('missing data / non-object → ok:false', () => {
  assert.equal(parseGlmQuotaBody({ success: true }).ok, false);
  assert.equal(parseGlmQuotaBody(null).ok, false);
});

test('glmQuotaBase: bigmodel / z.ai / unknown hosts', () => {
  assert.equal(glmQuotaBase('https://open.bigmodel.cn/api/paas/v4/chat/completions'), 'https://open.bigmodel.cn');
  assert.equal(glmQuotaBase('https://api.z.ai/api/paas/v4/chat/completions'), 'https://api.z.ai');
  assert.equal(glmQuotaBase('https://custom.example/api/paas/v4/chat/completions'), 'https://custom.example');
});

test('probeGlmQuota request shape: raw Authorization (no Bearer), correct URL', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      success: true,
      data: { level: 'X', limits: [{ type: 'TOKENS_LIMIT', percentage: 1, nextResetTime: 1789560000000, unit: 3 }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await probeGlmQuota({
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: 'raw-key-123',
    fetch: fakeFetch,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(calls[0].init.headers.Authorization, 'raw-key-123'); // NO Bearer prefix
  assert.equal(calls[0].init.headers['Accept-Language'], 'en-US,en');
});

test('probeGlmQuota: 401 → authFailed; 200+success:false → error; non-JSON → error', async () => {
  const r401 = await probeGlmQuota({
    baseUrl: 'https://api.z.ai/x',
    apiKey: 'bad',
    fetch: async () => new Response('nope', { status: 401 }),
  });
  assert.equal(r401.ok, false);
  assert.equal(r401.authFailed, true);

  const rBizErr = await probeGlmQuota({
    baseUrl: 'https://api.z.ai/x',
    apiKey: 'k',
    fetch: async () => new Response(JSON.stringify({ success: false, msg: 'boom' }), { status: 200 }),
  });
  assert.equal(rBizErr.ok, false);
  assert.match(rBizErr.error, /boom/);

  const rNonJson = await probeGlmQuota({
    baseUrl: 'https://api.z.ai/x',
    apiKey: 'k',
    fetch: async () => new Response('<html>', { status: 200 }),
  });
  assert.equal(rNonJson.ok, false);
  assert.match(rNonJson.error, /non-JSON/);
});

test('probeGlmQuota: network failure → ok:false with network error', async () => {
  const r = await probeGlmQuota({
    baseUrl: 'https://api.z.ai/x',
    apiKey: 'k',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /network error/);
});
