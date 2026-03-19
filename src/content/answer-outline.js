/**
 * 本文件负责“回答内章节提取（section extraction）”。
 * 目标：优先基于 Markdown/HTML 结构提取章节，再在结构不足时用文本规则兜底。
 */

import {
  SECTION_GROUP_CHILD_MAX_COUNT,
  SECTION_GROUP_MAX_COUNT,
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
    .replace(/^[\-*\u2022\s]+/, "")
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
      /^\s*(const|let|var|function|class|import|export|if|for|while|return|async|await|try|catch)\b/.test(line)
      || /=>/.test(line)
      || /[{};<>]/.test(line)
      || /\bconsole\./.test(line)
      || /^\s{2,}\S/.test(line)
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
    assistantElement.closest("[data-message-author-role='assistant']")
    || assistantElement.closest("[data-testid*='conversation-turn-assistant']")
    || assistantElement.closest("article[data-testid*='conversation-turn']")
    || assistantElement;

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

function buildCandidate(element, title, options = {}) {
  return {
    element,
    title,
    level: options.level || 3,
    sourceType: options.sourceType || "pattern",
    semanticType: options.semanticType || "neutral",
    priority: options.priority || 99,
    rawText: options.rawText || "",
    neutralHint: options.neutralHint || ""
  };
}

function getHeadingLevel(tagName) {
  const match = String(tagName || "").toLowerCase().match(/^h([1-6])$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * 结构优先：先识别真实 Markdown/HTML 标题节点。
 */
function collectHeadingCandidates(sourceEl, minCount) {
  const all = Array.from(sourceEl.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map((element) => {
      const level = getHeadingLevel(element.tagName);
      if (!level) {
        return null;
      }

      if (level <= 2) {
        return buildCandidate(element, element.textContent || "", {
          level,
          sourceType: "heading",
          semanticType: "main",
          priority: 10 + level
        });
      }

      if (level <= 4) {
        return buildCandidate(element, element.textContent || "", {
          level,
          sourceType: "heading",
          semanticType: "sub",
          priority: 10 + level
        });
      }

      return buildCandidate(element, element.textContent || "", {
        level,
        sourceType: "heading",
        semanticType: "ignored",
        priority: 10 + level
      });
    })
    .filter(Boolean);

  const primary = all.filter((item) => item.level <= 4);
  const deep = all.filter((item) => item.level >= 5);

  // h5/h6 默认不入导航；仅在结构不足且数量可控时，作为 child 兜底。
  if (primary.length < minCount && deep.length > 0 && deep.length <= 2) {
    const deepAsChild = deep.map((item) => ({
      ...item,
      semanticType: "sub"
    }));
    return [...primary, ...deepAsChild];
  }

  return primary;
}

function collectPatternCandidates(sourceEl) {
  const result = [];
  const blocks = Array.from(sourceEl.querySelectorAll("p, li, div, blockquote"));

  const mainPatterns = [
    /^(?:[一二三四五六七八九十百千]+\s*[、.．])\s*(.+)$/,
    /^(?:\d{1,2}\s*[.)、．])\s*(.+)$/,
    /^(?:第\s*\d+\s*(?:章|节|部分|阶段|点|步)[：:）)]?\s*)(.+)$/
  ];

  const subPatterns = [
    /^(?:情况\s*[A-Za-z0-9一二三四五六七八九十]+[：:）)]?\s*)(.+)$/,
    /^(?:(?:步骤|方法)\s*\d+[：:）)]?\s*)(.+)$/,
    /^(?:第\s*[一二三四五六七八九十\d]+\s*步[：:）)]?\s*)(.+)$/,
    /^(?:step\s*\d+[：:）)]?\s*)(.+)$/i
  ];

  for (const element of blocks) {
    if (element.querySelector("h1, h2, h3, h4, h5, h6")) {
      continue;
    }

    const rawText = normalizeInlineText(element.textContent || "");
    if (!rawText) {
      continue;
    }

    let matched = false;
    for (const pattern of mainPatterns) {
      const match = rawText.match(pattern);
      if (match) {
        result.push(buildCandidate(element, match[1] || rawText, {
          level: 3,
          sourceType: "pattern",
          semanticType: "main",
          priority: 40,
          rawText
        }));
        matched = true;
        break;
      }
    }
    if (matched) {
      continue;
    }

    for (const pattern of subPatterns) {
      const match = rawText.match(pattern);
      if (match) {
        result.push(buildCandidate(element, match[1] || rawText, {
          level: 4,
          sourceType: "pattern",
          semanticType: "sub",
          priority: 50,
          rawText
        }));
        matched = true;
        break;
      }
    }
    if (matched) {
      continue;
    }

    const looksLikeParagraphTitle =
      textLength(rawText) >= 3
      && textLength(rawText) <= 30
      && /[:：]$/.test(rawText);

    if (looksLikeParagraphTitle) {
      result.push(buildCandidate(element, rawText, {
        level: 4,
        sourceType: "pattern",
        semanticType: "neutral",
        priority: 65,
        rawText,
        neutralHint: "colon"
      }));
    }
  }

  const boldNodes = Array.from(
    sourceEl.querySelectorAll("p > strong:first-child, p > b:first-child, li > strong:first-child, li > b:first-child, div > strong:first-child, div > b:first-child")
  );

  for (const node of boldNodes) {
    const parent = node.parentElement;
    if (!parent || parent.querySelector("h1, h2, h3, h4, h5, h6")) {
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

    result.push(buildCandidate(parent, strongText, {
      level: 4,
      sourceType: "pattern",
      semanticType: "neutral",
      priority: 60,
      rawText: parentText,
      neutralHint: "bold"
    }));
  }

  return result;
}

function cleanupCandidates(candidates) {
  const filtered = [];
  const seenNormalized = new Set();

  for (const candidate of sortCandidatesByDom(candidates)) {
    const title = normalizeTitle(candidate.title);
    if (!title || isLowInfoTitle(title) || !hasNaturalText(title)) {
      continue;
    }

    if (candidate.semanticType === "ignored") {
      continue;
    }

    if (!isLocatableElement(candidate.element)) {
      continue;
    }

    const normalized = normalizeForCompare(title);
    if (!normalized || seenNormalized.has(normalized)) {
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

function chooseCandidates(sectionSourceEl, minCount) {
  const structured = cleanupCandidates(collectHeadingCandidates(sectionSourceEl, minCount));
  if (structured.length >= minCount) {
    return structured;
  }

  const pattern = cleanupCandidates(collectPatternCandidates(sectionSourceEl));
  if (structured.length === 0) {
    return pattern;
  }

  // 文本规则仅兜底补充，不能覆盖结构层级：通过优先级保证 heading 先保留。
  return cleanupCandidates([...structured, ...pattern]);
}

function isAcceptableNeutralCandidate(candidate) {
  const title = normalizeTitle(candidate?.title || "");
  if (!title) {
    return false;
  }

  const len = textLength(title);
  if (len < 3 || len > 24) {
    return false;
  }

  if (/[。.!！？?]$/.test(title)) {
    return false;
  }

  const punctCount = (title.match(/[，,。.!！？?；;、]/g) || []).length;
  if (punctCount / Math.max(len, 1) > 0.18) {
    return false;
  }

  if (candidate?.neutralHint === "bold") {
    return true;
  }

  const triggerText = normalizeInlineText(candidate?.rawText || title);
  return /[:：]$/.test(triggerText) || /^(?:\d+[.)、．]|[一二三四五六七八九十百千]+[、.．]|(?:步骤|方法|情况)\s*[A-Za-z0-9一二三四五六七八九十]+)/.test(triggerText);
}

function createGroup(roundId, index, candidate) {
  return {
    id: `ccn-group-${roundId}-${index}`,
    title: candidate.title,
    level: candidate.level,
    element: candidate.element,
    index,
    sourceType: candidate.sourceType,
    children: []
  };
}

function createChildItem(roundId, group, localIndex, candidate) {
  return {
    id: `ccn-section-${roundId}-g${group.index}-c${localIndex}`,
    title: candidate.title,
    element: candidate.element,
    index: localIndex,
    groupId: group.id,
    itemType: "child",
    sourceType: candidate.sourceType,
    level: candidate.level
  };
}

function buildFlatSections(roundId, candidates, maxCount) {
  const flatCandidates = candidates.slice(0, maxCount);
  const sections = flatCandidates.map((candidate, idx) => ({
    id: `ccn-section-${roundId}-flat-${idx + 1}`,
    title: candidate.title,
    element: candidate.element,
    index: idx + 1,
    groupId: null,
    itemType: "flat",
    sourceType: "fallback",
    level: candidate.level
  }));

  return {
    sectionGroups: [],
    sections
  };
}

/**
 * 把候选章节组装成“group + child”结构，并同步产出扁平 sections 索引。
 */
function buildGroupsAndSections(roundId, candidates, options = {}) {
  const groupMax = Number.isFinite(options.groupMax) ? options.groupMax : SECTION_GROUP_MAX_COUNT;
  const childMax = Number.isFinite(options.childMax) ? options.childMax : SECTION_GROUP_CHILD_MAX_COUNT;
  const flatMax = Number.isFinite(options.flatMax) ? options.flatMax : SECTION_MAX_COUNT;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      sectionGroups: [],
      sections: []
    };
  }

  const hasMain = candidates.some((item) => item.semanticType === "main");
  if (!hasMain) {
    return buildFlatSections(roundId, candidates, flatMax);
  }

  const groups = [];
  let currentGroup = null;

  for (const candidate of candidates) {
    if (candidate.semanticType === "main") {
      if (groups.length >= groupMax) {
        continue;
      }
      currentGroup = createGroup(roundId, groups.length + 1, candidate);
      groups.push(currentGroup);
      continue;
    }

    if (candidate.semanticType === "sub") {
      if (!currentGroup || currentGroup.children.length >= childMax) {
        continue;
      }
      currentGroup.children.push(createChildItem(roundId, currentGroup, currentGroup.children.length + 1, candidate));
      continue;
    }

    if (candidate.semanticType === "neutral") {
      if (!currentGroup || currentGroup.children.length >= childMax || !isAcceptableNeutralCandidate(candidate)) {
        continue;
      }
      currentGroup.children.push(createChildItem(roundId, currentGroup, currentGroup.children.length + 1, candidate));
    }
  }

  if (groups.length === 0) {
    return buildFlatSections(roundId, candidates, flatMax);
  }

  const sections = [];
  let flatIndex = 1;

  for (const group of groups) {
    sections.push({
      id: group.id,
      title: group.title,
      element: group.element,
      index: flatIndex,
      groupId: group.id,
      itemType: "group",
      sourceType: group.sourceType,
      level: group.level
    });
    flatIndex += 1;

    for (const child of group.children) {
      sections.push({
        id: child.id,
        title: child.title,
        element: child.element,
        index: flatIndex,
        groupId: group.id,
        itemType: "child",
        sourceType: child.sourceType,
        level: child.level
      });
      flatIndex += 1;
    }
  }

  return {
    sectionGroups: groups,
    sections
  };
}

/**
 * 提取单条回答中的章节结构。
 * 说明：首版不做 AI 提纲生成，仅做“结构识别 + 稳定兜底”。
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
      sectionGroups: [],
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
      sectionGroups: [],
      sections: [],
      canShowButton: false,
      bodyLength,
      reason: isShortAnswer ? "short-answer" : (isPureCode ? "pure-code" : "pure-table")
    };
  }

  let sectionGroups = [];
  let sections = [];

  try {
    const candidates = chooseCandidates(sectionSourceEl, minCount);
    const grouped = buildGroupsAndSections(roundId, candidates, {
      groupMax: SECTION_GROUP_MAX_COUNT,
      childMax: SECTION_GROUP_CHILD_MAX_COUNT,
      flatMax: maxCount
    });

    sectionGroups = grouped.sectionGroups;
    sections = grouped.sections.filter((item) => isLocatableElement(item.element));

    if (sections.length > maxCount) {
      sections = sections.slice(0, maxCount);
      const validSectionIdSet = new Set(sections.map((item) => item.id));
      sectionGroups = sectionGroups
        .map((group) => ({
          ...group,
          children: group.children.filter((child) => validSectionIdSet.has(child.id))
        }))
        .filter((group) => validSectionIdSet.has(group.id) || group.children.length > 0);
    }
  } catch (error) {
    logger?.warn("章节分组提取失败，已降级为空结果。", error);
    sectionGroups = [];
    sections = [];
  }

  const hasEnoughSections = sections.length >= minCount;
  if (!hasEnoughSections && logger) {
    logger.debug("章节提取未达到最小数量，已降级为空。", {
      roundId,
      sectionCount: sections.length,
      groupCount: sectionGroups.length,
      bodyLength
    });
  }

  return {
    sectionSourceEl,
    sectionGroups: hasEnoughSections ? sectionGroups : [],
    sections: hasEnoughSections ? sections : [],
    canShowButton: hasEnoughSections,
    bodyLength,
    reason: hasEnoughSections ? "ok" : "insufficient-sections"
  };
}
