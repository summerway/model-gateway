// usage-pricing.test.js — PricingStore 覆盖优先级 / models.dev 查价 / 成本计算；config.pricing 校验。

import test from 'node:test';
import assert from 'node:assert/strict';
import { PricingStore } from '../src/monitor/pricing.js';
import { validateConfig } from '../src/config.js';

function apiJson(prices) {
  // prices: { 'glm-5.3': {input, output, cache_read, cache_write}, ... }
  const provs = { glm: 'zai', deepseek: 'deepseek', claude: 'anthropic' };
  return Object.fromEntries(Object.entries(provs).map(([pfx, prov]) => [
    prov,
    { models: Object.fromEntries(Object.entries(prices).filter(([m]) => m.startsWith(pfx)).map(([m, c]) => [m, { cost: c }])) },
  ]));
}

async function store(overrides = {}, prices = {}) {
  const s = new PricingStore({
    overrides,
    fetchFn: async () => ({ ok: true, json: async () => apiJson(prices) }),
  });
  s.start();
  await s.ready;
  return s;
}

test('costFor: config 覆盖优先于 models.dev；upstream 模型优先于请求模型', async () => {
  const s = await store(
    { 'glm-5.3': { input: 99, output: 99, cacheRead: 9, cacheWrite: 9 } },
    { 'glm-5.3': { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 }, 'glm-5.3-flash': { input: 0.5, output: 1 } },
  );
  assert.deepEqual(s.costFor('glm-5.3'), { input: 99, output: 99, cacheRead: 9, cacheWrite: 9 });
  // 请求模型 gpt-6-sol（网关别名，无定价）→ upstream gpt-5.5 不存在 → null
  assert.equal(s.costFor('gpt-6-sol', 'gpt-5.5-sol'), null);
  // upstream 查得到（fallbackModelMap 场景）
  assert.deepEqual(s.costFor('glm-5.3-pro', 'glm-5.3'), { input: 99, output: 99, cacheRead: 9, cacheWrite: 9 });
  assert.deepEqual(s.costFor('glm-5.3-flash'), { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 });
});

test('costFor: 无版本别名（deepseek-flash）进表；零计费条目与缺 cost 条目不进表', async () => {
  const s = await store({}, {
    'deepseek-flash': { input: 0.15, output: 0.6, cache_read: 0.003 },
    'deepseek-v4-flash': { input: 0.15, output: 0.6, cache_read: 0.003 },
    'deepseek-chat': { input: 0, output: 0 }, // 零计费 → 排除
    'glm-4.5-flash': { input: 0, output: 0 }, // 零计费 → 排除
  });
  assert.deepEqual(s.costFor('deepseek-flash'), { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
  assert.deepEqual(s.costFor('deepseek-v4-flash'), { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
  assert.equal(s.costFor('deepseek-chat'), null);
  assert.equal(s.costFor('glm-4.5-flash'), null);
  assert.equal(s.costFor('gpt-image-1.5'), null); // fixture 里无 openai 条目 → null
});

test('costFor: Claude 模型走 anthropic 补充数据源（Claude Code 用量折价）', async () => {
  const s = await store({}, {
    'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
    'claude-free': { input: 0, output: 0 }, // 零计费 → 排除
  });
  assert.deepEqual(s.costFor('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(s.costFor('claude-haiku-5-5'), { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
  assert.equal(s.costFor('claude-free'), null);
  // 1M input + 2M output + 10M cacheRead + 1M cacheWrite（claude-opus-5-5）
  // = 4*1 + 20*2 + 0.2*10 + 5*1 = 51
  const cost = s.costOf({ input: 1e6, output: 2e6, cacheRead: 1e7, cacheWrite: 1e6 }, 'claude-opus-5-5');
  assert.ok(Math.abs(cost - 51) < 1e-9);
});

test('costOf: $/Mtok 折算 + 无定价返回 null', async () => {
  const s = await store({}, { 'glm-5.3': { input: 2, output: 8, cache_read: 0.4, cache_write: 2.5 } });
  // 100 万 input + 50 万 output + 300 万 cacheRead + 1 万 cacheWrite
  const cost = s.costOf({ input: 1e6, output: 5e5, cacheRead: 3e6, cacheWrite: 1e4 }, 'glm-5.3');
  // = 2*1 + 8*0.5 + 0.4*3 + 2.5*0.01 = 2 + 4 + 1.2 + 0.025
  assert.ok(Math.abs(cost - 7.225) < 1e-9);
  assert.equal(s.costOf({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 'no-such-model'), null);
  assert.equal(s.costOf(null, 'glm-5.3'), null);
});

test('PricingStore: 上游拉取失败不致命，保留旧数据', async () => {
  let fail = false;
  const s = new PricingStore({
    fetchFn: async () => {
      if (fail) throw new Error('network down');
      return { ok: true, json: async () => apiJson({ 'glm-5.3': { input: 1, output: 1 } }) };
    },
  }).start();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(s.costFor('glm-5.3'));
  fail = true;
  await s.stop() ?? null; // stop 只清 timer，数据仍在
  assert.ok(s.costFor('glm-5.3'));
  assert.equal(s.lastError, null);
});

test('config: pricing 覆盖校验与归一化', () => {
  const base = {
    providers: [{ id: 'p', type: 'openai', baseUrl: 'https://x.test/chat/completions', apiKeyRef: 'env:K', models: ['m1'] }],
    gateway: { keys: ['k'] },
    jobs: { activate: { enabled: false } },
  };
  const ok = validateConfig({ ...base, pricing: { 'm1': { input: 1.5, output: 6, cacheRead: 0.3 } } });
  assert.deepEqual(ok.pricing, { m1: { input: 1.5, output: 6, cacheRead: 0.3, cacheWrite: 0 } });
  assert.deepEqual(validateConfig(base).pricing, {});
  assert.throws(() => validateConfig({ ...base, pricing: { m1: { input: -1 } } }), /pricing\[m1\].input/);
  assert.throws(() => validateConfig({ ...base, pricing: [] }), /pricing/);
});

test('modalitiesFor: models.dev modalities.input 进表；未收录返回 null；costFor 形态不变', async () => {
  const s = new PricingStore({
    fetchFn: async () => ({ ok: true, json: async () => ({
      zai: { models: { 'glm-5.3': { cost: { input: 1, output: 1 }, modalities: { input: ['text'], output: ['text'] } } } },
      anthropic: { models: {
        'claude-opus-5-5': { cost: { input: 4, output: 20 }, modalities: { input: ['text', 'image', 'pdf'], output: ['text'] } },
        'claude-image-only': { modalities: { input: ['image'], output: ['text'] } }, // 无价但有能力 → 只进能力表
      } },
    }) }),
  }).start();
  await s.ready;
  assert.deepEqual(s.modalitiesFor('claude-opus-5-5'), ['text', 'image', 'pdf']);
  assert.deepEqual(s.modalitiesFor('glm-5.3'), ['text']);
  assert.deepEqual(s.modalitiesFor('claude-image-only'), ['image']);
  assert.equal(s.modalitiesFor('no-such-model'), null);
  // 计价条目形态不受 modalities 捕获影响
  assert.deepEqual(s.costFor('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0, cacheWrite: 0 });
});

// ── 落盘快照（2026-10-30 事故加固）：成功刷新原子落盘；重启 + 上游故障时从缓存恢复 ──
test('pricing: 成功刷新落盘，新实例冷启动可从缓存加载', async () => {
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'mg-pricing-'));
  const cacheFile = join(dir, 'pricing-cache.json');
  const s1 = new PricingStore({
    cacheFile,
    fetchFn: async () => ({ ok: true, json: async () => apiJson({ 'glm-x': { input: 1, output: 2 } }) }),
  });
  s1.start();
  await s1.ready;
  assert.ok(existsSync(cacheFile), '成功刷新后应落盘');
  s1.stop();
  // 重启 + 上游故障：fetch 抛错，但构造时已从缓存加载
  const boom = async () => { throw new Error('upstream down'); };
  const s2 = new PricingStore({ cacheFile, fetchFn: boom, intervalMs: 60 * 60 * 1000 });
  s2.start();
  await s2.ready; // 首次刷新失败（有缓存，不致命）
  assert.equal(s2.costFor('glm-x')?.input, 1, '缓存定价可用');
  assert.ok(s2.lastError, '上游失败被记录');
  s2.stop();
});

