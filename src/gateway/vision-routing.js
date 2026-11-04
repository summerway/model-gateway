// vision-routing.js — text-only 模型收到含图请求时的网关侧改写（v1：reroute 策略）。
// 设计口径（2026-10-03 定稿）：
//   - 按模型 opt-in：catalog providers[].visionRouting[modelId] = {strategy:'reroute', target}
//   - 分区：最后一条 assistant 消息（含）之前 = 历史区，之后 = 新区；无 assistant 全为新区
//   - 确定态：历史区图 → 占位文本；新区有图 → 占位历史 + reroute 到 target；
//     仅历史图 → 只占位、模型不动（placeholder）
//   - uncertain（最后 assistant 带非空 tool_calls，回合未完成）：任何位置有图 →
//     零占位、全像素 reroute（分区语义不可靠时保像素优先）
//   - reroute 后走 target 自身的 provider 链；链耗尽 502 带 attempts，绝不回落原模型
// v1.1（2026-10-10 用户发起，生产数据驱动：99% reroute 为工具循环重发已识别图）：
//   - visionRouting.uncertain = 'pixels'（默认，v1 行为不变）| 'consumed'
//   - consumed：uncertain 态下按图判定消费——图后有 assistant 应答 = 已识别 → 占位；
//     未消费图保像素并触发改写；全部已消费 → 只占位、模型不动。像素每轮只付一次。
// 纯函数 + copy-on-write：未变的 message / content / body 保持原引用，不修改入参。

export const HISTORY_IMAGE_PLACEHOLDER = '[历史图片，已在先前回复中分析]';

/** content part 是否为图像（OpenAI image_url / Responses input_image 两种形态）。
 *  data URL 与远程 http(s) URL 同等对待：只看结构，不取回像素
 *  （远程图由目标渠道自行拉取或失败切链）。 */
function isImagePart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'image_url' && typeof part.image_url?.url === 'string') return true;
  if (part.type === 'input_image' && typeof part.image_url === 'string') return true;
  return false;
}

/** 目录中查找 modelId 的 visionRouting 声明；跨 provider 不一致时取第一个
 *  （配置层 validateConfig 已校验声明一致，这里做运行时容错）。未配置 → null。 */
export function findVisionRouting(catalog, modelId) {
  for (const p of catalog?.providers ?? []) {
    const rule = p?.visionRouting?.[modelId];
    if (rule && rule.strategy === 'reroute' && typeof rule.target === 'string' && rule.target) return rule;
  }
  return null;
}

/**
 * 对 OpenAI chat/completions 形态的请求体应用视觉路由。
 * 返回 { body, routing }：
 *   routing === null — 无介入（模型未配置 / 全程无图），body 原引用返回
 *   routing = { action: 'reroute'|'placeholder', from, to, newImages,
 *               placeholderCount, uncertain }
 * 不碰 stream、tools 及其他任何字段；占位只发生在确定态的历史区。
 */
export function applyVisionRouting(openaiBody, catalog) {
  const rule = findVisionRouting(catalog, openaiBody?.model);
  if (!rule) return { body: openaiBody, routing: null };
  const messages = openaiBody?.messages;
  if (!Array.isArray(messages)) return { body: openaiBody, routing: null };

  // 分区：最后一条 assistant（含）之前 = 历史区；之后 = 新区。
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') { lastAssistant = i; break; }
  }
  // 回合状态：最后 assistant 带非空 tool_calls → 工具回合未完成，分区语义不可靠。
  const uncertain = lastAssistant >= 0 && Array.isArray(messages[lastAssistant]?.tool_calls) &&
    messages[lastAssistant].tool_calls.length > 0;
  // v1.1 consumed：uncertain 态下「图后有 assistant 应答 = 已识别」→ 占位，只保未消费像素。
  const consumedMode = uncertain && rule.uncertain === 'consumed';

  // 位置 i 之后是否存在 assistant 消息（consumed 模式的消费判定，倒序扫一遍）。
  const assistantAfter = new Array(messages.length);
  for (let i = messages.length - 1, saw = false; i >= 0; i--) {
    assistantAfter[i] = saw;
    if (messages[i]?.role === 'assistant') saw = true;
  }

  // 占位区：确定态 = 历史区；consumed = 已消费区。
  const inPlaceholderZone = consumedMode
    ? (i) => assistantAfter[i]
    : (i) => i <= lastAssistant;

  let placeholderCount = 0;
  let freshCount = 0; // 保像素图数：确定态 = 新区图；consumed = 未消费图
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    let n = 0;
    for (const part of content) if (isImagePart(part)) n++;
    if (n === 0) continue;
    if (inPlaceholderZone(i)) placeholderCount += n;
    else freshCount += n;
  }
  if (placeholderCount === 0 && freshCount === 0) return { body: openaiBody, routing: null };

  const from = openaiBody.model;
  const to = rule.target;

  // v1 uncertain：任何位置有图 → 零占位、全像素 reroute（像素保留优先于上下文瘦身）。
  if (uncertain && !consumedMode) {
    return {
      body: { ...openaiBody, model: to },
      routing: { action: 'reroute', from, to, newImages: freshCount, placeholderCount: 0, uncertain: true },
    };
  }

  // 占位区图替换为占位文本（copy-on-write：未变的 message/content 不复制，
  // 占位保持数组位置，其他 parts 与 string content 不动）。
  let newMessages = messages;
  if (placeholderCount > 0) {
    newMessages = messages.map((m, i) => {
      if (!inPlaceholderZone(i) || m === null || typeof m !== 'object') return m;
      const content = m.content;
      if (!Array.isArray(content)) return m;
      let changed = false;
      const mapped = content.map((part) => {
        if (isImagePart(part)) {
          changed = true;
          return { type: 'text', text: HISTORY_IMAGE_PLACEHOLDER };
        }
        return part;
      });
      return changed ? { ...m, content: mapped } : m;
    });
  }

  if (freshCount > 0) {
    return {
      body: placeholderCount > 0
        ? { ...openaiBody, messages: newMessages, model: to }
        : { ...openaiBody, model: to },
      routing: { action: 'reroute', from, to, newImages: freshCount, placeholderCount, uncertain },
    };
  }

  // 仅占位区有图：占位改写、模型不动（不介入 target 链）。
  return {
    body: { ...openaiBody, messages: newMessages },
    routing: { action: 'placeholder', from, to: from, newImages: 0, placeholderCount, uncertain },
  };
}
