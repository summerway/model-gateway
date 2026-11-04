// dashscope-quota.test.js — 阿里云百炼展示位余额探测（BSS QueryAccountBalance）：
// 签名 URL 结构、响应/错误映射、QuotaProbe embeddings 合成条目与快照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signedBalanceUrl, probeAliyunBalance, BSS_API_BASE } from '../src/ops/aliyun-bss.js';
import { QuotaProbe } from '../src/ops/jobs/quota-probe.js';
import { EventLog } from '../src/events.js';

// ── 签名 URL 结构（RPC v1 HMAC-SHA1）──

test('signedBalanceUrl: 参数排序 + RFC3986 percentEncode + HMAC-SHA1 结构', () => {
  const url = new URL(signedBalanceUrl({
    accessKeyId: 'LTAI5test',
    accessKeySecret: 'secret',
    timestamp: '2026-10-26T04:00:00Z',
    nonce: 'nonce-1',
  }));
  assert.equal(url.origin, BSS_API_BASE); // business.aliyuncs.com（bssopenapi 已退役）
  const q = url.searchParams;
  assert.equal(q.get('Action'), 'QueryAccountBalance');
  assert.equal(q.get('Version'), '2017-12-14');
  assert.equal(q.get('Format'), 'JSON');
  assert.equal(q.get('SignatureMethod'), 'HMAC-SHA1');
  assert.equal(q.get('SignatureVersion'), '1.0');
  assert.equal(q.get('AccessKeyId'), 'LTAI5test');
  assert.equal(q.get('Timestamp'), '2026-10-26T04:00:00Z');
  assert.equal(q.get('SignatureNonce'), 'nonce-1');
  // 签名可独立复算：canonical = 排序参数（percentEncode 后）join '&'，再整体
  // percentEncode 进 StringToSign = GET&%2F&<canon>；key = secret + '&'
  const pct = (s) => encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
  const canon = [...url.searchParams.entries()]
    .filter(([k]) => k !== 'Signature')
    .map(([k, v]) => `${k}=${pct(v)}`)
    .sort()
    .join('&');
  const expect = createHmac('sha1', 'secret&').update(`GET&%2F&${pct(canon)}`).digest('base64');
  assert.equal(q.get('Signature'), expect);
});

test('signedBalanceUrl: 冒号时间戳被编码（query 安全）', () => {
  const raw = signedBalanceUrl({
    accessKeyId: 'id', accessKeySecret: 's',
    timestamp: '2026-10-26T04:00:00Z', nonce: 'n',
  });
  assert.doesNotMatch(raw.slice(raw.indexOf('?')), /:/); // 查询串无裸冒号
});

// ── probeAliyunBalance 响应/错误映射 ──

const OK_BODY = {
  Success: true, Code: '200', Message: 'successful',
  Data: {
    AvailableAmount: '19.73', AvailableCashAmount: '19.73',
    CreditAmount: '0.00', MybankCreditAmount: '0.00', Currency: 'CNY',
  },
};

test('probeAliyunBalance: happy path → balance 映射（total/cash/credit）', async () => {
  let seenUrl = '';
  const r = await probeAliyunBalance({
    accessKeyId: 'id', accessKeySecret: 'sec',
    fetch: async (u) => { seenUrl = u; return { ok: true, status: 200, json: async () => OK_BODY }; },
  });
  assert.match(seenUrl, /\?AccessKeyId=/); // query 带公共参数
  assert.equal(r.ok, true);
  assert.deepEqual(r.balance, { currency: 'CNY', total: '19.73', cash: '19.73', credit: '0.00' });
});

test('probeAliyunBalance: 403（RAM 授权未生效）→ ok:false 带 Code/Message', async () => {
  const r = await probeAliyunBalance({
    accessKeyId: 'id', accessKeySecret: 'sec',
    fetch: async () => ({
      ok: false, status: 403,
      json: async () => ({ Success: false, Code: 'Forbidden.RAM', Message: 'not authorized' }),
    }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
  assert.match(r.error, /Forbidden\.RAM/);
  assert.match(r.error, /not authorized/);
});

test('probeAliyunBalance: 网络错误 / 非 JSON / Success:false / 缺凭据', async () => {
  const net = await probeAliyunBalance({
    accessKeyId: 'id', accessKeySecret: 'sec',
    fetch: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(net.ok, false);
  assert.match(net.error, /network error/);

  const nonJson = await probeAliyunBalance({
    accessKeyId: 'id', accessKeySecret: 'sec',
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }),
  });
  assert.equal(nonJson.ok, false);
  assert.match(nonJson.error, /unexpected response/);

  const noData = await probeAliyunBalance({
    accessKeyId: 'id', accessKeySecret: 'sec',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ Success: false }) }),
  });
  assert.equal(noData.ok, false);

  assert.equal((await probeAliyunBalance({ accessKeyId: null, accessKeySecret: null })).ok, false);
});

// ── QuotaProbe embeddings 合成条目 ──

test('QuotaProbe: embeddings 余额 ref 配齐 → dashscope 条目 + aliyun 快照', async () => {
  process.env.BSS_AK_ID = 'LTAI5test';
  process.env.BSS_AK_SEC = 'sec';
  const probe = new QuotaProbe({
    providers: [],
    jobs: { probe: { intervalSec: 300, cacheTtlSec: 300 } },
    events: new EventLog(10),
    embeddings: {
      type: 'dashscope',
      balanceAccessKeyIdRef: 'env:BSS_AK_ID',
      balanceAccessKeySecretRef: 'env:BSS_AK_SEC',
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => OK_BODY }),
    now: () => 1_700_000_000_000,
  });
  try {
    assert.deepEqual([...probe.state.keys()], ['dashscope']); // 合成条目（无 apiKey 预检失败）
    assert.equal(probe.state.get('dashscope').kind, 'aliyun');
    const r = await probe.refresh('dashscope', { force: true });
    assert.equal(r.ok, true);
    const snap = probe.snapshot().dashscope;
    assert.equal(snap.ok, true);
    assert.equal(snap.quotaBase, BSS_API_BASE);
    assert.equal(snap.balance.total, '19.73');
    assert.equal(snap.balance.currency, 'CNY');
    assert.equal(snap.tiers, null);
    assert.equal(snap.stale, false);
  } finally {
    delete process.env.BSS_AK_ID;
    delete process.env.BSS_AK_SEC;
  }
});

test('QuotaProbe: 未配 balance ref → 无 dashscope 条目（卡片维持静态声明）', () => {
  const probe = new QuotaProbe({
    providers: [], jobs: {}, events: new EventLog(10),
    embeddings: { type: 'dashscope', apiKeyRef: 'env:X', workspaceIdRef: 'env:Y' },
  });
  assert.equal(probe.state.size, 0);
});

test('QuotaProbe: balance ref 解析失败（env 缺失）→ 同样不入列', () => {
  const probe = new QuotaProbe({
    providers: [], jobs: {}, events: new EventLog(10),
    embeddings: {
      type: 'dashscope',
      balanceAccessKeyIdRef: 'env:BSS_MISSING_1',
      balanceAccessKeySecretRef: 'env:BSS_MISSING_2',
    },
  });
  assert.equal(probe.state.size, 0);
});

test('QuotaProbe: aliyun 探测失败 → backoff + probe_error 事件，快照 ok:false', async () => {
  process.env.BSS_AK_ID = 'LTAI5test';
  process.env.BSS_AK_SEC = 'sec';
  const events = new EventLog(10);
  const probe = new QuotaProbe({
    providers: [], jobs: { probe: {} }, events,
    embeddings: {
      type: 'dashscope',
      balanceAccessKeyIdRef: 'env:BSS_AK_ID',
      balanceAccessKeySecretRef: 'env:BSS_AK_SEC',
    },
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ Code: 'Forbidden.RAM' }) }),
    now: () => 1_700_000_000_000,
  });
  try {
    const r = await probe.refresh('dashscope', { force: true });
    assert.equal(r, null);
    const snap = probe.snapshot().dashscope;
    assert.equal(snap.ok, false);
    assert.match(snap.lastError, /403/);
    assert.equal(snap.backingOff, true);
    assert.equal(events.list({ limit: 5 }).some((e) => e.type === 'probe_error' && e.providerId === 'dashscope'), true);
  } finally {
    delete process.env.BSS_AK_ID;
    delete process.env.BSS_AK_SEC;
  }
});
