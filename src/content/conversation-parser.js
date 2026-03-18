import { ROUND_STATUS } from "./constants.js";
import { extractRoundTitle } from "./title-extractor.js";

const PREVIEW_MAX_CHARS = 24;

function normalizeInlineText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstSentence(text) {
  const normalized = normalizeInlineText(text);
  if (!normalized) {
    return "";
  }

  const firstSentenceMatch = normalized.match(/^.+?[。！？!?]/);
  if (!firstSentenceMatch) {
    return normalized;
  }

  return firstSentenceMatch[0].trim();
}

function buildAssistantPreview(assistantMessages) {
  // assistantPreview（助手预览）优先取“首条有效回复”，更贴近该轮最初语义。
  const firstValidReply = assistantMessages
    .map((item) => normalizeInlineText(item.text))
    .find((text) => text.length > 0);

  if (!firstValidReply) {
    return "";
  }

  const firstSentence = extractFirstSentence(firstValidReply);
  if (firstSentence.length <= PREVIEW_MAX_CHARS) {
    return firstSentence;
  }

  // 首句过长时，回退为固定长度，避免列表拥挤。
  return firstValidReply.slice(0, PREVIEW_MAX_CHARS).trim();
}

function summarizeRoundStatus(round) {
  if (round.assistantMessages.length === 0) {
    return ROUND_STATUS.PENDING_REPLY;
  }

  const hasStreaming = round.assistantMessages.some((item) => item.state.isStreaming);
  if (hasStreaming) {
    return ROUND_STATUS.STREAMING;
  }

  const hasError = round.assistantMessages.some((item) => item.state.isError);
  if (hasError) {
    return ROUND_STATUS.ERROR;
  }

  const allEmpty = round.assistantMessages.every((item) => item.state.isEmpty);
  if (allEmpty) {
    return ROUND_STATUS.EMPTY;
  }

  return ROUND_STATUS.COMPLETE;
}

function normalizeMessageNodes(messageElements, adapter, logger) {
  const result = [];

  for (const [index, element] of messageElements.entries()) {
    try {
      const role = adapter.detectMessageRole(element);
      const text = adapter.extractMessageText(element);

      if (role === "unknown") {
        logger.warn("跳过无法识别角色的消息节点。", { index });
        continue;
      }

      result.push({
        role,
        text,
        element,
        originalIndex: index
      });
    } catch (error) {
      // 单节点异常不应中断整轮解析。
      logger.warn("解析单条消息失败，已跳过该节点。", error);
    }
  }

  return result;
}

export function buildConversationRounds(messageElements, options) {
  const { adapter, roundIdManager, logger } = options;
  const normalized = normalizeMessageNodes(messageElements, adapter, logger);
  const rounds = [];
  let currentRound = null;

  for (const [index, message] of normalized.entries()) {
    if (message.role === "user") {
      currentRound = {
        index: rounds.length + 1,
        userText: message.text,
        userAnchorEl: message.element,
        assistantMessages: []
      };
      rounds.push(currentRound);
      continue;
    }

    if (message.role === "assistant") {
      if (!currentRound) {
        logger.warn("检测到未配对的 assistant 消息，已跳过。", { index });
        continue;
      }

      const assistantState = adapter.getAssistantState(message.element, message.text, {
        isTailMessage: index === normalized.length - 1
      });

      currentRound.assistantMessages.push({
        text: message.text,
        element: message.element,
        state: assistantState
      });
    }
  }

  const finalized = rounds.map((round, idx) => {
    const index = idx + 1;
    const status = summarizeRoundStatus(round);
    const title = extractRoundTitle(round.userText, index);
    const assistantPreview = buildAssistantPreview(round.assistantMessages);
    const id = roundIdManager.assign(round, index);
    const assistantMessageEls = round.assistantMessages.map((item) => item.element);
    const assistantText = round.assistantMessages.map((item) => item.text).join(" ");

    return {
      id,
      index,
      title,
      status,
      userText: round.userText,
      userAnchorEl: round.userAnchorEl,
      assistantMessageEls,
      assistantPreview,
      searchText: `${title} ${round.userText} ${assistantText}`.trim(),
      assistantMessages: round.assistantMessages
    };
  });

  logger.info("轮次解析完成。", {
    messageCount: normalized.length,
    roundCount: finalized.length
  });

  return finalized;
}
