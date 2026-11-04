/**
 * 格式转换 — /v1/chat/completions 客户端形态 ↔ OpenAI responses API。
 *
 * 两个方向：
 *  chatToResponses(body)          chat/completions 请求 → responses 请求
 *  responsesToChat(resp, model)   responses 非流式响应 → chat/completions 响应
 *  wrapSseDecoder(...)            responses SSE 事件流 → chat/completions chunk 流（SSE 透传给客户端）
 *
 * responses 响应事件形态（response.output_item.done / response.completed 等）参考
 * codex CLI 与 pi openai-codex-responses 实现；fixture 驱动（见 test/fixtures/）。
 */

/** chat/completions 消息数组 → responses input 数组。 */
export function chatMessagesToInput(messages) {
  return messages.flatMap((msg) => messageToInputItems(msg));
}

/**
 * 单条 chat 消息 → responses input items（0..n 条）。
 *
 * role 映射（chat/completions 无 stateful 会话，历史须逐条转 input items）：
 *  - role:'tool'（工具结果）→ { type:'function_call_output', call_id, output }
 *    responses 无 role:'tool' 消息形态，直传会被上游 400（Invalid value: 'tool'）。
 *  - assistant.tool_calls[] → 每个调用一条 { type:'function_call', call_id, name, arguments }；
 *    伴随文本另立 assistant 消息（content part 用 output_text）。
 *  - assistant 纯文本 → { role:'assistant', content:[output_text] }（历史回合用 output_text，非 input_text）。
 *  - user → { role:'user', content:[input_text | input_image] }。
 */
function messageToInputItems(msg) {
  if (msg.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: msg.tool_call_id ?? msg.call_id ?? '',
      output: contentToText(msg.content),
    }];
  }
  if (msg.role === 'assistant') {
    const items = [];
    const text = contentToText(msg.content);
    if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        items.push({
          type: 'function_call',
          call_id: tc.id ?? '',
          name: tc.function?.name ?? '',
          arguments: typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
        });
      }
    }
    return items;
  }
  // user（及未知角色）→ 消息形态
  const content = typeof msg.content === 'string' ? [{ type: 'input_text', text: msg.content }] : normalizeMultiPart(msg.content);
  return [{ role: msg.role, content }];
}

/** chat content（string | parts | null）→ 纯文本（tool output / assistant 文本用）。 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part.type === 'text') return part.text ?? '';
    return JSON.stringify(part);
  }).join('');
}

/** chat 多模态 content parts → responses content parts。 */
function normalizeMultiPart(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image_url') {
      const url = part.image_url?.url ?? '';
      // data: URL → image_url 直接透传；http(s) 也以 image_url 形态发送（backend 拉取）
      return { type: 'input_image', image_url: url };
    }
    return { type: 'input_text', text: JSON.stringify(part) };
  });
}

/**
 * chat/completions 请求体 → responses 请求体。
 * 保留 instructions（system 消息聚合）与推理力度映射（off→none ... xhigh→xhigh）。
 */
export function chatToResponses(body, { thinkingLevelMap } = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemMessages = messages.filter((m) => m.role === 'system' || m.role === 'developer');
  const rest = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
  const out = {
    model: body.model,
    input: chatMessagesToInput(rest),
    stream: Boolean(body.stream),
    store: false, // ChatGPT codex backend 强制无状态（"Store must be set to false"）
  };
  if (systemMessages.length > 0) {
    out.instructions = systemMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n\n');
  }
  // 注：codex backend 不支持 max_output_tokens（400 Unsupported parameter），
  // max_tokens 仅在客户端侧截断由上游默认行为决定 —— 不向上游透传。
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.tools !== undefined) out.tools = convertTools(body.tools);
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  const reasoning = convertReasoning(body.reasoning_effort, thinkingLevelMap);
  if (reasoning) out.reasoning = reasoning;
  return out;
}

const DEFAULT_THINKING_MAP = {
  off: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
};

function convertReasoning(effort, map) {
  if (!effort) return null;
  const m = map ?? DEFAULT_THINKING_MAP;
  const effortOut = m[effort] ?? effort;
  return { effort: effortOut };
}

/** chat tools (function 定义) → responses tools。 */
function convertTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (tool.type === 'function') {
      return {
        type: 'function',
        name: tool.function?.name,
        description: tool.function?.description ?? '',
        parameters: tool.function?.parameters ?? { type: 'object', properties: {} },
      };
    }
    return tool; // responses 原生 tool 形态直通
  });
}

/**
 * responses 非流式响应 → chat/completions 响应。
 * 输出聚合规则：
 *  - output[] 里 message item 的 output_text part → content 文本
 *  - function_call item → tool_calls[{function:{name,arguments}}]
 *  - usage → usage（input_tokens→prompt_tokens 等）
 *  - status/incomplete → finish_reason 映射（incomplete(max_tokens)→length）
 */
export function responsesToChat(resp, { model } = {}) {
  const message = { role: 'assistant', content: null, tool_calls: [] };
  const textParts = [];
  const output = Array.isArray(resp.output) ? resp.output : [];
  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') textParts.push(part.text);
        else if (part.type === 'refusal' && part.refusal) textParts.push(part.refusal);
      }
    } else if (item.type === 'function_call') {
      message.tool_calls.push({
        id: item.call_id ?? item.id ?? `call_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      });
    }
  }
  if (textParts.length > 0) message.content = textParts.join('');
  if (message.tool_calls.length === 0) delete message.tool_calls;

  let finishReason = mapFinishReason(resp.status, resp.incomplete_details?.reason);
  const usage = convertUsage(resp.usage);

  return {
    id: resp.id ?? `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion',
    created: resp.created_at ?? Math.floor(Date.now() / 1000),
    model: model ?? resp.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

function mapFinishReason(status, incompleteReason) {
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') return 'length';
    return 'stop';
  }
  if (status === 'failed') return 'stop';
  return 'stop';
}

function convertUsage(usage) {
  if (!usage) return undefined;
  // input_tokens_details.cached_tokens 透传（chat 形态的 prompt_tokens_details）：
  // 使用统计的缓存命中依赖此字段，丢弃会导致 codex 链路命中恒为 0。
  const cached = usage.input_tokens_details?.cached_tokens;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    ...(typeof cached === 'number' ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/* ------------------------- SSE: responses → chat chunks ------------------------- */

/**
 * 流式转换器：喂入 responses SSE 文本块，产出 chat/completions SSE 块（字符串，含 data: 前缀）。
 *
 * 事件映射：
 *  response.output_text.delta      → chunk delta content
 *  response.output_item.done(function_call) → chunk delta tool_calls
 *  response.completed              → 最终 chunk（finish_reason + usage）
 *  response.failed / error         → 结束 chunk（finish_reason stop）
 */
export function createSseConverter({ model, id } = {}) {
  const chatId = id ?? `chatcmpl-${Math.random().toString(36).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let toolCallIndex = 0;
  const converter = {
    id: chatId,
    /** 喂入一段 SSE 文本；返回待发送的 chat chunk 字符串数组。 */
    feed(chunkText) {
      const out = [];
      buffer += chunkText;
      // SSE 事件以空行分隔
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseEvent(rawEvent);
        if (!parsed) continue;
        const chunks = handleEvent(parsed, converter._state);
        out.push(...chunks);
      }
      return out;
    },
    /** 流结束（data: [DONE] 或连接关闭）；返回剩余 chunk。 */
    flush() {
      return [];
    },
    _state: {
      chatId,
      created,
      model,
      toolCallIndex,
      baseChunk() {
        return { id: chatId, object: 'chat.completion.chunk', created, model };
      },
    },
  };
  return converter;
}

function parseSseEvent(raw) {
  const lines = raw.split('\n');
  let event = null;
  let dataStr = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  if (dataStr === '[DONE]') return { event: 'done', data: '[DONE]' };
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

function handleEvent(parsed, state) {
  const chunks = [];
  const type = parsed.event ?? parsed.data?.type;
  const makeChunk = (delta, finishReason = null) => {
    const chunk = state.baseChunk();
    chunk.choices = [{ index: 0, delta, finish_reason: finishReason }];
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };
  if (type === 'response.output_text.delta') {
    const delta = parsed.data.delta;
    if (typeof delta === 'string' && delta.length > 0) chunks.push(makeChunk({ content: delta }));
  } else if (type === 'response.output_item.done' && parsed.data?.item?.type === 'function_call') {
    const item = parsed.data.item;
    const idx = state.toolCallIndex++;
    chunks.push(makeChunk({
      tool_calls: [{
        index: idx,
        id: item.call_id ?? item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      }],
    }));
  } else if (type === 'response.completed') {
    const response = parsed.data.response ?? {};
    const usage = convertUsage(response.usage);
    const hasToolCalls = state.toolCallIndex > 0;
    const chunk = state.baseChunk();
    chunk.choices = [{
      index: 0,
      delta: {},
      finish_reason: hasToolCalls ? 'tool_calls' : mapFinishReason(response.status, response.incomplete_details?.reason),
    }];
    if (usage) chunk.usage = usage;
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
    chunks.push('data: [DONE]\n\n');
  } else if (type === 'response.failed' || type === 'error' || type === 'response.incomplete') {
    const chunk = state.baseChunk();
    chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
    if (type === 'response.incomplete') {
      const reason = parsed.data?.response?.incomplete_details?.reason;
      if (reason === 'max_output_tokens') chunk.choices[0].finish_reason = 'length';
    }
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
    chunks.push('data: [DONE]\n\n');
  }
  return chunks;
}

/** responses SSE 事件（fixture/测试用便捷解析）。 */
export function parseSseStream(text) {
  const events = [];
  let rest = text;
  let idx;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const parsed = parseSseEvent(raw);
    if (parsed) events.push(parsed);
  }
  return events;
}

/**
 * 非流式聚合：把 codex SSE 流完整聚合成一个 chat.completion 响应对象。
 * ChatGPT codex backend 强制 stream:true，非流式 chat 请求由本地聚合实现。
 */
export async function aggregateSseToChat(upstream, model) {
  const textParts = [];
  const toolCalls = [];
  let finishReason = 'stop';
  let usage;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseEvent(rawEvent);
      if (!parsed) continue;
      const type = parsed.event ?? parsed.data?.type;
      if (type === 'response.output_text.delta') {
        if (typeof parsed.data.delta === 'string') textParts.push(parsed.data.delta);
      } else if (type === 'response.output_item.done' && parsed.data?.item?.type === 'function_call') {
        const item = parsed.data.item;
        toolCalls.push({
          id: item.call_id ?? item.id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments ?? '{}' },
        });
      } else if (type === 'response.completed') {
        const resp = parsed.data.response ?? {};
        usage = convertUsage(resp.usage);
        finishReason = mapFinishReason(resp.status, resp.incomplete_details?.reason);
        if (toolCalls.length > 0) finishReason = 'tool_calls';
      } else if (type === 'response.failed' || type === 'error') {
        finishReason = 'stop';
      }
    }
  }
  const message = { role: 'assistant', content: textParts.length > 0 ? textParts.join('') : null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * 非流式聚合（responses 形态）：codex SSE → 单个 response 对象。
 * 终态取 response.completed / response.incomplete / response.failed 携带的 response；
 * 其 output 为空时用逐条 response.output_item.done 回填（backend 的终态事件不保证带 output）。
 * 流里只有 error 事件时合成 status:'failed' 的 response，error 字段原样保留。
 */
export async function aggregateSseToResponse(upstream) {
  const items = [];
  let final = null;
  let error = null;
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (rawEvent) => {
    const parsed = parseSseEvent(rawEvent);
    if (!parsed || parsed.data === '[DONE]') return;
    const type = parsed.event ?? parsed.data?.type;
    if (type === 'response.output_item.done' && parsed.data?.item) {
      items.push(parsed.data.item);
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      final = parsed.data.response ?? {};
    } else if (type === 'error') {
      error = parsed.data.error ?? parsed.data;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      consume(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) consume(buffer);
  const resp = final ?? { object: 'response', status: 'failed', ...(error ? { error } : {}) };
  if (!Array.isArray(resp.output) || resp.output.length === 0) resp.output = items;
  return resp;
}
