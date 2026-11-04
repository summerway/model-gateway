// extract.js — usage 归一化提取：多种上游 usage 形态 → {input, output, cacheRead, cacheWrite}
// 以及 SSE 旁路扫描 tap（透传流上旁挂扫描，不缓冲、不改变字节）。
//
// 归一化口径（与 cc-switch v3.15 对齐，页面四项 = 新增输入/输出/缓存创建/缓存命中）：
//   - OpenAI 语义（prompt_tokens 含 cached）：新增输入 = prompt_tokens − cacheRead − cacheWrite
//   - DeepSeek：prompt_tokens = hit + miss → 命中减掉即新增
//   - Anthropic 语义（input_tokens 不含缓存项）：新增输入 = input_tokens 原值
// 真实消耗 Tokens（页面大数）= input + output + cacheRead + cacheWrite（聚合层计算）。

import { Transform } from 'node:stream';

const N = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * 归一化一个 usage 对象（openai/deepseek/zhipu/anthropic/responses 形态皆可）。
 * 返回 {input, output, cacheRead, cacheWrite} 或 null（无有效 token 数据）。
 */
export function extractUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? null;
  const completion = u.completion_tokens ?? u.output_tokens ?? null;
  const cacheRead = u.prompt_cache_hit_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? u.input_tokens_details?.cached_tokens
    ?? u.cache_read_input_tokens
    ?? 0;
  const cacheWrite = u.prompt_cache_write_tokens
    ?? u.prompt_tokens_details?.cache_write
    ?? u.input_tokens_details?.cache_creation
    ?? u.cache_creation_input_tokens
    ?? 0;
  if (prompt === null && completion === null && !N(cacheRead) && !N(cacheWrite)) return null;
  const p = N(prompt);
  // 语义判定：prompt_tokens（openai/deepseek）或 input_tokens_details（responses）
  // 都是「cached ⊆ 总量」的 openai 语义，需扣除；纯 input_tokens（anthropic）不含缓存项。
  const openaiStyle = u.prompt_tokens !== undefined || u.input_tokens_details !== undefined;
  const input = openaiStyle ? Math.max(0, p - N(cacheRead) - N(cacheWrite)) : p;
  return { input, output: N(completion), cacheRead: N(cacheRead), cacheWrite: N(cacheWrite) };
}

/** 合并两次提取结果（流式多段 usage 时后者覆盖非零项；SseUsageTap 用于 Anthropic 分段 usage）。 */
export function mergeUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    input: b.input || a.input,
    output: b.output || a.output,
    cacheRead: b.cacheRead || a.cacheRead,
    cacheWrite: b.cacheWrite || a.cacheWrite,
  };
}

/**
 * SSE 旁路扫描：Transform 管道中继，扫描每个 `data:` 行的 usage 字段。
 * - chat completions 流：末 chunk `usage`（openai/zhipu/deepseek 兼容）
 * - responses 透传流：`response.completed` 的 `response.usage`
 * - anthropic 流：message_start/message_delta 分段 usage
 * 同时探测流的终止标记（[DONE] / response.completed / message_stop）置 completed：
 * 客户端（codex CLI）收到终止标记即关连接是正常行为，账目层据此记成功。
 * 不缓冲：transform 直接透传原 chunk，仅旁路解析（行缓冲只用于切 JSON 边界）。
 * 也可对字符串 chunk 直接 feed()（codex chat 转换流场景）。
 */
export class SseUsageTap extends Transform {
  constructor() {
    super();
    this.usage = null;
    this.reported = false;
    this.completed = false;
    this._buf = '';
  }

  /** 喂入一段 SSE 文本（可跨 chunk 拆行）；返回自身便于链式。 */
  feed(text) {
    this._buf += text;
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      this._scanLine(this._buf.slice(0, idx));
      this._buf = this._buf.slice(idx + 1);
    }
    return this;
  }

  _transform(chunk, enc, cb) {
    // chunk 透传原样字节，仅旁路解析文本
    this.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    cb(null, chunk);
  }

  _scanLine(line) {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      this.completed = true; // chat completions 终止标记
      return;
    }
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return; // 半行/非 JSON（多行 data 场景罕见，忽略）
    }
    // 流终止标记：responses 透传 / anthropic 原生。codex CLI 收到即关连接。
    if (obj?.type === 'response.completed' || obj?.type === 'message_stop') this.completed = true;
    // Anthropic 原生流：输入/缓存在 message_start.message.usage，输出在 message_delta.usage
    // （后者常只带 output_tokens）→ 合并而非覆盖，非零项以后到为准。
    const cand = obj.usage ?? obj.response?.usage ?? obj.message?.usage;
    if (!cand) return;
    const ex = extractUsage(cand);
    if (ex) {
      this.usage = mergeUsage(this.usage, ex);
      this.reported = true;
    }
  }
}
