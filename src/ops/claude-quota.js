// claude-quota.js — Claude 消费级订阅（Pro/Max）OAuth 用量探测客户端 + 解析器。
// Endpoint contract source of truth: cc-switch src-tauri/src/services/subscription.rs
//  - GET https://api.anthropic.com/api/oauth/usage
//      Authorization: Bearer <accessToken>
//      anthropic-beta: oauth-2025-04-20
//      Accept: application/json
//    accessToken 来自 Claude Code 凭据文件（.credentials.json）的
//    claudeAiOauth.accessToken（兼容 claude.ai_oauth / claude_ai_oauth 拼写）。
//  - Response:
//      { five_hour:{utilization(0-100 已用%),resets_at(ISO 可带微秒)},
//        seven_day:{...}, seven_day_<model>:null|{...}, extra_usage:{...},
//        limits:[{kind:"session"|"weekly_all"|"weekly_scoped",group,percent,
//                 severity,resets_at,scope:{model:{display_name}}|null,is_active}] }
//  - 凭据纪律：网关永不刷新 token（挂载只读；access token 由 Claude Code CLI
//    在别处运行时轮换）。预检（2026-10-22 修正）：文件 expiresAt 已过 → 直接
//    跳过 API 调用返回明确错误 —— 此前"过期仍调用"会在 CLI 惰性刷新的空窗
//    （每 8h TTL 里最长约 2h40m）持续 401，并触发上游 429 限流连坐正常流量；
//    探测退避 + 网关侧 token-refresh 哨兵（window-activator）接管该空窗。
//  - credentials expiresAt 可能秒或毫秒：>1e12 视为毫秒（历史两种形态都出现过）。

import { readFileSync } from 'node:fs';

export const CLAUDE_API_BASE = 'https://api.anthropic.com';
export const CLAUDE_USAGE_PATH = '/api/oauth/usage';

/** 用量监控页基址（quota-probe 快照的 quotaBase 用）。 */
export const claudeQuotaBase = () => CLAUDE_API_BASE;

/** 秒/毫秒两种 epoch 归一为毫秒（>1e12 已是毫秒）；无效 → null。 */
function epochToMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v > 1e12 ? v : v * 1000;
}

/** ISO 串（可带 >3 位小数秒/微秒）→ ms；无效/空 → null。 */
export function parseIsoMs(s) {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 读取 Claude Code 凭据文件（只读，绝不写回）。
 * @param {string} file 凭据文件路径（容器内挂载，建议 ro）
 * @param {{fs?:{readFileSync:Function}}} [opts] 可注入 fs（测试）
 * @returns {{ok:true, accessToken:string, refreshToken:string|null,
 *            expiresAt:number|null, refreshTokenExpiresAt:number|null}
 *          | {ok:false, error:string}}
 */
export function readClaudeCredentials(file, { fs } = {}) {
  const rd = fs?.readFileSync ?? readFileSync;
  let text;
  try {
    text = rd(file, 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${e?.message ?? e}` };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: `invalid JSON in ${file}` };
  }
  // 三种历史拼写都接受（当前 Claude Code 写 claudeAiOauth）
  const oauth = obj?.claudeAiOauth ?? obj?.['claude.ai_oauth'] ?? obj?.claude_ai_oauth;
  if (!oauth || typeof oauth !== 'object' || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return { ok: false, error: `no claudeAiOauth.accessToken in ${file}` };
  }
  return {
    ok: true,
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken ? oauth.refreshToken : null,
    expiresAt: epochToMs(oauth.expiresAt),
    refreshTokenExpiresAt: epochToMs(oauth.refreshTokenExpiresAt),
  };
}

/** 顶层窗口对象（utilization/resets_at）→ tier 形态（GLM/codex 同形，下游共享）。 */
function winToTier(w) {
  if (!w || typeof w !== 'object') return null;
  const usedPercent = typeof w.utilization === 'number' ? w.utilization : null;
  if (usedPercent === null) return null;
  const resetMs = parseIsoMs(w.resets_at);
  return {
    usedPercent,
    resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
    resetMs,
  };
}

/**
 * Parse the /api/oauth/usage body（纯函数 — fixtures 单测）。
 * Returns { ok, tiers: { fiveHour?, weekly?, weeklyModels? }, error? } —
 * fiveHour ← five_hour；weekly ← seven_day* 全体 + limits[] 的
 * weekly_all/weekly_scoped 合并后取已用% 最高者；scoped（limits[] 新契约）
 * 覆盖同名 legacy 窗口；weeklyModels 明细数组（含各 scoped 模型）供展示。
 * tier 形态与 GLM/codex 一致：{usedPercent, resetsAt, resetMs}。
 */
export function parseClaudeUsageBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, tiers: {}, error: 'response is not an object' };
  const fiveHour = winToTier(body.five_hour);

  // weekly 候选收集：legacy 顶层 seven_day* 窗口先入表，limits[] 后入（同名覆盖）
  const models = new Map(); // name(lower) → {name, usedPercent, resetsAt, resetMs}
  for (const [key, w] of Object.entries(body)) {
    if (key !== 'seven_day' && !key.startsWith('seven_day_')) continue;
    const tier = winToTier(w);
    if (!tier) continue; // null 桶（无 scoped 用量）/形态不符 → 跳过
    const name = key === 'seven_day' ? '全局' : key.slice('seven_day_'.length);
    models.set(name.toLowerCase(), { name, ...tier });
  }
  if (Array.isArray(body.limits)) {
    for (const lim of body.limits) {
      if (!lim || typeof lim !== 'object') continue;
      if (lim.kind !== 'weekly_all' && lim.kind !== 'weekly_scoped') continue;
      const usedPercent = typeof lim.percent === 'number' ? lim.percent : null;
      if (usedPercent === null) continue;
      const resetMs = parseIsoMs(lim.resets_at);
      const name = lim.kind === 'weekly_scoped'
        ? (lim.scope?.model?.display_name ?? lim.group ?? 'scoped')
        : '全局';
      models.set(name.toLowerCase(), {
        name,
        usedPercent,
        resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
        resetMs,
      });
    }
  }

  const weeklyModels = [...models.values()].sort((a, b) => b.usedPercent - a.usedPercent);
  const weekly = weeklyModels.length
    ? { usedPercent: weeklyModels[0].usedPercent, resetsAt: weeklyModels[0].resetsAt, resetMs: weeklyModels[0].resetMs }
    : null;

  if (!fiveHour && !weekly) return { ok: false, tiers: {}, error: 'no usage windows in response' };
  const tiers = {};
  if (fiveHour) tiers.fiveHour = fiveHour;
  if (weekly) {
    tiers.weekly = weekly;
    tiers.weeklyModels = weeklyModels;
  }
  return { ok: true, tiers };
}

/**
 * Probe Claude subscription usage（never throws — returns {ok:false,error}）。
 * 每次调用现读凭据文件取 token（CLI 随时可能轮换；挂载只读）。
 * 预检：文件 expiresAt 已过 → 不发请求，返回 tokenExpired:true 的明确错误
 *（止血 401 风暴→429 连坐；见文件头注释）。
 * @param {{credentialFile:string, fetch?:Function, timeoutMs?:number,
 *          fs?:{readFileSync:Function}, now?:() => number}} opts
 */
export async function probeClaudeUsage({ credentialFile, fetch: fetchFn = globalThis.fetch, timeoutMs = 15000, fs, now = Date.now } = {}) {
  const creds = readClaudeCredentials(credentialFile, { fs });
  if (!creds.ok) return { ok: false, tiers: {}, error: `credentials: ${creds.error}` };
  if (creds.expiresAt !== null && creds.expiresAt <= now()) {
    return {
      ok: false,
      tiers: {},
      error: `access token expired at ${new Date(creds.expiresAt).toISOString()} (awaiting Claude Code CLI refresh)`,
      status: 401,
      tokenExpired: true,
    };
  }
  const url = `${CLAUDE_API_BASE}${CLAUDE_USAGE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const status = resp.status;
    if (status === 401 || status === 403) {
      return { ok: false, tiers: {}, error: `auth failed (HTTP ${status})`, status };
    }
    let body;
    try {
      body = await resp.json();
    } catch {
      return { ok: false, tiers: {}, error: `non-JSON response (HTTP ${status})`, status };
    }
    if (!resp.ok) {
      return { ok: false, tiers: {}, error: `API error (HTTP ${status})`, status };
    }
    const parsed = parseClaudeUsageBody(body);
    return { ...parsed, status };
  } catch (e) {
    // e.cause.code（ENOTFOUND/ECONNRESET/ETIMEDOUT…）是排查关键：NAS 容器 DNS 偶发抖动
    // 只报 fetch failed 无法区分是解析、连接还是对端重置（2026-11-04 排查依据）
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { ok: false, tiers: {}, error: `network error: ${e?.message ?? e}${cause ? ` (${cause})` : ''}` };
  } finally {
    clearTimeout(timer);
  }
}
