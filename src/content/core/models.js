/**
 * 本文件定义统一数据模型（Unified Model，统一模型）相关工具。
 * 作用：把不同平台消息格式统一为 core（核心层）可消费的数据结构。
 */

export const MESSAGE_ROLE = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  UNKNOWN: "unknown"
};

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toTimestampOrNull(value) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function resolveMessageId(message, fallbackPrefix) {
  if (message?.id) {
    return String(message.id);
  }

  const platform = message?.platform || "unknown";
  const index = Number.isFinite(message?.index) ? message.index : 0;
  return `${fallbackPrefix || "msg"}-${platform}-${index}`;
}

/**
 * 归一化 UnifiedMessage（统一消息模型），保证核心字段稳定。
 */
export function normalizeUnifiedMessage(rawMessage, options = {}) {
  const message = rawMessage || {};
  const role = Object.values(MESSAGE_ROLE).includes(message.role)
    ? message.role
    : MESSAGE_ROLE.UNKNOWN;
  const text = normalizeText(message.text);
  const isEmpty = text.length === 0;

  return {
    id: resolveMessageId(message, options.idPrefix),
    role,
    text,
    html: String(message.html || ""),
    element: message.element || null,
    index: Number.isFinite(message.index) ? message.index : -1,
    platform: String(message.platform || options.platform || "unknown"),
    state: {
      isStreaming: Boolean(message.state?.isStreaming),
      isError: Boolean(message.state?.isError),
      isEmpty: message.state?.isEmpty == null ? isEmpty : Boolean(message.state.isEmpty)
    },
    meta: {
      timestamp: toTimestampOrNull(message.meta?.timestamp),
      attachments: toSafeArray(message.meta?.attachments),
      sourceType: String(message.meta?.sourceType || "dom")
    }
  };
}
