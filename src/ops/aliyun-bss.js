// aliyun-bss.js — 阿里云费用中心（BSS OpenAPI）账户余额探测。
// 用途：dashscope（阿里云百炼）向量展示位的「API 按量付费」余额卡片 —— 百炼
// 按量计费从阿里云账户余额扣款，DashScope sk- key 无余额查询端点（2026-10 实测
// 5 个候选端点全 404），唯一数据源是 BSS QueryAccountBalance。
// 端点：business.aliyuncs.com —— 原 bssopenapi.aliyuncs.com 已退役（NXDOMAIN，
// 2026-10-26 实测，DoH 223.5.5.5 双容器复核）。RPC v1 签名（HMAC-SHA1），
// 零依赖实现（node:crypto）。凭据：只读 RAM 子账号 AK（系统策略
// AliyunBSSReadOnlyAccess 覆盖 QueryAccountBalance 的授权点 bss:DescribeAcccount）。

import { createHmac, randomUUID } from 'node:crypto';

export const BSS_API_BASE = 'https://business.aliyuncs.com';

// RPC 签名 percentEncode：RFC3986 unreserved 之外的字符按 encodeURIComponent
// 输出，再修正三处差异（+ → %20、* → %2A、%7E → ~）。
const pctEncode = (s) => encodeURIComponent(String(s))
  .replace(/\+/g, '%20')
  .replace(/\*/g, '%2A')
  .replace(/%7E/g, '~');

/** 构造已签名 URL。导出仅为单测可注入 timestamp/nonce 断言签名结构。 */
export function signedBalanceUrl({ accessKeyId, accessKeySecret, baseUrl = BSS_API_BASE, timestamp, nonce }) {
  const params = {
    Action: 'QueryAccountBalance',
    Version: '2017-12-14',
    Format: 'JSON',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
    Timestamp: timestamp,
  };
  const canonical = Object.keys(params).sort().map((k) => `${k}=${pctEncode(params[k])}`).join('&');
  const stringToSign = `GET&%2F&${pctEncode(canonical)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  return `${baseUrl}/?${canonical}&Signature=${pctEncode(signature)}`;
}

/**
 * 探测账户余额（QueryAccountBalance）。
 * @returns {Promise<{ok: true, balance: {currency, total, cash, credit}} |
 *   {ok: false, error: string}>}
 *   total=AvailableAmount 可用余额（口径=百炼控制台「API 按量付费」可用额度）；
 *   cash=AvailableCashAmount 现金余额；credit=CreditAmount 信用额度。
 *   响应值均为字符串金额（如 "19.73"），由展示层格式化。
 */
export async function probeAliyunBalance({
  accessKeyId,
  accessKeySecret,
  baseUrl = BSS_API_BASE,
  fetch: fetchFn = globalThis.fetch,
  timeoutMs = 10000,
  now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  nonce = () => randomUUID(),
} = {}) {
  if (!accessKeyId || !accessKeySecret) {
    return { ok: false, error: 'missing aliyun access key (balanceAccessKeyIdRef/balanceAccessKeySecretRef unresolved)' };
  }
  const url = signedBalanceUrl({ accessKeyId, accessKeySecret, baseUrl, timestamp: now(), nonce: nonce() });
  let res;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, error: `bss balance network error: ${e?.message ?? e}` };
  }
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON（网关页等）走下面的分支 */ }
  if (!res.ok) {
    const code = j?.Code ?? null;
    // 常见码：InvalidAccessKeyId.NotFound（AK 删错）、SignatureDoesNotMatch（secret 错）、
    // Forbidden.RAM（授权未生效/策略没挂）
    return { ok: false, error: `bss balance http ${res.status}${code ? ` ${code}` : ''}${j?.Message ? `: ${j.Message}` : ''}` };
  }
  if (j?.Success !== true || !j?.Data || j.Data.AvailableAmount == null) {
    return { ok: false, error: `bss balance unexpected response: ${JSON.stringify(j)?.slice(0, 120)}` };
  }
  const d = j.Data;
  return {
    ok: true,
    balance: {
      currency: d.Currency || 'CNY',
      total: d.AvailableAmount,
      cash: d.AvailableCashAmount ?? null,
      credit: d.CreditAmount ?? null,
    },
  };
}
