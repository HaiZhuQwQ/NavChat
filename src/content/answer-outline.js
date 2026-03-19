/**
 * 本文件负责回答内章节提取（section extraction，章节提取）。
 * 当前策略：仅使用真实标题标签（h1/h2/h3），不做任何文本猜测。
 */

import {
  SECTION_HEADING_SELECTOR,
  SECTION_MAX_COUNT,
  SECTION_MIN_COUNT
} from "./constants.js";

function normalizeHeadingText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getHeadingLevel(element) {
  const match = String(element?.tagName || "").toLowerCase().match(/^h([1-3])$/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function isLocatableHeading(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return false;
  }

  if (element.closest("#ccn-root") || element.closest("[aria-hidden='true']")) {
    return false;
  }

  return true;
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

  return (
    assistantRoot.querySelector("[data-testid='conversation-turn-content']")
    || assistantRoot.querySelector(".markdown")
    || assistantRoot.querySelector("[data-message-id] .markdown")
    || assistantRoot.querySelector("[data-message-id]")
    || assistantRoot
  );
}

function collectHeadingCandidates(sectionSourceEl) {
  const headingNodes = Array.from(sectionSourceEl.querySelectorAll(SECTION_HEADING_SELECTOR));
  const candidates = [];

  for (const node of headingNodes) {
    if (!isLocatableHeading(node)) {
      continue;
    }

    const level = getHeadingLevel(node);
    if (!level) {
      continue;
    }

    const title = normalizeHeadingText(node.textContent || "");
    if (!title) {
      continue;
    }

    candidates.push({
      element: node,
      title,
      level
    });
  }

  return candidates;
}

function buildFlatSections(roundId, candidates, maxCount) {
  const limited = candidates.slice(0, maxCount);
  const sections = limited.map((candidate, idx) => ({
    id: `ccn-section-${roundId}-${idx + 1}`,
    title: candidate.title,
    element: candidate.element,
    index: idx + 1,
    level: candidate.level,
    itemType: "flat",
    groupId: ""
  }));

  return {
    sectionGroups: [],
    sections
  };
}

function buildLevelHierarchy(roundId, candidates, maxCount, parentLevel, childLevel) {
  const sectionGroups = [];
  const sections = [];
  let currentGroup = null;

  for (const candidate of candidates) {
    if (sections.length >= maxCount) {
      break;
    }

    // 规则：父级标题只作为一级章节（group，分组）。
    if (candidate.level === parentLevel) {
      const groupIndex = sectionGroups.length + 1;
      const groupId = `ccn-group-${roundId}-${groupIndex}`;
      const group = {
        id: groupId,
        title: candidate.title,
        element: candidate.element,
        index: groupIndex,
        level: parentLevel,
        children: []
      };

      sectionGroups.push(group);
      currentGroup = group;
      sections.push({
        id: groupId,
        title: group.title,
        element: group.element,
        index: sections.length + 1,
        level: parentLevel,
        itemType: "group",
        groupId
      });
      continue;
    }

    // 规则：子级标题只挂到最近的父级下，避免不同层级平铺混在一起。
    if (candidate.level === childLevel && currentGroup) {
      const childIndex = currentGroup.children.length + 1;
      const childId = `ccn-section-${roundId}-g${currentGroup.index}-c${childIndex}`;
      const child = {
        id: childId,
        title: candidate.title,
        element: candidate.element,
        index: childIndex,
        level: childLevel,
        itemType: "child",
        groupId: currentGroup.id
      };

      currentGroup.children.push(child);
      sections.push({
        ...child,
        index: sections.length + 1
      });
    }
  }

  return {
    sectionGroups,
    sections
  };
}

function hasValidHierarchy(candidates, parentLevel, childLevel) {
  let seenParent = false;
  for (const candidate of candidates) {
    if (candidate.level === parentLevel) {
      seenParent = true;
      continue;
    }
    if (candidate.level === childLevel && seenParent) {
      return true;
    }
  }
  return false;
}

function pickSingleLevelCandidates(candidates) {
  // 单层降级策略：优先 h2（你指定“无 h1 时展示 h2”），其次 h1，最后 h3。
  const h2 = candidates.filter((candidate) => candidate.level === 2);
  if (h2.length > 0) {
    return h2;
  }

  const h1 = candidates.filter((candidate) => candidate.level === 1);
  if (h1.length > 0) {
    return h1;
  }

  return candidates.filter((candidate) => candidate.level === 3);
}

/**
 * 提取单条回答中的章节。
 * 说明：当页面具备 h1+h2 原生结构时，输出一级/子级；否则回退到平铺。
 */
export function extractAnswerSections(options = {}) {
  const {
    roundId = "",
    assistantElement = null,
    logger = null,
    config = {}
  } = options;

  const minCount = Number.isFinite(config.minCount) ? config.minCount : SECTION_MIN_COUNT;
  const maxCount = Number.isFinite(config.maxCount) ? config.maxCount : SECTION_MAX_COUNT;

  const sectionSourceEl = resolveSectionSourceElement(assistantElement);
  if (!sectionSourceEl) {
    return {
      sectionSourceEl: null,
      sectionGroups: [],
      sections: [],
      canShowButton: false,
      reason: "missing-source"
    };
  }

  try {
    // 只读取 h1/h2/h3，不从 p/li/strong 等节点推断章节。
    const candidates = collectHeadingCandidates(sectionSourceEl);
    if (candidates.length === 0) {
      return {
        sectionSourceEl,
        sectionGroups: [],
        sections: [],
        canShowButton: false,
        reason: "no-headings"
      };
    }

    const canUseH1H2Hierarchy = hasValidHierarchy(candidates, 1, 2);
    const canUseH2H3Hierarchy = hasValidHierarchy(candidates, 2, 3);

    // 分层策略：
    // 1) 优先 h1->h2；
    // 2) 若没有 h1 结构但有 h2->h3，则用 h2->h3；
    // 3) 否则降级到“单一层级平铺”，不再把不同层级混排到同一级。
    let built;
    if (canUseH1H2Hierarchy) {
      built = buildLevelHierarchy(roundId, candidates, maxCount, 1, 2);
    } else if (canUseH2H3Hierarchy) {
      built = buildLevelHierarchy(roundId, candidates, maxCount, 2, 3);
    } else {
      built = buildFlatSections(roundId, pickSingleLevelCandidates(candidates), maxCount);
    }

    const canShowButton = built.sections.length >= minCount;

    return {
      sectionSourceEl,
      sectionGroups: built.sectionGroups,
      sections: built.sections,
      canShowButton,
      reason: canShowButton ? "ok" : "insufficient-sections"
    };
  } catch (error) {
    logger?.warn("章节提取失败，已返回空结果。", error);
    return {
      sectionSourceEl,
      sectionGroups: [],
      sections: [],
      canShowButton: false,
      reason: "extract-failed"
    };
  }
}
