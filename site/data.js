// site/data.js — 产品页确定性演示数据（MG21）。
// 零依赖 IIFE：固定种子 mulberry32 生成 365 天日记录，「今天」取页面加载时的本地日期；
// 不访问网络，唯一的时间来源是构造时的 new Date()。MG22（视图导览）与 MG23（Activity）
// 的所有数字都必须从 window.MGDemo 的聚合接口得出，不允许另行硬编码统计数字。
(function (root) {
  'use strict';

  const SEED = 20261104; // 固定种子：同一天加载，数据逐字节可复现
  const DAY_COUNT = 365;
  const DAY_MS = 86400000;

  /* ── 维度与名称 ── */
  const NAMES = {
    source: {
      'claude-code': { zh: 'Claude Code', en: 'Claude Code', kind: 'agent', icon: 'claudecode' },
      codex: { zh: 'Codex', en: 'Codex', kind: 'agent', icon: 'codex' },
      pi: { zh: 'Pi', en: 'Pi', kind: 'agent', icon: 'pi' },
      openclaw: { zh: 'OpenClaw', en: 'OpenClaw', kind: 'agent', icon: 'openclaw' },
      kb: { zh: '知识库', en: 'Knowledge base', kind: 'app' },
      bookmarks: { zh: '书签收藏', en: 'Bookmarks', kind: 'app' },
      nightly: { zh: '夜间巡检', en: 'Nightly check', kind: 'app' },
      game: { zh: '小游戏', en: 'Mini game', kind: 'app' },
    },
    model: {
      'glm-5.3': { zh: 'glm-5.3', en: 'glm-5.3' },
      'glm-5.3-flash': { zh: 'glm-5.3-flash', en: 'glm-5.3-flash' },
      'deepseek-flash': { zh: 'deepseek-flash', en: 'deepseek-flash' },
      'deepseek-v4-pro': { zh: 'deepseek-v4-pro', en: 'deepseek-v4-pro' },
      'gpt-6-sol': { zh: 'gpt-6-sol', en: 'gpt-6-sol' },
      'gpt-6-luna': { zh: 'gpt-6-luna', en: 'gpt-6-luna' },
      'claude-opus-5-5': { zh: 'claude-opus-5.5', en: 'claude-opus-5.5' },
      'claude-sonnet-5-5': { zh: 'claude-sonnet-5.5', en: 'claude-sonnet-5.5' },
      'text-embedding-v4': { zh: 'text-embedding-v4', en: 'text-embedding-v4' },
    },
    channel: {
      'glm-primary': { zh: '智谱 1', en: 'Zhipu 1' },
      'glm-backup': { zh: '智谱 2', en: 'Zhipu 2' },
      deepseek: { zh: 'DeepSeek', en: 'DeepSeek' },
      codex: { zh: 'OpenAI', en: 'OpenAI' },
      claude: { zh: 'Claude', en: 'Claude' },
      dashscope: { zh: '阿里云百炼', en: 'Alibaba Bailian' },
    },
    device: {
      gateway: { zh: '网关', en: 'Gateway' },
      nas: { zh: 'NAS', en: 'NAS' },
      mac: { zh: 'Mac', en: 'Mac' },
    },
  };

  /* ── 价格表（$/Mtok：input / output / cacheRead）——演示用，量级参考 models.dev ── */
  const PRICES = {
    'glm-5.3': [0.60, 2.20, 0.11],
    'glm-5.3-flash': [0.11, 0.40, 0.03],
    'deepseek-flash': [0.28, 0.42, 0.07],
    'deepseek-v4-pro': [0.55, 2.20, 0.14],
    'gpt-6-sol': [1.25, 10.00, 0.125],
    'gpt-6-luna': [2.50, 10.00, 0.25],
    'claude-opus-5-5': [5.00, 25.00, 0.50],
    'claude-sonnet-5-5': [3.00, 15.00, 0.30],
    'text-embedding-v4': [0.07, 0, 0],
  };
  // 各模型 token 构成（input / output / cacheRead / cacheWrite）与单次请求量级（演示用）
  const TOKEN_SHAPE = {
    'glm-5.3': [0.06, 0.10, 0.76, 0.08],
    'glm-5.3-flash': [0.16, 0.24, 0.48, 0.12],
    'deepseek-flash': [0.18, 0.26, 0.44, 0.12],
    'deepseek-v4-pro': [0.06, 0.10, 0.76, 0.08],
    'gpt-6-sol': [0.05, 0.09, 0.78, 0.08],
    'gpt-6-luna': [0.06, 0.12, 0.74, 0.08],
    'claude-opus-5-5': [0.05, 0.11, 0.76, 0.08],
    'claude-sonnet-5-5': [0.06, 0.12, 0.73, 0.09],
    'text-embedding-v4': [0.92, 0.08, 0, 0],
  };
  const REQ_TOKENS = {
    'glm-5.3': 8500, 'glm-5.3-flash': 2600, 'deepseek-flash': 3000, 'deepseek-v4-pro': 9000,
    'gpt-6-sol': 11000, 'gpt-6-luna': 9000, 'claude-opus-5-5': 16000, 'claude-sonnet-5-5': 12000,
    'text-embedding-v4': 1400,
  };
  // 首选渠道：today().fallbacks 按首选渠道当日失败数的 60% 计（演示口径）
  const PRIMARY_CHANNEL = {
    'glm-5.3': 'glm-primary', 'glm-5.3-flash': 'glm-primary', 'deepseek-flash': 'deepseek',
    'deepseek-v4-pro': 'deepseek', 'gpt-6-sol': 'codex', 'gpt-6-luna': 'codex',
    'claude-opus-5-5': 'claude', 'claude-sonnet-5-5': 'claude', 'text-embedding-v4': 'dashscope',
  };

  /* ── 来源画像：渠道/模型组合与权重（served 经网关；observed 订阅直连）。
     device 字段只用于拓扑与来源说明，不参与记录生成 ── */
  const PLANS = {
    'claude-code': { device: 'mac', ramp: 0.9, combos: [
      ['glm-primary', 'glm-5.3', 'served', 0.52], ['glm-primary', 'glm-5.3-flash', 'served', 0.18],
      ['glm-backup', 'glm-5.3', 'served', 0.10], ['deepseek', 'deepseek-v4-pro', 'served', 0.08],
      ['claude', 'claude-opus-5-5', 'observed', 0.08], ['claude', 'claude-sonnet-5-5', 'observed', 0.04],
    ] },
    codex: { device: 'mac', ramp: 1.0, combos: [
      ['codex', 'gpt-6-sol', 'served', 0.30], ['codex', 'gpt-6-luna', 'served', 0.12],
      ['codex', 'gpt-6-sol', 'observed', 0.42], ['codex', 'gpt-6-luna', 'observed', 0.16],
    ] },
    pi: { device: 'mac', ramp: 1.0, combos: [
      ['glm-primary', 'glm-5.3', 'served', 0.45], ['glm-primary', 'glm-5.3-flash', 'served', 0.30],
      ['glm-backup', 'glm-5.3-flash', 'served', 0.25],
    ] },
    openclaw: { device: 'nas', ramp: 1.1, combos: [
      ['glm-backup', 'glm-5.3-flash', 'served', 0.60], ['deepseek', 'deepseek-flash', 'served', 0.40],
    ] },
    kb: { device: 'nas', ramp: 1.5, combos: [
      ['glm-primary', 'glm-5.3-flash', 'served', 0.55], ['dashscope', 'text-embedding-v4', 'served', 0.45],
    ] },
    bookmarks: { device: 'nas', ramp: 1.2, combos: [
      ['dashscope', 'text-embedding-v4', 'served', 0.60], ['glm-primary', 'glm-5.3-flash', 'served', 0.40],
    ] },
    nightly: { device: 'gateway', ramp: 0.9, combos: [
      ['deepseek', 'deepseek-flash', 'served', 0.55], ['glm-backup', 'glm-5.3-flash', 'served', 0.45],
    ] },
    game: { device: 'nas', ramp: 1.3, combos: [
      ['glm-backup', 'glm-5.3', 'served', 0.55], ['deepseek', 'deepseek-v4-pro', 'served', 0.45],
    ] },
  };
  // 工作日 / 周末的来源权重（周末只有个人用法：夜间巡检停跑）
  const DAY_WEIGHTS = {
    work: { 'claude-code': 0.30, codex: 0.16, pi: 0.10, openclaw: 0.06, kb: 0.14, bookmarks: 0.05, nightly: 0.12, game: 0.07 },
    rest: { 'claude-code': 0.40, codex: 0.12, pi: 0.12, openclaw: 0.10, kb: 0.10, bookmarks: 0.08, game: 0.08 },
  };

  /* ── mulberry32：唯一随机源 ── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(SEED);

  /* ── 日期工具：全部走本地时区的「天」── */
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayAt = (offsetFromToday) => { const d = new Date(today); d.setDate(d.getDate() + offsetFromToday); return d; };
  const TODAY_KEY = dayKey(today);

  /* ── 休眠日（整天为 0）：约 6%，最近 20 天内不出现；并保证「最长连续」≠「当前连续」── */
  function zeroDayOffsets() {
    const zeros = new Set();
    for (let off = DAY_COUNT - 21; off >= 21; off--) if (rnd() < 0.068) zeros.add(off);
    // 清空 120–180 天前这一窗：留出一段 ≥ 61 天的长活跃期，最长连续必然 ≥ 61
    for (let off = 180; off >= 120; off--) zeros.delete(off);
    if (!zeros.size) { zeros.add(60); zeros.add(240); }
    // 把最近的休眠日收紧到 21–25 天前：当前连续 ≤ 25，与 ≥ 61 的最长连续必然不同
    const nearest = Math.min(...zeros);
    zeros.delete(nearest);
    let near = 21 + Math.floor(rnd() * 5);
    while (zeros.has(near)) near = near >= 25 ? 21 : near + 1;
    zeros.add(near);
    return zeros;
  }
  const ZERO_DAYS = zeroDayOffsets();

  /* ── 生成 365 天记录 ── */
  const RECORDS = [];
  const BASE_DAY_TOKENS = 55e6; // 近期一个工作日的总 token 量级（2 千万–8 千万）
  for (let i = 0; i < DAY_COUNT; i++) { // i = 距今天数（0 = 今天）
    const date = dayAt(-i);
    if (ZERO_DAYS.has(i)) continue; // 休眠日：整天无记录
    const weekday = date.getDay();
    const weekend = weekday === 0 || weekday === 6;
    const t = 1 - i / (DAY_COUNT - 1);      // 0 = 一年前，1 = 今天
    const growth = 0.55 + 0.45 * t;         // 缓慢增长
    const jitter = 0.7 + rnd() * 0.7;
    const dayTotal = BASE_DAY_TOKENS * (weekend ? 0.3 : 1) * growth * jitter;
    const weights = DAY_WEIGHTS[weekend ? 'rest' : 'work'];
    const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
    for (const [source, w] of Object.entries(weights)) {
      const plan = PLANS[source];
      const srcRamp = growth * (0.45 + 0.55 * Math.pow(t, plan.ramp)); // 各来源自己的爬坡
      const srcTokens = dayTotal * (w / weightSum) * srcRamp / growth * (0.8 + rnd() * 0.4);
      for (const [channel, model, kind, cw] of plan.combos) {
        const tokens = srcTokens * cw * (0.5 + rnd());
        if (tokens < 1000) continue;
        const [ri, ro, rc, rw] = TOKEN_SHAPE[model];
        const input = Math.round(tokens * ri);
        const output = Math.round(tokens * ro);
        const cacheRead = Math.round(tokens * rc);
        const cacheWrite = Math.round(tokens * rw);
        const [pi, po, pc] = PRICES[model];
        const costUsd = input / 1e6 * pi + output / 1e6 * po + cacheRead / 1e6 * pc;
        const rec = {
          date: dayKey(date), source, channel, model, kind,
          // 设备口径：served 一律由网关记账；observed 的 claude-code/codex 来自 Mac 采集，
          // 其中 claude-code 约 15% 记到 NAS（模拟 NAS 上的 claude-usage-sync）
          device: kind === 'observed' ? (source === 'claude-code' && rnd() < 0.15 ? 'nas' : 'mac') : 'gateway',
          input, output, cacheRead, cacheWrite,
          requests: null, fail: 0, abort: 0, latencyMs: null, costUsd,
        };
        if (kind === 'served') {
          rec.requests = Math.max(1, Math.round(tokens / REQ_TOKENS[model] * (0.8 + rnd() * 0.4)));
          rec.fail = Math.round(rec.requests * (0.006 + rnd() * 0.02));
          rec.abort = Math.round(rec.requests * rnd() * 0.008);
          const fast = model === 'text-embedding-v4';
          rec.latencyMs = Math.round(fast ? 120 + rnd() * 280 : 900 + rnd() * 3300);
        }
        RECORDS.push(Object.freeze(rec));
      }
    }
  }
  // 时间正序排列（旧 → 新）
  RECORDS.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  Object.freeze(RECORDS);

  /* ── 语言状态 ── */
  let LANG = 'zh';
  const langListeners = [];

  const nameOf = (dim, key, lang) => {
    const entry = NAMES[dim] && NAMES[dim][key];
    if (!entry) return key;
    return (lang === 'en' ? entry.en : entry.zh) ?? key;
  };
  const isServedLike = (rec) => rec.kind !== 'observed';
  const inDays = (rec, days) => rec.date >= dayKey(dayAt(-(days - 1)));

  function query({ days = 30, kind = 'all', source, model, channel } = {}) {
    const out = [];
    for (const r of RECORDS) {
      if (!inDays(r, days)) continue;
      if (kind !== 'all' && r.kind !== kind) continue;
      if (source && r.source !== source) continue;
      if (model && r.model !== model) continue;
      if (channel && r.channel !== channel) continue;
      out.push({ ...r });
    }
    return out;
  }

  function totals(records) {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, costUsd: 0, requests: null, fail: 0, abort: 0, successRate: null, cacheHitRate: 0 };
    let hasServed = false;
    for (const r of records) {
      t.input += r.input; t.output += r.output; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite;
      t.costUsd += r.costUsd;
      if (isServedLike(r)) { hasServed = true; t.requests = (t.requests ?? 0) + r.requests; t.fail += r.fail; t.abort += r.abort; }
    }
    t.tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
    if (hasServed && t.requests > 0) t.successRate = (t.requests - t.fail - t.abort) / t.requests;
    const crDenom = t.cacheRead + t.input;
    t.cacheHitRate = crDenom > 0 ? t.cacheRead / crDenom : 0;
    return t;
  }

  function daySpan(records) {
    let min = null, max = null;
    for (const r of records) {
      if (min === null || r.date < min) min = r.date;
      if (max === null || r.date > max) max = r.date;
    }
    return { min, max };
  }
  const dateNumber = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const keyFromNumber = (n) => dayKey(new Date(n));

  function byDay(records, dimension) {
    if (!records.length) return [];
    const { min, max } = daySpan(records);
    const buckets = new Map();
    for (let n = dateNumber(min); n <= dateNumber(max); n += DAY_MS) buckets.set(keyFromNumber(n), { date: keyFromNumber(n), tokens: 0, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(dimension ? { series: {} } : {}) });
    const dimKey = dimension === 'source' ? 'source' : dimension === 'model' ? 'model' : dimension === 'channel' ? 'channel' : dimension === 'device' ? 'device' : null;
    if (dimension && !dimKey) throw new Error(`byDay: unknown dimension ${dimension}`);
    for (const r of records) {
      const b = buckets.get(r.date);
      if (!b) continue;
      b.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      b.costUsd += r.costUsd;
      b.input += r.input; b.output += r.output; b.cacheRead += r.cacheRead; b.cacheWrite += r.cacheWrite;
      if (dimKey) b.series[r[dimKey]] = (b.series[r[dimKey]] ?? 0) + r.input + r.output + r.cacheRead + r.cacheWrite;
    }
    return [...buckets.values()];
  }

  function groupBy(records, dimension) {
    const dims = ['source', 'model', 'channel', 'device'];
    if (!dims.includes(dimension)) throw new Error(`groupBy: unknown dimension ${dimension}`);
    const map = new Map();
    for (const r of records) {
      const g = map.get(r[dimension]) ?? { key: r[dimension], tokens: 0, costUsd: 0, requests: null };
      g.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      g.costUsd += r.costUsd;
      if (isServedLike(r)) g.requests = (g.requests ?? 0) + r.requests;
      map.set(r[dimension], g);
    }
    const total = [...map.values()].reduce((a, g) => a + g.tokens, 0);
    return [...map.values()]
      .map((g) => ({ key: g.key, name: nameOf(dimension, g.key, LANG), tokens: g.tokens, costUsd: g.costUsd, requests: g.requests, share: total > 0 ? g.tokens / total : 0 }))
      .sort((a, b) => b.tokens - a.tokens);
  }

  function activity(kind = 'all') {
    const records = kind === 'all' ? RECORDS : RECORDS.filter((r) => r.kind === kind);
    const days = byDay(records.length ? [records[0], records[records.length - 1]] : [], null); // 全跨度首尾撑开连续区间
    const perDay = new Map(byDay(records).map((d) => [d.date, d]));
    const all = days.map((d) => perDay.get(d.date) ?? { date: d.date, tokens: 0, costUsd: 0 });
    let activeDays = 0, currentStreak = 0, longestStreak = 0, run = 0;
    let peak = { date: all[0]?.date ?? TODAY_KEY, tokens: 0 };
    const modelTotals = new Map();
    let totalTokens = 0, totalCost = 0, requests = null;
    for (const d of all) {
      if (d.tokens > 0) { activeDays++; run++; } else run = 0;
      longestStreak = Math.max(longestStreak, run);
      if (d.tokens > peak.tokens) peak = { date: d.date, tokens: d.tokens };
    }
    for (let i = all.length - 1; i >= 0 && all[i].tokens > 0; i--) currentStreak++;
    for (const r of records) {
      totalTokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      totalCost += r.costUsd;
      modelTotals.set(r.model, (modelTotals.get(r.model) ?? 0) + r.input + r.output + r.cacheRead + r.cacheWrite);
      if (isServedLike(r)) requests = (requests ?? 0) + r.requests;
    }
    let topModel = null, best = -1;
    for (const [m, v] of modelTotals) if (v > best) { best = v; topModel = m; }
    return { days: all, activeDays, currentStreak, longestStreak, peak, totalTokens, totalCost, topModel, requests };
  }

  // 额度卡（演示值）：5h / 本周两道口径 + 重置分钟数与状态
  function quota() {
    const statusOf = (five, week) => Math.max(five, week) >= 85 ? 'soon-exhausted' : Math.max(five, week) >= 70 ? 'watch' : 'normal';
    const cards = [
      { id: 'glm-primary', used5h: 72, usedWeek: 41, resetIn5h: 96, resetInWeek: 4320 },
      { id: 'glm-backup', used5h: 8, usedWeek: 15, resetIn5h: 214, resetInWeek: 6480 },
      { id: 'codex', used5h: 34, usedWeek: 63, resetIn5h: 152, resetInWeek: 2880 },
      { id: 'claude', used5h: 91, usedWeek: 58, resetIn5h: 27, resetInWeek: 1980 },
    ];
    return cards.map((c) => ({
      id: c.id,
      name: nameOf('channel', c.id, LANG),
      used5h: c.used5h, usedWeek: c.usedWeek,
      resetIn5h: c.resetIn5h, resetInWeek: c.resetInWeek,
      status: statusOf(c.used5h, c.usedWeek),
    }));
  }

  function todayStats() {
    const records = query({ days: 1 });
    const t = totals(records);
    // 接力切换（演示口径）：首选渠道当日失败的 60% 视为触发了接力，占比目标 0.5%–3%
    let primaryFail = 0;
    for (const r of records) if (isServedLike(r) && r.channel === PRIMARY_CHANNEL[r.model]) primaryFail += r.fail;
    return { requests: t.requests, successRate: t.successRate, fallbacks: Math.round(primaryFail * 0.6), tokens: t.tokens, costUsd: t.costUsd };
  }

  const fmt = {
    tokens(n, lang) {
      const l = lang ?? LANG;
      const v = Number(n) || 0;
      if (l === 'en') {
        return v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'K' : String(Math.round(v));
      }
      return v >= 1e8 ? (v / 1e8).toFixed(2) + ' 亿' : v >= 1e4 ? Math.round(v / 1e4).toLocaleString('en-US') + ' 万' : String(Math.round(v));
    },
    usd(n) {
      const v = Number(n) || 0;
      return '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
    },
  };

  root.MGDemo = {
    records: RECORDS,
    query,
    totals,
    byDay,
    groupBy,
    activity,
    quota,
    today: todayStats,
    names: NAMES,
    fmt,
    palette: ['#4477aa', '#ee6677', '#228833', '#ccbb44', '#66ccee', '#aa3377', '#dd8b3a', '#3148a8', '#8a6d0f', '#00876c'],
    get lang() { return LANG; },
    onLang(fn) { langListeners.push(fn); return () => { const i = langListeners.indexOf(fn); if (i >= 0) langListeners.splice(i, 1); }; },
    setLang(lang) {
      if (lang !== 'zh' && lang !== 'en') return;
      if (LANG === lang) return;
      LANG = lang;
      for (const fn of [...langListeners]) fn();
    },
  };
})(globalThis);
