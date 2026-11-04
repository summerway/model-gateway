// embeddings.js — POST /v1/embeddings：OpenAI 形请求 ↔ 阿里百炼 DashScope 文本向量。
// 上游优先走 DashScope 原生接口（支持 text_type=query/document，官方建议检索任务区分），
// 原生网络错误/5xx 时降级到兼容模式 /compatible-mode/v1/embeddings（不支持 text_type）。
// 百炼单次最多 10 条：超出则按批顺序请求（不并发，保持上游温和）。纯函数 + 注入 fetch，便于单测。

import { UpstreamError } from './fallback/engine.js';

export const DASHSCOPE_BATCH = 10;
const TEXT_TYPES = new Set(['query', 'document']);

/** 归一化 OpenAI 形请求体；非法返回 { error }。 */
export function parseEmbeddingsRequest(body, { models, defaultDimensions }) {
  if (!body || typeof body !== 'object') return { error: 'invalid JSON body' };
  const model = body.model ?? models[0];
  if (!models.includes(model)) return { error: `model "${model}" not served by /v1/embeddings (available: ${models.join(', ')})` };
  const input = typeof body.input === 'string' ? [body.input] : body.input;
  if (!Array.isArray(input) || input.length === 0 || !input.every((s) => typeof s === 'string' && s.length > 0)) {
    return { error: '"input" must be a non-empty string or array of non-empty strings (token arrays unsupported)' };
  }
  const dimensions = body.dimensions ?? defaultDimensions;
  if (dimensions !== undefined && dimensions !== null && !(Number.isInteger(dimensions) && dimensions > 0)) {
    return { error: '"dimensions" must be a positive integer' };
  }
  const encodingFormat = body.encoding_format ?? 'float';
  if (encodingFormat !== 'float' && encodingFormat !== 'base64') {
    return { error: '"encoding_format" must be "float" or "base64"' };
  }
  // text_type 是网关扩展字段（OpenAI 无此字段）；缺省 document（百炼默认）
  const textType = body.text_type ?? 'document';
  if (!TEXT_TYPES.has(textType)) return { error: '"text_type" must be "query" or "document"' };
  return { model, input, dimensions: dimensions ?? null, encodingFormat, textType };
}

/** float 数组 → base64(Float32 LE)，与 OpenAI encoding_format=base64 一致。 */
export function floatsToBase64(vec) {
  const buf = Buffer.alloc(vec.length * 4);
  vec.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString('base64');
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function postJson(fetchFn, url, apiKey, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: r.status, json, text };
  } catch (e) {
    const aborted = e?.name === 'AbortError' || e?.cause?.name === 'AbortError';
    return { status: 0, error: aborted ? `timeout after ${timeoutMs}ms` : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

function upstreamMessage(r) {
  return r.error ?? r.json?.message ?? r.json?.error?.message ?? r.text?.slice(0, 300) ?? `HTTP ${r.status}`;
}

/** 单批：原生优先，网络错误/5xx 降级兼容模式。返回 { vectors: number[][], tokens, via }。 */
async function embedBatch({ fetchFn, cfg, apiKey, workspaceId, req, texts, timeoutMs }) {
  const host = `https://${workspaceId}.${cfg.region}.maas.aliyuncs.com`;
  const native = await postJson(fetchFn, `${host}/api/v1/services/embeddings/text-embedding/text-embedding`, apiKey, {
    model: req.model,
    input: { texts },
    parameters: { text_type: req.textType, ...(req.dimensions ? { dimension: req.dimensions } : {}) },
  }, timeoutMs);
  if (native.status === 200 && Array.isArray(native.json?.output?.embeddings)) {
    const vectors = [];
    for (const e of native.json.output.embeddings) vectors[e.text_index] = e.embedding;
    return { vectors, tokens: native.json.usage?.total_tokens ?? 0, via: 'native' };
  }
  // 4xx（鉴权/参数/限流）是确定性失败：降级也会同样失败，直接上抛
  if (native.status >= 400 && native.status < 500) {
    throw new UpstreamError(`dashscope embeddings ${native.status}: ${upstreamMessage(native)}`, {
      status: native.status === 429 ? 429 : 502, kind: native.status === 429 ? 'rate_limit' : 'client_error', providerId: 'dashscope',
    });
  }
  const compat = await postJson(fetchFn, `${host}/compatible-mode/v1/embeddings`, apiKey, {
    model: req.model,
    input: texts,
    encoding_format: 'float',
    ...(req.dimensions ? { dimensions: req.dimensions } : {}),
  }, timeoutMs);
  if (compat.status === 200 && Array.isArray(compat.json?.data)) {
    const vectors = [];
    for (const d of compat.json.data) vectors[d.index] = d.embedding;
    return { vectors, tokens: compat.json.usage?.total_tokens ?? 0, via: 'compatible' };
  }
  throw new UpstreamError(
    `dashscope embeddings failed (native: ${upstreamMessage(native)}; compatible: ${upstreamMessage(compat)})`,
    { status: 502, providerId: 'dashscope' },
  );
}

/** 全量请求：按 10 条分批顺序调用，组装 OpenAI 形响应。 */
export async function embed({ fetchFn, cfg, apiKey, workspaceId, req, timeoutMs = 60000 }) {
  const data = [];
  let tokens = 0;
  const via = new Set();
  let offset = 0;
  for (const texts of chunk(req.input, DASHSCOPE_BATCH)) {
    const r = await embedBatch({ fetchFn, cfg, apiKey, workspaceId, req, texts, timeoutMs });
    if (r.vectors.length !== texts.length || r.vectors.some((v) => !Array.isArray(v))) {
      throw new UpstreamError('dashscope embeddings returned an incomplete batch', { status: 502, providerId: 'dashscope' });
    }
    r.vectors.forEach((v, i) => data.push({
      object: 'embedding',
      index: offset + i,
      embedding: req.encodingFormat === 'base64' ? floatsToBase64(v) : v,
    }));
    tokens += r.tokens;
    via.add(r.via);
    offset += texts.length;
  }
  return {
    response: { object: 'list', data, model: req.model, usage: { prompt_tokens: tokens, total_tokens: tokens } },
    via: [...via].join('+'),
  };
}
