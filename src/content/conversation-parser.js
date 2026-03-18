import { PREVIEW_MAX_LENGTH, ROUND_STATUS } from "./constants.js";
import { extractRoundTitle } from "./title-extractor.js";

const LOW_INFO_PREFIXES = [
  "可以",
  "好的",
  "当然可以",
  "下面我来",
  "下面我们来",
  "我来",
  "没问题",
  "当然",
  "可以的",
  "好",
  "接下来",
  "下面给你",
  "让我来",
  "我们可以",
  "下面是",
  "以下是"
];

function normalizeInlineText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTitleFallbackFromUserText(userText) {
  return normalizeInlineText(userText)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)]|[一二三四五六七八九十百千]+[、.])\s+/gm, "")
    .replace(/^[，。！？,.!?：:；;\-\s]+/, "")
    .trim();
}

function truncateByLength(text, maxLength) {
  const chars = Array.from(String(text || ""));
  if (chars.length <= maxLength) {
    return chars.join("").trim();
  }
  return chars.slice(0, maxLength).join("").trim();
}

function splitSentences(text) {
  const normalized = normalizeInlineText(text);
  if (!normalized) {
    return [];
  }
  return normalized.match(/[^。！？!?]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) || [];
}

function cleanForPreview(text) {
  // 先做“结构清洗”：去掉 Markdown（标记语法）符号噪音，但尽量保留自然语言正文。
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "\n")
    .replace(/```/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)]|[一二三四五六七八九十百千]+[、.])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[`*_~]+/g, " ")
    .trim();
}

function splitParagraphs(text) {
  return String(text || "")
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeParagraph(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPureLinkText(text) {
  const normalized = normalizeInlineText(text);
  if (!normalized) {
    return false;
  }
  const plainLinksOnly = /^(?:https?:\/\/\S+\s*)+$/i.test(normalized);
  if (plainLinksOnly) {
    return true;
  }
  return /^(?:\[[^\]]+\]\((https?:\/\/[^)]+)\)\s*)+$/i.test(normalized);
}

function isPureTableParagraph(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return false;
  }

  const tableLikeCount = lines.filter((line) => /^\|?.+\|.+\|?$/.test(line)).length;
  const separatorCount = lines.filter((line) => /^\|?[\s:-]+\|[\s|:-]*$/.test(line)).length;
  return tableLikeCount === lines.length || (tableLikeCount >= 2 && separatorCount >= 1);
}

function isLikelyCodeParagraph(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (lines.length === 0) {
    return false;
  }

  const codeLikeLineCount = lines.filter((line) => {
    return (
      /^\s*(const|let|var|function|class|import|export|if|for|while|return|async|await|try|catch)\b/.test(line) ||
      /=>/.test(line) ||
      /[{};<>]/.test(line) ||
      /\bconsole\./.test(line) ||
      /^\s{2,}\S/.test(line)
    );
  }).length;

  const joined = lines.join(" ");
  const symbolDensity = joined.replace(/[A-Za-z0-9_\u4e00-\u9fa5]/g, "").length / Math.max(joined.length, 1);
  const hasNaturalPunctuation = /[。！？!?，,：:]/.test(joined);

  return codeLikeLineCount >= Math.max(2, Math.ceil(lines.length * 0.6)) || (symbolDensity > 0.42 && !hasNaturalPunctuation);
}

function hasNaturalLanguage(text) {
  const normalized = normalizeInlineText(text);
  if (!normalized) {
    return false;
  }
  if (isPureLinkText(normalized)) {
    return false;
  }
  return /[\u4e00-\u9fa5]/.test(normalized) || /[A-Za-z]{3,}/.test(normalized);
}

function isLowInfoSentence(text) {
  const normalized = normalizeInlineText(text).replace(/^[，,。.!！？?：:;；\-\s]+/, "");
  if (!normalized) {
    return true;
  }

  const matchedPrefix = LOW_INFO_PREFIXES.find((prefix) => normalized.startsWith(prefix));
  if (!matchedPrefix) {
    return false;
  }

  const remain = normalized.slice(matchedPrefix.length).replace(/^[，,。.!！？?：:;；\-\s]+/, "");
  return remain.length < 8;
}

function pickMeaningfulSentence(text) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return "";
  }

  for (const sentence of sentences) {
    if (!hasNaturalLanguage(sentence)) {
      continue;
    }
    if (isLowInfoSentence(sentence)) {
      continue;
    }
    if (isPureLinkText(sentence)) {
      continue;
    }
    if (isLikelyCodeParagraph(sentence)) {
      continue;
    }
    return sentence;
  }

  return "";
}

function buildAssistantPreview(assistantMessages) {
  // assistantPreview（助手预览）优先取“首条有效回复”，更贴近该轮最初语义。
  const firstValidReply = assistantMessages
    .map((item) => String(item.text || ""))
    .find((text) => text.length > 0);

  if (!firstValidReply) {
    return "";
  }

  const cleaned = cleanForPreview(firstValidReply);
  if (!cleaned) {
    return "";
  }

  const paragraphs = splitParagraphs(cleaned);
  for (const paragraph of paragraphs) {
    // 跳过“纯代码 / 纯表格 / 纯链接”段，尽量抓到可读自然语言。
    if (isLikelyCodeParagraph(paragraph) || isPureTableParagraph(paragraph) || isPureLinkText(paragraph)) {
      continue;
    }

    const normalizedParagraph = normalizeParagraph(paragraph);
    if (!normalizedParagraph || !hasNaturalLanguage(normalizedParagraph)) {
      continue;
    }

    const meaningfulSentence = pickMeaningfulSentence(normalizedParagraph);
    if (meaningfulSentence) {
      return truncateByLength(meaningfulSentence, PREVIEW_MAX_LENGTH);
    }

    // 段内没拆出有效句，但整段是自然语言时，回退到整段截断。
    if (!isLowInfoSentence(normalizedParagraph)) {
      return truncateByLength(normalizedParagraph, PREVIEW_MAX_LENGTH);
    }
  }

  // 全部段落都无可用自然语言时，返回空串，交给渲染层做空态占位。
  return "";
}

function ensureMeaningfulTitle(title, userText, roundIndex) {
  const normalizedTitle = normalizeInlineText(title);
  const fallbackTitle = buildTitleFallbackFromUserText(userText);

  // 若标题异常短（常见于 DOM 提取异常），回退到用户原文片段，避免出现“设…/A/缺…”。
  const titleLength = Array.from(normalizedTitle).length;
  if (titleLength >= 4) {
    return normalizedTitle;
  }

  if (Array.from(fallbackTitle).length >= 4) {
    return truncateByLength(fallbackTitle, 30);
  }

  if (normalizedTitle) {
    return normalizedTitle;
  }

  return `第${roundIndex}轮对话`;
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
    const title = ensureMeaningfulTitle(extractRoundTitle(round.userText, index), round.userText, index);
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
      searchText: `${title} ${assistantPreview} ${round.userText} ${assistantText}`.trim(),
      assistantMessages: round.assistantMessages
    };
  });

  logger.info("轮次解析完成。", {
    messageCount: normalized.length,
    roundCount: finalized.length
  });

  return finalized;
}
