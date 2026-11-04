// codex-reset-forecast.js — codex-reset.com 全局重置预测拉取（dashboard codex 卡片）。
// 数据源 https://codex-reset.com/api/forecast（站点声明式 API 目录
// /.well-known/api-catalog）：24h/48h 重置概率 + 区间 + 置信度 + 上次全局重置。
// 这是社区对 OpenAI「goodwill 全局重置」（周额度提前清零）的历史基线预测，
// 不是官方时间表 —— 展示层保持「预测」口径并外链原站。
// 拉取节奏：intervalSec（默认 30min）低频轮询 + 失败保旧标 stale；纯展示，
// 不参与路由/激活决策。never throws；快照供 /internal/dashboard 聚合。

const DEFAULTS = {
  enabled: true,
  url: 'https://codex-reset.com/api/forecast',
  siteUrl: 'https://codex-reset.com/',
  intervalSec: 30 * 60,
  timeoutSec: 15,
};

/** 归一化 /api/forecast 响应 → 展示快照（多余字段不透传，前端契约稳定）。 */
export function parseForecastBody(json, { fetchedAtMs, siteUrl } = {}) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'response is not an object' };
  const p = json.probabilities ?? {};
  const h24 = pct(p.model_24h ?? p.rounded_24h);
  const h48 = pct(p.model_48h ?? p.rounded_48h);
  if (h24 === null && h48 === null) return { ok: false, error: 'no probabilities in response' };
  const rng = (r) => (Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1])
    ? [Math.round(r[0] * 100), Math.round(r[1] * 100)]
    : null);
  return {
    ok: true,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    sourceUrl: siteUrl,
    updatedAt: typeof json.updated_at === 'string' ? json.updated_at : null,
    h24: { pct: h24, range: rng(p.range_24h) },
    h48: { pct: h48, range: rng(p.range_48h) },
    confidence: typeof json.confidence === 'string' ? json.confidence : null,
    lastResetAt: typeof json.last_reset_at === 'string' ? json.last_reset_at : null,
    ageDays: Number.isFinite(json.age_days) ? json.age_days : null,
    // 上下文态：QUIET（无官方信号）/ 命中信号时 official_signal 有值
    state: typeof json.context?.state === 'string' ? json.context.state : null,
    officialSignal: json.official_signal ?? null,
    cadence: json.cadence && typeof json.cadence === 'object'
      ? {
          recentMedianDays: Number.isFinite(json.cadence.recent_median_days) ? json.cadence.recent_median_days : null,
          accelerating: json.cadence.accelerating === true,
        }
      : null,
  };
}

function pct(v) {
  return Number.isFinite(v) ? Math.round(v) : null;
}

export class CodexResetForecast {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url] - /api/forecast 端点（config.codexResetForecast.url）
   * @param {number} [opts.intervalSec] - 轮询间隔（默认 1800）
   * @param {number} [opts.timeoutSec] - 单次拉取超时（默认 15）
   * @param {Function} [opts.fetch]
   * @param {() => number} [opts.now]
   */
  constructor({ url, siteUrl, intervalSec, timeoutSec, fetch: fetchFn, now } = {}) {
    this.cfg = {
      ...DEFAULTS,
      ...(url !== undefined ? { url } : {}),
      ...(siteUrl !== undefined ? { siteUrl } : {}),
      ...(Number.isFinite(intervalSec) ? { intervalSec } : {}),
      ...(Number.isFinite(timeoutSec) ? { timeoutSec } : {}),
    };
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.now = now ?? Date.now;
    this.snapshotData = null; // 最近一次成功快照
    this.error = null;
    this.fetchedAtMs = null;
    this._timer = null;
    this._inflight = null;
  }

  /** 启动：立即拉取一次 + 定期刷新（失败不致命，保旧数据标 stale）。 */
  start() {
    if (this._timer) return this;
    this.refresh().catch(() => {});
    this._timer = setInterval(() => this.refresh().catch(() => {}), this.cfg.intervalSec * 1000);
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  /** 拉取并归一化；并发单飞。force=true 时即使有数据也重拉。 */
  async refresh({ force = false } = {}) {
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      const t0 = this.now();
      // 节流：距上次成功 < intervalSec 且非 force → 直接复用
      if (!force && this.snapshotData && this.fetchedAtMs !== null &&
          t0 - this.fetchedAtMs < this.cfg.intervalSec * 1000) {
        return this.snapshotData;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutSec * 1000);
      try {
        const resp = await this.fetchFn(this.cfg.url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const parsed = parseForecastBody(json, { fetchedAtMs: this.now(), siteUrl: this.cfg.siteUrl });
        if (!parsed.ok) throw new Error(parsed.error);
        this.snapshotData = parsed;
        this.fetchedAtMs = this.now();
        this.error = null;
        return parsed;
      } catch (e) {
        this.error = e?.name === 'AbortError' ? `timeout after ${this.cfg.timeoutSec}s` : (e?.message ?? String(e));
        // 保旧数据可见（标 stale）；从未成功则快照为失败态
        console.error(`[forecast] codex-reset.com fetch failed: ${this.error}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await this._inflight;
    } finally {
      this._inflight = null;
    }
  }

  /** 只读快照：成功态 / 旧数据标 stale / 失败态。 */
  snapshot() {
    if (this.snapshotData) {
      return {
        ...this.snapshotData,
        stale: this.error !== null,
        ...(this.error !== null ? { error: this.error } : {}),
      };
    }
    return { ok: false, sourceUrl: this.cfg.siteUrl, error: this.error ?? 'not fetched yet' };
  }
}
