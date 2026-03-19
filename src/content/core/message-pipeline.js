/**
 * 本文件负责消息流水线（message pipeline，消息处理流水线）。
 * 作用：通过 adapter（适配器）提取并标准化消息，输出统一模型数组。
 */
import { MESSAGE_ROLE, normalizeUnifiedMessage } from "./models.js";

export function collectUnifiedMessages(adapter, conversationRoot, options = {}) {
  const logger = options.logger || null;

  if (!adapter || typeof adapter.getMessageElements !== "function") {
    logger?.warn("消息流水线终止：adapter 不可用。");
    return [];
  }

  const rawElements = adapter.getMessageElements(conversationRoot, {
    document: options.document || document
  });

  const elements = Array.isArray(rawElements) ? rawElements : [];
  const messages = [];

  for (const [index, element] of elements.entries()) {
    try {
      const parsed = adapter.parseMessage(element, {
        index,
        isTailMessage: index === elements.length - 1,
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

      messages.push(normalized);
    } catch (error) {
      // 单条消息解析失败不应阻断整轮刷新。
      logger?.warn("解析单条消息失败，已跳过。", { index, error });
    }
  }

  logger?.debug("统一消息收集完成。", {
    elementCount: elements.length,
    messageCount: messages.length,
    platform: adapter.platform
  });

  return messages;
}
