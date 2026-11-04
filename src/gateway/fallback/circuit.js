// circuit.js — per-provider circuit breaker（issue #3）。
// 状态机：closed → 连续 N 次「请求路径」retriable 失败 → open（冷却期内
// 降级到链尾，绝不移除——单 provider 链照发）→ 冷却期满 → half_open（回到
// 自然位置，下一个打到它的请求即试探）→ 成功 → closed ／ 再失败 → open
// （冷却重启）。open 期间仍打到该 provider 的请求失败同样重启冷却——只有
// 冷却期内零失败才会进入 half_open，试探频率被冷却时长天然限流。
//
// 事件（episode 制，模板抄 recordQuotaTransitions）：首次进入 open 记一条
// circuit_open；恢复记一条 circuit_close。half_open 是内部态不单独发事件。
//
// 计数口径（调用方契约）：只喂 runFallbackChain 的 attempts——请求路径
// 失败；探测（quota probe）失败不混入。reason 过滤：仅 network /
// rate_limited / server_error / unhealthy 计数，client_error（400 等）是
// 调用方问题不算渠道健康度；timeout（网关自身 requestSec/streamSec 超时
// abort）也不计入——上游慢生成≠不可达，熔断只度量可达性（2026-10-26
// 智谱高峰降速事故：非流式 7k+ token 输出 ~235s>120s 超时被归 network
// 连环喂熔断，而链路/配额/流式流量全程正常）。timeout 仍 retriable，
// 切链行为不变。attempt 级流中断（SSE 半途断开）不回喂：
// 熔断只度量「可达性」，流质量归 request_error 事件。
//
// 排序接入：不改变 fallback engine 的 isRetriable 语义（AGENTS.md 风险表
// 红线）——熔断只影响 orderChainByQuota 的链排序。

const DEFAULTS = {
  enabled: true,
  failureThreshold: 3,
  cooldownSec: 120,
};

/** 计入熔断的失败原因（classifyFailure 口径）。 */
const BREAKER_REASONS = new Set(['network', 'rate_limited', 'server_error', 'unhealthy']);

function num(v, def) {
  return v === undefined || v === null ? def : v;
}

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {Array} [opts.providers] — catalog providers（预建 state 供 snapshot 完整；
   *   未列出的 id 首次记录时惰性建，model-guard 热更新目录无需重建实例）
   * @param {object} [opts.circuit] — config.gateway.circuit
   * @param {object} [opts.events] — EventLog
   * @param {() => number} [opts.now] — injectable clock（tests）
   */
  constructor({ providers = [], circuit = {}, events, now } = {}) {
    this.cfg = {
      enabled: circuit.enabled ?? DEFAULTS.enabled,
      failureThreshold: num(circuit.failureThreshold, DEFAULTS.failureThreshold),
      cooldownSec: num(circuit.cooldownSec, DEFAULTS.cooldownSec),
    };
    this.events = events ?? null;
    this.now = now ?? Date.now;
    this.state = new Map(); // providerId -> record
    for (const p of providers) this.#rec(p.id);
  }

  #rec(id) {
    let st = this.state.get(id);
    if (!st) {
      st = {
        providerId: id,
        phase: 'closed', // closed | open（含冷却期满后的 half_open 语义）
        failures: 0, // 连续 retriable 失败数（成功清零）
        openedAt: null, // ms，首次进入 open
        cooldownEndsAt: null, // ms，冷却截止（open 期间失败会顺延）
        lastReason: null,
        lastFailureAt: null,
      };
      this.state.set(id, st);
    }
    return st;
  }

  /** 冷却期内 → true（链排序降级到尾）。half_open（冷却已过）→ false（回自然位当试探）。 */
  isDemoted(id, t = this.now()) {
    if (!this.cfg.enabled) return false;
    const st = this.state.get(id);
    if (!st || st.phase !== 'open') return false;
    return t < st.cooldownEndsAt;
  }

  /** 展示相位：closed | open | half_open。 */
  phase(id, t = this.now()) {
    if (!this.cfg.enabled) return 'closed';
    const st = this.state.get(id);
    if (!st || st.phase !== 'open') return 'closed';
    return t < st.cooldownEndsAt ? 'open' : 'half_open';
  }

  /** 请求成功（headers 级可达即算）：恢复闭环，episode 结束。 */
  recordSuccess(id) {
    if (!this.cfg.enabled) return;
    const st = this.#rec(id);
    const wasOpen = st.phase === 'open';
    st.phase = 'closed';
    st.failures = 0;
    st.openedAt = null;
    st.cooldownEndsAt = null;
    if (wasOpen) {
      this.events?.record('circuit_close', { providerId: id });
    }
  }

  /**
   * 请求路径失败。reason 非 retriable 类（client_error 等）直接忽略；
   * open 期间的失败重启冷却（不开新 episode，不发新事件）。
   */
  recordFailure(id, { reason, status } = {}) {
    if (!this.cfg.enabled) return;
    if (reason !== undefined && reason !== null && !BREAKER_REASONS.has(reason)) return;
    const t = this.now();
    const st = this.#rec(id);
    st.failures += 1;
    st.lastReason = reason ?? null;
    st.lastFailureAt = new Date(t).toISOString();
    if (st.phase === 'open') {
      st.cooldownEndsAt = t + this.cfg.cooldownSec * 1000;
      return;
    }
    if (st.failures >= this.cfg.failureThreshold) {
      st.phase = 'open';
      st.openedAt = t;
      st.cooldownEndsAt = t + this.cfg.cooldownSec * 1000;
      this.events?.record('circuit_open', {
        providerId: id,
        failures: st.failures,
        reason: st.lastReason,
        status: status ?? null,
        cooldownSec: this.cfg.cooldownSec,
      });
    }
  }

  /** 全量快照（dashboard / 测试）。 */
  snapshot() {
    const t = this.now();
    const out = {};
    for (const [id, st] of this.state) {
      const phase = this.phase(id, t);
      out[id] = {
        providerId: id,
        phase,
        failures: phase === 'closed' ? 0 : st.failures,
        cooldownEndsAt: phase === 'open' ? new Date(st.cooldownEndsAt).toISOString() : null,
        lastReason: st.lastReason,
        lastFailureAt: st.lastFailureAt,
      };
    }
    return out;
  }
}
