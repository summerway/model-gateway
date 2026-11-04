import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeepseekBalanceBody,
  probeDeepseekBalance,
  isDeepseekProvider,
  deepseekBalanceBase,
} from '../src/ops/deepseek-quota.js';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import { EventLog } from '../src/events.js';

test('isDeepseekProvider: only openai-compat providers on api.deepseek.com', () => {
  assert.equal(isDeepseekProvider({ type: 'openai', baseUrl: 'https://api.deepseek.com/v1/chat/completions' }), true);
  assert.equal(isDeepseekProvider({ type: 'openai', baseUrl: 'https://api.example.com/v1' }), false);
  assert.equal(isDeepseekProvider({ type: 'glm', baseUrl: 'https://api.deepseek.com/v1' }), false);
});

test('deepseekBalanceBase derives origin from baseUrl', () => {
  assert.equal(deepseekBalanceBase('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com');
  assert.equal(deepseekBalanceBase('not a url'), 'https://api.deepseek.com');
});

test('parseDeepseekBalanceBody: normal CNY payload', () => {
  const r = parseDeepseekBalanceBody({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '46.20', granted_balance: '30.00', topped_up_balance: '16.20' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.isAvailable, true);
  assert.deepEqual(r.balance, { currency: 'CNY', total: '46.20', granted: '30.00', toppedUp: '16.20' });
});

test('parseDeepseekBalanceBody: picks CNY entry, tolerates missing granted', () => {
  const r = parseDeepseekBalanceBody({
    is_available: false,
    balance_infos: [
      { currency: 'USD', total_balance: '9.99' },
      { currency: 'CNY', total_balance: '1.00' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.isAvailable, false);
  assert.equal(r.balance.currency, 'CNY');
  assert.equal(r.balance.total, '1.00');
  assert.equal(r.balance.granted, null);
  assert.equal(r.balance.toppedUp, null);
});

test('parseDeepseekBalanceBody: error shapes', () => {
  assert.equal(parseDeepseekBalanceBody(null).ok, false);
  assert.equal(parseDeepseekBalanceBody({}).ok, false);
  assert.equal(parseDeepseekBalanceBody({ balance_infos: [] }).ok, false);
  assert.equal(parseDeepseekBalanceBody({ balance_infos: [{ currency: 'CNY' }] }).ok, false);
});

test('probeDeepseekBalance: Bearer auth + happy path', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const fetch = async (url, opts) => {
    seenUrl = url;
    seenAuth = opts.headers.Authorization;
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
    }), { status: 200 });
  };
  const r = await probeDeepseekBalance({
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test',
    fetch,
  });
  assert.equal(seenUrl, 'https://api.deepseek.com/user/balance');
  assert.equal(seenAuth, 'Bearer sk-test');
  assert.equal(r.ok, true);
  assert.equal(r.balance.total, '110.00');
});

test('probeDeepseekBalance: 401 → auth error, never throws', async () => {
  const r = await probeDeepseekBalance({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'bad',
    fetch: async () => new Response('denied', { status: 401 }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /auth failed/);
});

const DS_PROVIDER = {
  id: 'deepseek',
  type: 'openai',
  displayName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1/chat/completions',
  apiKeyRef: 'env:TEST_DS_KEY',
  models: ['deepseek-flash'],
};

test('QuotaProbe probes deepseek providers and snapshots balance', async () => {
  process.env.TEST_DS_KEY = 'sk-ds';
  const events = new EventLog({ limit: 20 });
  const probe = new QuotaProbe({
    providers: [DS_PROVIDER, { id: 'other', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKeyRef: 'env:TEST_DS_KEY', models: ['x'] }],
    events,
    fetch: async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
    }), { status: 200 }),
  });
  assert.equal(probe.providers.length, 1); // non-deepseek openai provider excluded
  const r = await probe.refresh('deepseek', { force: true });
  assert.equal(r.ok, true);
  const snap = probe.snapshot();
  assert.equal(snap.deepseek.ok, true);
  assert.equal(snap.deepseek.quotaBase, 'https://api.deepseek.com');
  assert.equal(snap.deepseek.balance.total, '110.00');
  assert.equal(snap.deepseek.isAvailable, true);
  assert.equal(snap.deepseek.tiers, null);
  assert.equal(snap.other, undefined);
  delete process.env.TEST_DS_KEY;
});
