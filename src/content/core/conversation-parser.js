// 本文件属于 core（核心层）轮次解析器：把统一消息模型组装为“问答轮次”数据。
import {
  PREVIEW_MAX_LENGTH,
  ROUND_STATUS,
  SECTION_MAX_COUNT,
  SECTION_MIN_COUNT
} from "../constants.js";
import { extractRoundTitle } from "../title-extractor.js";
import { extractAnswerSections } from "../answer-outline.js";

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

function hasImageIntent(text) {
  return /(?:图片|配图|画图|插画|海报|logo|图标|image|illustration|poster|icon|dalle)/i.test(String(text || ""));
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

function hasLikelyMediaNode(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (
    element.querySelector(
      "img, picture, canvas, svg, svg image, figure img, video, [role='img'], [aria-label*='image'], [aria-label*='图片'], [style*='background-image'], [data-testid*='image'], [data-testid*='dalle']"
    )
  ) {
    return true;
  }

  // 兜底：可视节点很多但文本极少，通常是图片容器。
  const allNodeCount = element.querySelectorAll("*").length;
  if (allNodeCount >= 16) {
    const rect = element.getBoundingClientRect();
    const hasLargeVisualBlock = rect.width >= 120 && rect.height >= 90;
    const textLength = normalizeInlineText(element.textContent || "").length;
    if (hasLargeVisualBlock && textLength <= 10) {
      return true;
    }
  }

  return false;
}

function hasImageLikeContent(assistantMessages) {
  return assistantMessages.some((item) => {
    const element = item?.element;
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const scopeCandidates = [
      element,
      element.closest("[data-message-id]"),
      element.closest("[data-testid*='conversation-turn']"),
      element.parentElement
    ].filter(Boolean);

    for (const scope of scopeCandidates) {
      if (hasLikelyMediaNode(scope)) {
        return true;
      }
    }

    // 图片回答常见于可视节点，统一归类为“生成图片”。
    // 兼容 Markdown 图片语法（当页面结构变化导致图片节点未直接命中时）。
    const text = String(item?.text || "");
    return /!\[[^\]]*\]\([^)]+\)/.test(text) || /(?:生成|created).*(?:图片|image)/i.test(text);
  });
}

function hasVisualOnlyReply(assistantMessages) {
  return assistantMessages.some((item) => {
    const element = item?.element;
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const text = normalizeInlineText(item?.text || "");
    const hasRichVisualNode = hasLikelyMediaNode(element);

    return hasRichVisualNode && text.length <= 6;
  });
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

function buildAssistantPreview(assistantMessages, options = {}) {
  const imageReply = options.hasImageReply === true || hasImageLikeContent(assistantMessages);
  const visualOnlyReply = hasVisualOnlyReply(assistantMessages);

  // assistantPreview（助手预览）优先取“首条有效回复”，更贴近该轮最初语义。
  const firstValidReply = assistantMessages
    .map((item) => String(item.text || ""))
    .find((text) => text.length > 0);

  if (!firstValidReply) {
    return imageReply || visualOnlyReply ? "生成图片" : "";
  }

  const cleaned = cleanForPreview(firstValidReply);
  if (!cleaned) {
    return imageReply || visualOnlyReply ? "生成图片" : "";
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
  return imageReply || visualOnlyReply ? "生成图片" : "";
}

function detectImageReply(assistantMessages) {
  return hasImageLikeContent(assistantMessages) || hasVisualOnlyReply(assistantMessages);
}

function scoreSectionCandidateMessage(message) {
  if (!(message?.element instanceof HTMLElement)) {
    return -1;
  }

  const text = normalizeInlineText(message?.text || "");
  const textLength = Array.from(text).length;
  const element = message.element;

  // 优先选择结构更丰富的消息块，提升章节提取命中率。
  const headingCount = element.querySelectorAll("h1, h2, h3, h4, h5, h6").length;
  const listCount = element.querySelectorAll("ul, ol, li").length;
  const paragraphCount = element.querySelectorAll("p, blockquote").length;
  const markdownHint = element.querySelector(".markdown, [data-testid='conversation-turn-content']") ? 1 : 0;

  return textLength + headingCount * 40 + listCount * 6 + paragraphCount * 4 + markdownHint * 30;
}

function rankAssistantMessagesForSections(assistantMessages) {
  const list = Array.isArray(assistantMessages) ? assistantMessages : [];
  const ranked = [];
  const seen = new Set();

  for (const [index, message] of list.entries()) {
    if (!(message?.element instanceof HTMLElement)) {
      continue;
    }

    // 同一元素只保留一次，避免重复提取造成无意义开销。
    if (seen.has(message.element)) {
      continue;
    }
    seen.add(message.element);

    ranked.push({
      message,
      index,
      score: scoreSectionCandidateMessage(message)
    });
  }

  // 分值高优先；同分时优先后出现的消息（通常更接近用户当前可见正文块）。
  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.index - left.index;
  });

  return ranked;
}

function pickBestSectionResultForRound(params = {}) {
  const {
    roundId = "",
    assistantMessages = [],
    logger = null,
    minCount = SECTION_MIN_COUNT,
    maxCount = SECTION_MAX_COUNT
  } = params;

  const rankedMessages = rankAssistantMessagesForSections(assistantMessages);
  if (rankedMessages.length === 0) {
    return null;
  }

  let bestPass = null;
  let bestFallback = null;

  for (const item of rankedMessages) {
    const result = extractAnswerSections({
      roundId,
      assistantElement: item.message.element,
      assistantText: item.message.text || "",
      logger,
      config: {
        minCount,
        maxCount
      }
    });

    const sections = Array.isArray(result?.sections) ? result.sections : [];
    const canShowButton = result?.canShowButton === true && sections.length >= minCount;
    const candidate = {
      ...item,
      sectionResult: result,
      sectionCount: sections.length,
      canShowButton
    };

    if (canShowButton) {
      if (
        !bestPass
        || candidate.sectionCount > bestPass.sectionCount
        || (candidate.sectionCount === bestPass.sectionCount && candidate.score > bestPass.score)
      ) {
        bestPass = candidate;
      }
      continue;
    }

    if (
      !bestFallback
      || candidate.sectionCount > bestFallback.sectionCount
      || (candidate.sectionCount === bestFallback.sectionCount && candidate.score > bestFallback.score)
    ) {
      bestFallback = candidate;
    }
  }

  return bestPass || bestFallback;
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
    // 图片回复常见“文本为空但可视内容存在”，此时按已完成处理。
    if (detectImageReply(round.assistantMessages)) {
      return ROUND_STATUS.COMPLETE;
    }
    return ROUND_STATUS.EMPTY;
  }

  return ROUND_STATUS.COMPLETE;
}

function normalizeMessages(messages, logger) {
  const result = [];

  const list = Array.isArray(messages) ? messages : [];
  for (const [index, message] of list.entries()) {
    try {
      const role = String(message?.role || "unknown");
      const text = normalizeInlineText(message?.text || "");
      const element = message?.element || null;
      const state = {
        isStreaming: Boolean(message?.state?.isStreaming),
        isError: Boolean(message?.state?.isError),
        isEmpty: message?.state?.isEmpty == null ? text.length === 0 : Boolean(message.state.isEmpty)
      };

      if (role === "unknown") {
        logger?.warn("跳过无法识别角色的消息节点。", { index });
        continue;
      }

      result.push({
        role,
        text,
        element,
        state,
        html: String(message?.html || ""),
        platform: String(message?.platform || "unknown"),
        id: String(message?.id || `msg-${index}`),
        meta: message?.meta || {},
        originalIndex: Number.isFinite(message?.index) ? message.index : index
      });
    } catch (error) {
      // 单节点异常不应中断整轮解析。
      logger?.warn("解析单条消息失败，已跳过该节点。", error);
    }
  }

  return result;
}

export function buildConversationRounds(unifiedMessages, options) {
  const { roundIdManager, logger } = options;
  const normalized = normalizeMessages(unifiedMessages, logger);
  const rounds = [];
  let currentRound = null;

  for (const [index, message] of normalized.entries()) {
    if (message.role === "user") {
      currentRound = {
        index: rounds.length + 1,
        userText: message.text,
        userAnchorEl: message.element,
        platform: message.platform,
        assistantMessages: []
      };
      rounds.push(currentRound);
      continue;
    }

    if (message.role === "assistant") {
      if (!currentRound) {
        logger?.warn("检测到未配对的 assistant 消息，已跳过。", { index });
        continue;
      }

      currentRound.assistantMessages.push({
        text: message.text,
        element: message.element,
        state: message.state,
        id: message.id,
        role: message.role,
        platform: message.platform,
        meta: message.meta,
        html: message.html
      });
    }
  }

  const finalized = rounds.map((round, idx) => {
    const index = idx + 1;
    const isLastRound = idx === rounds.length - 1;
    const status = summarizeRoundStatus(round);
    const title = ensureMeaningfulTitle(extractRoundTitle(round.userText, index), round.userText, index);
    const hasImageReply = detectImageReply(round.assistantMessages);
    const assistantPreview = buildAssistantPreview(round.assistantMessages, {
      hasImageReply
    });
    const id = roundIdManager.assign(round, index);
    const assistantMessageEls = round.assistantMessages.map((item) => item.element);
    const assistantText = round.assistantMessages.map((item) => item.text).join(" ");
    const userAskedForImage = hasImageIntent(round.userText);
    const canUseIntentFallback = userAskedForImage
      && round.assistantMessages.length > 0
      && status !== ROUND_STATUS.PENDING_REPLY
      && status !== ROUND_STATUS.STREAMING;
    const imageLikeByIntent = !assistantPreview && canUseIntentFallback;
    const resolvedHasImageReply = hasImageReply || imageLikeByIntent;
    const resolvedAssistantPreview = assistantPreview
      || (resolvedHasImageReply ? "生成图片" : "")
      || (
        !assistantPreview
          && userAskedForImage
          && (status === ROUND_STATUS.COMPLETE || status === ROUND_STATUS.EMPTY)
          ? "生成图片"
          : ""
      );
    // 章节导航仅在“已完成回答”触发，避免流式阶段反复抖动。
    // 但历史轮次（非最后一轮）通常已稳定，即使状态误判为 streaming/error，也应允许提取章节。
    const shouldBuildSections = status === ROUND_STATUS.COMPLETE
      || (!isLastRound && status !== ROUND_STATUS.PENDING_REPLY);
    let sectionSourceEl = null;
    let sectionGroups = [];
    let sections = [];
    let hasSections = false;
    if (shouldBuildSections) {
      const sectionCandidate = pickBestSectionResultForRound({
        roundId: id,
        assistantMessages: round.assistantMessages,
        logger,
        minCount: SECTION_MIN_COUNT,
        maxCount: SECTION_MAX_COUNT
      });

      const sectionResult = sectionCandidate?.sectionResult || null;
      if (sectionResult) {
        sectionSourceEl = sectionResult.sectionSourceEl;
        sectionGroups = Array.isArray(sectionResult.sectionGroups) ? sectionResult.sectionGroups : [];
        sections = Array.isArray(sectionResult.sections) ? sectionResult.sections : [];
        hasSections = sectionResult.canShowButton === true && sections.length >= SECTION_MIN_COUNT;
      }
    }

    return {
      id,
      index,
      platform: round.platform || round.assistantMessages?.[0]?.platform || "unknown",
      title,
      status,
      userText: round.userText,
      userAnchorEl: round.userAnchorEl,
      assistantMessageEls,
      assistantPreview: resolvedAssistantPreview,
      hasImageReply: resolvedHasImageReply,
      searchText: `${title} ${resolvedAssistantPreview} ${round.userText} ${assistantText}`.trim(),
      assistantMessages: round.assistantMessages,
      sectionSourceEl,
      sectionGroups,
      sections,
      hasSections
    };
  });

  logger?.info("轮次解析完成。", {
    messageCount: normalized.length,
    roundCount: finalized.length,
    sectionRoundCount: finalized.filter((round) => round.hasSections === true).length
  });

  return finalized;
}
