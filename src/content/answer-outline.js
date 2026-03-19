/**
 * 本文件负责“回答内章节提取（section extraction）”。
 * 目标：从单条 assistant（助手）回答里提取可导航的小标题，并输出稳定、可滚动定位的章节列表。
 */

import {
  SECTION_MAX_COUNT,
  SECTION_MIN_BODY_LENGTH,
  SECTION_MIN_COUNT
} from "./constants.js";

function normalizeInlineText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function textLength(text) {
  return Array.from(String(text || "")).length;
}

function normalizeTitle(text) {
  return normalizeInlineText(text)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*([^*]+)\*\*$/, "$1")
    .replace(/^[\-\*\u2022\s]+/, "")
    .replace(/^(?:第\s*\d+\s*[章节部分步]|\d+\s*[.)、．]|[一二三四五六七八九十百千]+\s*[、.．])\s*/, "")
    .replace(/[：:。.!！?？\-\s]+$/, "")
    .trim();
}

function normalizeForCompare(text) {
  return normalizeTitle(text)
    .toLowerCase()
    .replace(/[\s\-_:：，。,.!?！？;；()（）\[\]【】"'`~]/g, "")
    .replace(/^(?:第\d+[章节部分步]|\d+|[一二三四五六七八九十百千]+)+/, "");
}

function isLowInfoTitle(title) {
  const normalized = normalizeTitle(title);
  if (!normalized) {
    return true;
  }

  if (textLength(normalized) < 3) {
    return true;
  }

  const lowInfoPatterns = [
    /^(?:好的?|可以|当然可以|没问题|继续|下一步|然后|接下来|说明|备注|提示)$/,
    /^(?:步骤|阶段|小结|总结|结论|补充|注意事项)$/,
    /^(?:第一步|第二步|第三步|第四步)$/
  ];

  return lowInfoPatterns.some((pattern) => pattern.test(normalized));
}

function hasNaturalText(text) {
  const normalized = normalizeInlineText(text);
  if (!normalized) {
    return false;
  }
  return /[\u4e00-\u9fa5A-Za-z]/.test(normalized);
}

function isPureTableText(text) {
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

function isLikelyCodeText(text) {
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

function isLocatableElement(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return false;
  }

  if (element.closest("[aria-hidden='true']")) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return true;
  }

  return element.getClientRects().length > 0;
}

function extractTextWithoutToolbar(sourceEl) {
  try {
    const cloned = sourceEl.cloneNode(true);
    cloned.querySelectorAll("[data-ccn-section-toolbar='1']").forEach((node) => node.remove());
    return String(cloned.innerText || cloned.textContent || "");
  } catch (_error) {
    return String(sourceEl?.innerText || sourceEl?.textContent || "");
  }
}

function pickLongestElement(elements) {
  let best = null;
  let bestLength = 0;

  for (const element of elements) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    const length = textLength(normalizeInlineText(extractTextWithoutToolbar(element)));
    if (length > bestLength) {
      best = element;
      bestLength = length;
    }
  }

  return best;
}

function resolveSectionSourceElement(assistantElement) {
  if (!(assistantElement instanceof HTMLElement)) {
    return null;
  }

  const assistantRoot =
    assistantElement.closest("[data-message-author-role='assistant']") ||
    assistantElement.closest("[data-testid*='conversation-turn-assistant']") ||
    assistantElement.closest("article[data-testid*='conversation-turn']") ||
    assistantElement;

  const highPriorityCandidates = [
    assistantRoot.querySelector("[data-testid='conversation-turn-content']"),
    assistantRoot.querySelector(".markdown"),
    assistantRoot.querySelector("[data-message-id] .markdown"),
    assistantRoot.querySelector("[data-message-id]")
  ].filter(Boolean);

  const bestHighPriority = pickLongestElement(highPriorityCandidates);
  if (bestHighPriority) {
    return bestHighPriority;
  }

  const dirAutoNodes = Array.from(assistantRoot.querySelectorAll("[dir='auto']"));
  const bestDirAuto = pickLongestElement(dirAutoNodes);
  if (bestDirAuto) {
    return bestDirAuto;
  }

  return assistantRoot;
}

function getElementLevel(tagName) {
  const match = String(tagName || "").toLowerCase().match(/^h([1-6])$/);
  if (!match) {
    return 3;
  }
  return Number.parseInt(match[1], 10);
}

function collectNativeHeadingCandidates(sourceEl) {
  const headings = Array.from(sourceEl.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  return headings.map((element) => ({
    element,
    title: normalizeTitle(element.textContent || ""),
    level: getElementLevel(element.tagName),
    priority: 1
  }));
}

function collectNumberedHeadingCandidates(sourceEl) {
  const blocks = Array.from(sourceEl.querySelectorAll("p, li, div, blockquote"));
  const pattern = /^(?:第\s*\d+\s*[章节部分步]|\d{1,2}\s*[.)、．]|[一二三四五六七八九十百千]+\s*[、.．]|(?:步骤|阶段)\s*\d+)\s*[:：\-）)]?\s*(.+)$/;

  const result = [];
  for (const element of blocks) {
    if (element.querySelector("h1, h2, h3, h4, h5, h6")) {
      continue;
    }

    const rawText = normalizeInlineText(element.textContent || "");
    const match = rawText.match(pattern);
    if (!match) {
      continue;
    }

    result.push({
      element,
      title: normalizeTitle(match[1] || rawText),
      level: 3,
      priority: 2
    });
  }

  return result;
}

function collectBoldHeadingCandidates(sourceEl) {
  const boldNodes = Array.from(
    sourceEl.querySelectorAll("p > strong:first-child, p > b:first-child, li > strong:first-child, li > b:first-child, div > strong:first-child, div > b:first-child")
  );
  const result = [];

  for (const node of boldNodes) {
    const parent = node.parentElement;
    if (!parent) {
      continue;
    }

    const strongText = normalizeTitle(node.textContent || "");
    if (!strongText) {
      continue;
    }

    const parentText = normalizeInlineText(parent.textContent || "");
    if (!parentText.startsWith(strongText)) {
      continue;
    }

    result.push({
      element: parent,
      title: strongText,
      level: 4,
      priority: 3
    });
  }

  return result;
}

function collectStageSubtitleCandidates(sourceEl) {
  const blocks = Array.from(sourceEl.querySelectorAll("p, li, div, blockquote"));
  const result = [];

  for (const element of blocks) {
    if (element.querySelector("h1, h2, h3, h4, h5, h6, strong, b")) {
      continue;
    }

    const text = normalizeInlineText(element.textContent || "");
    if (!text || textLength(text) < 4 || textLength(text) > 34) {
      continue;
    }

    const looksLikeSubtitle =
      /[:：]$/.test(text) ||
      /^(?:准备阶段|执行阶段|收尾阶段|背景|目标|步骤|总结|结论|注意事项)/.test(text);

    if (!looksLikeSubtitle) {
      continue;
    }

    result.push({
      element,
      title: normalizeTitle(text),
      level: 4,
      priority: 4
    });
  }

  return result;
}

function chooseCandidatePool(nativeCandidates, numberedCandidates, boldCandidates, stageCandidates) {
  if (nativeCandidates.length >= SECTION_MIN_COUNT) {
    return nativeCandidates;
  }

  return [...nativeCandidates, ...numberedCandidates, ...boldCandidates, ...stageCandidates];
}

function sortCandidatesByDom(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.element === b.element) {
      return a.priority - b.priority;
    }

    const relation = a.element.compareDocumentPosition(b.element);
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }

    return a.priority - b.priority;
  });
}

function calcOverlapRatio(a, b) {
  const setA = new Set(Array.from(a));
  const setB = new Set(Array.from(b));
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const char of setA) {
    if (setB.has(char)) {
      shared += 1;
    }
  }

  return shared / Math.min(setA.size, setB.size);
}

function isHighlySimilarTitle(a, b) {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  if ((left.includes(right) || right.includes(left)) && Math.abs(left.length - right.length) <= 4) {
    return true;
  }

  return calcOverlapRatio(left, right) >= 0.82 && Math.abs(left.length - right.length) <= 5;
}

function dedupeAndFilterCandidates(candidates) {
  const filtered = [];
  const seenNormalized = new Set();

  for (const candidate of sortCandidatesByDom(candidates)) {
    const title = normalizeTitle(candidate.title);
    if (!title || isLowInfoTitle(title) || !hasNaturalText(title)) {
      continue;
    }

    if (!isLocatableElement(candidate.element)) {
      continue;
    }

    const normalized = normalizeForCompare(title);
    if (!normalized) {
      continue;
    }

    if (seenNormalized.has(normalized)) {
      continue;
    }

    const last = filtered[filtered.length - 1];
    if (last && isHighlySimilarTitle(last.title, title)) {
      continue;
    }

    seenNormalized.add(normalized);
    filtered.push({
      ...candidate,
      title
    });
  }

  return filtered;
}

/**
 * 提取单条回答中的章节结构。
 * 说明：这里只做“结构识别”，不做 AI 自动总结，保证首版稳定。
 */
export function extractAnswerSections(options = {}) {
  const {
    roundId = "",
    assistantElement = null,
    assistantText = "",
    logger = null,
    config = {}
  } = options;

  const minCount = Number.isFinite(config.minCount) ? config.minCount : SECTION_MIN_COUNT;
  const maxCount = Number.isFinite(config.maxCount) ? config.maxCount : SECTION_MAX_COUNT;
  const minBodyLength = Number.isFinite(config.minBodyLength) ? config.minBodyLength : SECTION_MIN_BODY_LENGTH;

  const sectionSourceEl = resolveSectionSourceElement(assistantElement);
  if (!sectionSourceEl) {
    return {
      sectionSourceEl: null,
      sections: [],
      canShowButton: false,
      bodyLength: 0,
      reason: "missing-source"
    };
  }

  const sourceRawText = extractTextWithoutToolbar(sectionSourceEl);
  const sourceTextNormalized = normalizeInlineText(sourceRawText);
  const assistantTextNormalized = normalizeInlineText(assistantText);
  const bodyText = sourceTextNormalized.length >= assistantTextNormalized.length
    ? sourceTextNormalized
    : assistantTextNormalized;
  const bodyLength = textLength(bodyText);
  const isShortAnswer = bodyLength < minBodyLength;
  const isPureCode = isLikelyCodeText(sourceTextNormalized || assistantTextNormalized);
  const isPureTable = isPureTableText(sourceRawText || assistantText);

  if (isShortAnswer || isPureCode || isPureTable) {
    return {
      sectionSourceEl,
      sections: [],
      canShowButton: false,
      bodyLength,
      reason: isShortAnswer ? "short-answer" : (isPureCode ? "pure-code" : "pure-table")
    };
  }

  const nativeCandidates = collectNativeHeadingCandidates(sectionSourceEl);
  const numberedCandidates = collectNumberedHeadingCandidates(sectionSourceEl);
  const boldCandidates = collectBoldHeadingCandidates(sectionSourceEl);
  const stageCandidates = collectStageSubtitleCandidates(sectionSourceEl);

  const selectedCandidates = chooseCandidatePool(nativeCandidates, numberedCandidates, boldCandidates, stageCandidates);
  const cleanedCandidates = dedupeAndFilterCandidates(selectedCandidates);

  const sections = cleanedCandidates
    .slice(0, Math.max(minCount, maxCount))
    .map((candidate, index) => ({
      id: `ccn-section-${roundId}-${index + 1}`,
      title: candidate.title,
      level: candidate.level,
      element: candidate.element,
      roundId,
      index: index + 1
    }));

  const locatableSections = sections.filter((section) => isLocatableElement(section.element));
  const hasEnoughSections = locatableSections.length >= minCount;

  if (!hasEnoughSections && logger) {
    logger.debug("章节提取未达到最小数量，已降级为空。", {
      roundId,
      candidateCount: cleanedCandidates.length,
      locatableCount: locatableSections.length,
      bodyLength
    });
  }

  return {
    sectionSourceEl,
    sections: hasEnoughSections ? locatableSections.slice(0, maxCount) : [],
    canShowButton: hasEnoughSections,
    bodyLength,
    reason: hasEnoughSections ? "ok" : "insufficient-sections"
  };
}
