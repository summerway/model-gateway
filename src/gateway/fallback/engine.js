// engine.js — ordered fallback chain.
// Try providers in order; on retriable failure (network error / gateway timeout / 429 / 5xx),
// advance to the next provider. Non-retriable (400/401/403/404/422, streaming
// already started) → stop and surface the error. Every provider switch records
// an event via the injected sink.

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{providerId?:string, status?:number, kind?:string, retriable?:boolean, cause?:unknown}} opts
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.kind = opts.kind;
    this.retriable = opts.retriable;
    this.cause = opts.cause;
  }
}

/** Non-retriable client statuses (OLP semantics: client errors never fall over). */
const NO_FALLBACK_STATUSES = new Set([400, 401, 403, 404, 422]);

/** Classify a failure for logging: 'network' | 'timeout' | 'rate_limited' | 'server_error' | 'client_error' | 'auth' | 'unhealthy' | 'unknown' */
export function classifyFailure(err) {
  if (!err) return 'unknown';
  if (err.kind === 'unhealthy') return 'unhealthy';
  // 网关自身超时 abort（fetchUpstream timer）：上游慢生成≠不可达，与 network
  // 分开——retriable 切链但不计入熔断（2026-10-26 智谱高峰降速事故修订）。
  if (err.kind === 'timeout') return 'timeout';
  if (err.kind === 'auth') return 'auth';
  if (err.status === 429) return 'rate_limited';
  if (err.status !== undefined && err.status >= 500) return 'server_error';
  if (err.status !== undefined && err.status >= 400) return 'client_error';
  // undici fetch() wraps transport errors as TypeError with the socket error
  // nested in .cause — walk the chain for a errno code.
  const code = err.code ?? err.cause?.code ?? err.cause?.cause?.code;
  const name = err.name ?? err.cause?.name;
  if (
    code === 'UND_ERROR' || code === 'ECONNRESET' || code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' ||
    name === 'AbortError' || name === 'TypeError'
  ) {
    return 'network';
  }
  return 'unknown';
}

/** Should a failure advance the fallback chain? */
export function isRetriable(err) {
  // Explicit override (codex provider semantics: auth=切下一 provider 而非终止链;
  // unhealthy=跳过本 provider)。见 router.js codexErrorToUpstream。
  if (err?.retriable !== undefined) return Boolean(err.retriable);
  const kind = classifyFailure(err);
  if (kind === 'network' || kind === 'rate_limited' || kind === 'server_error' || kind === 'timeout') return true;
  if (kind === 'client_error') {
    return !NO_FALLBACK_STATUSES.has(err.status);
  }
  return false;
}

/**
 * Run an ordered fallback chain.
 *
 * @param {Array} chain - ordered providers ({id, ...})
 * @param {Function} attempt - async (provider, index) => result; throws UpstreamError
 * @param {{model?:string, onEvent?:Function, sink?:Function}} opts
 *   onEvent/sink: (event) => void — called with
 *   {type:'fallback', from, to, reason, model, status, durationMs, ts}
 * @returns {Promise<{result, provider, attempts: Array}>}
 * @throws UpstreamError when the chain is exhausted or a non-retriable failure hit.
 */
export async function runFallbackChain(chain, attempt, opts = {}) {
  const { model, onEvent } = opts;
  const emit = onEvent ?? opts.sink ?? (() => {});
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new UpstreamError('empty fallback chain', { kind: 'no_provider' });
  }

  const attempts = [];
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const startedAt = Date.now();
    try {
      const result = await attempt(provider, i);
      attempts.push({ providerId: provider.id, ok: true, durationMs: Date.now() - startedAt });
      return { result, provider, attempts };
    } catch (err) {
      lastErr = err;
      const reason = classifyFailure(err);
      attempts.push({
        providerId: provider.id,
        ok: false,
        reason,
        status: err.status,
        durationMs: Date.now() - startedAt,
      });
      const hasMore = i + 1 < chain.length;
      if (!hasMore || !isRetriable(err)) break;
      emit({
        type: 'fallback',
        from: provider.id,
        to: chain[i + 1].id,
        reason,
        model,
        status: err.status,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  if (!(lastErr instanceof UpstreamError)) {
    lastErr = new UpstreamError(lastErr?.message ?? 'upstream failed', {
      providerId: attempts.at(-1)?.providerId,
      status: lastErr?.status,
      cause: lastErr,
    });
  }
  if (!lastErr.kind) lastErr.kind = classifyFailure(lastErr.cause ?? lastErr);
  lastErr.attempts = attempts;
  lastErr.exhausted = isRetriable(lastErr) && attempts.length === chain.length; // only fully consumed retriable chain
  throw lastErr;
}
