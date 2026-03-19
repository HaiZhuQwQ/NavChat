/**
 * 本文件负责消息流水线（message pipeline，消息处理流水线）。
 * 作用：通过 adapter（适配器）提取并标准化消息，输出统一模型数组。
 */
import { MESSAGE_ROLE, normalizeUnifiedMessage } from "./models.js";

/**
 * 创建消息流水线状态（Pipeline State，流水线状态）。
 * 说明：用于跨多次刷新复用已解析消息，减少对旧消息的重复解析。
 */
export function createMessagePipelineState() {
  return {
    previousElements: [],
    normalizedCache: new WeakMap()
  };
}

function cloneWithIndexIfNeeded(message, index) {
  if (!message || message.index === index) {
    return message;
  }
  return {
    ...message,
    index
  };
}

function buildElementFingerprint(element) {
  if (!(element instanceof HTMLElement)) {
    return "invalid";
  }

  // 轻量指纹：优先低成本字段；再加文本快照，保证“文本变化但 DOM 引用不变”时不误复用。
  const messageId = String(element.getAttribute("data-message-id") || "");
  const testId = String(element.getAttribute("data-testid") || "");
  const role = String(element.getAttribute("data-message-author-role") || "");
  const rawText = String(element.textContent || "");
  const head = rawText.slice(0, 20);
  const tail = rawText.slice(-20);
  return `${element.childElementCount}|${messageId}|${testId}|${role}|${rawText.length}|${head}|${tail}`;
}

/**
 * 增量收集消息：尽量复用“未变化且非尾部”的历史消息，降低刷新开销。
 */
export function collectUnifiedMessagesIncremental(adapter, conversationRoot, options = {}) {
  const logger = options.logger || null;
  const state = options.state || createMessagePipelineState();

  if (!adapter || typeof adapter.getMessageElements !== "function") {
    logger?.warn("消息流水线终止：adapter 不可用。");
    return [];
  }

  const rawElements = adapter.getMessageElements(conversationRoot, {
    document: options.document || document
  });

  const elements = Array.isArray(rawElements) ? rawElements : [];
  const previousElements = Array.isArray(state.previousElements) ? state.previousElements : [];
  const messages = [];
  let reusedCount = 0;
  const totalCount = elements.length;

  for (const [index, element] of elements.entries()) {
    const isTailMessage = index === totalCount - 1;
    const isSameSlotAsPrevious = previousElements[index] === element;
    const cachedMessage = state.normalizedCache.get(element);
    const fingerprint = buildElementFingerprint(element);

    // 关键策略：非尾部消息且节点引用未变化时，优先复用缓存，避免重复解析旧消息。
    if (cachedMessage && isSameSlotAsPrevious && cachedMessage.fingerprint === fingerprint && !isTailMessage) {
      messages.push(cloneWithIndexIfNeeded(cachedMessage.normalized, index));
      reusedCount += 1;
      continue;
    }

    try {
      const parsed = adapter.parseMessage(element, {
        index,
        isTailMessage,
        root: conversationRoot,
        document: options.document || document
      });

      const normalized = normalizeUnifiedMessage(parsed, {
        idPrefix: adapter.platform || "msg",
        platform: adapter.platform || "unknown"
      });

      if (normalized.role === MESSAGE_ROLE.UNKNOWN) {
        logger?.warn("跳过角色未知消息。", { index });
        continue;
      }

      state.normalizedCache.set(element, {
        fingerprint,
        normalized
      });
      messages.push(normalized);
    } catch (error) {
      // 单条消息解析失败不应阻断整轮刷新。
      logger?.warn("解析单条消息失败，已跳过。", { index, error });
    }
  }

  state.previousElements = elements;

  logger?.debug("统一消息收集完成（增量模式）。", {
    elementCount: elements.length,
    messageCount: messages.length,
    reusedCount,
    platform: adapter.platform
  });

  return messages;
}

export function collectUnifiedMessages(adapter, conversationRoot, options = {}) {
  // 兼容旧调用：默认走“无状态增量”路径，行为与全量解析保持一致。
  return collectUnifiedMessagesIncremental(adapter, conversationRoot, options);
}
