// 主入口：负责初始化、平台适配器选择、轮次解析刷新、面板与滚动管理器编排。
import { CONFIG } from "./constants.js";
import { createLogger } from "./logger.js";
import { RoundIdManager } from "./round-id.js";
import { buildConversationRounds } from "./core/conversation-parser.js";
import { collectUnifiedMessages } from "./core/message-pipeline.js";
import { AdapterRegistry } from "./core/adapter-registry.js";
import { ChatGPTAdapter } from "./adapters/chatgpt-adapter.js";
import { PanelView } from "./panel-view.js";
import { ScrollManager } from "./scroll-manager.js";
import { loadPanelCollapsed, savePanelCollapsed } from "./state-store.js";

const RUNTIME_INSTANCE_KEY = "__CCN_RUNTIME_INSTANCE__";
const CONVERSATION_MUTATION_SELECTOR = [
  "[data-message-author-role]",
  "[data-testid*='conversation-turn']",
  "[data-message-id]",
  "[data-testid='conversation-turn-content']",
  ".markdown"
].join(", ");

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function toElement(node) {
  if (node instanceof HTMLElement) {
    return node;
  }
  if (node instanceof Text) {
    return node.parentElement;
  }
  return null;
}

function isInsideNavChatPanel(element) {
  return element instanceof HTMLElement && Boolean(element.closest("#ccn-root"));
}

function hasConversationMarker(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (isInsideNavChatPanel(element)) {
    return false;
  }

  if (element.matches(CONVERSATION_MUTATION_SELECTOR)) {
    return true;
  }
  if (element.closest(CONVERSATION_MUTATION_SELECTOR)) {
    return true;
  }
  if (element.childElementCount > 0 && element.querySelector(CONVERSATION_MUTATION_SELECTOR)) {
    return true;
  }
  return false;
}

function shouldRefreshByMutations(mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    return false;
  }

  for (const mutation of mutations) {
    if (!mutation) {
      continue;
    }

    const targetElement = toElement(mutation.target);
    if (hasConversationMarker(targetElement)) {
      return true;
    }

    if (mutation.type !== "childList") {
      continue;
    }

    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    for (const node of changedNodes) {
      if (hasConversationMarker(toElement(node))) {
        return true;
      }
    }
  }

  return false;
}

function areSectionListsEquivalent(prevSections, nextSections) {
  const prev = Array.isArray(prevSections) ? prevSections : [];
  const next = Array.isArray(nextSections) ? nextSections : [];
  if (prev.length !== next.length) {
    return false;
  }

  for (let i = 0; i < prev.length; i += 1) {
    const left = prev[i];
    const right = next[i];
    // 仅比较当前渲染与滚动链路实际消费的字段，避免无效字段导致重复重渲染。
    if (
      left?.id !== right?.id
      || left?.title !== right?.title
      || left?.level !== right?.level
      || left?.index !== right?.index
      || left?.groupId !== right?.groupId
      || left?.itemType !== right?.itemType
      || left?.element !== right?.element
    ) {
      return false;
    }
  }

  return true;
}

function areSectionGroupListsEquivalent(prevGroups, nextGroups) {
  const prev = Array.isArray(prevGroups) ? prevGroups : [];
  const next = Array.isArray(nextGroups) ? nextGroups : [];
  if (prev.length !== next.length) {
    return false;
  }

  for (let i = 0; i < prev.length; i += 1) {
    const left = prev[i];
    const right = next[i];
    if (
      left?.id !== right?.id
      || left?.title !== right?.title
      || left?.level !== right?.level
      || left?.index !== right?.index
      || left?.element !== right?.element
      || areSectionListsEquivalent(left?.children, right?.children) === false
    ) {
      return false;
    }
  }

  return true;
}

function areRoundListsEquivalent(prevRounds, nextRounds) {
  const prev = Array.isArray(prevRounds) ? prevRounds : [];
  const next = Array.isArray(nextRounds) ? nextRounds : [];
  if (prev.length !== next.length) {
    return false;
  }

  for (let i = 0; i < prev.length; i += 1) {
    const left = prev[i];
    const right = next[i];
    const leftAssistantEls = left?.assistantMessageEls || [];
    const rightAssistantEls = right?.assistantMessageEls || [];
    const sameAssistantAnchors = leftAssistantEls.length === rightAssistantEls.length
      && leftAssistantEls.every((el, idx) => el === rightAssistantEls[idx]);

    if (
      left?.id !== right?.id
      || left?.index !== right?.index
      || left?.title !== right?.title
      || left?.status !== right?.status
      || left?.assistantPreview !== right?.assistantPreview
      || left?.hasImageReply !== right?.hasImageReply
      || left?.hasSections !== right?.hasSections
      || left?.userAnchorEl !== right?.userAnchorEl
      || left?.sectionSourceEl !== right?.sectionSourceEl
      || areSectionGroupListsEquivalent(left?.sectionGroups, right?.sectionGroups) === false
      || sameAssistantAnchors === false
      || areSectionListsEquivalent(left?.sections, right?.sections) === false
    ) {
      return false;
    }
  }

  return true;
}

async function bootstrap() {
  const logger = createLogger("main");

  // 单实例保护：若页面上已有旧实例，先销毁，避免出现“收起后还有一层面板”。
  const previousInstance = window[RUNTIME_INSTANCE_KEY];
  if (previousInstance && typeof previousInstance.destroy === "function") {
    try {
      previousInstance.destroy("re-bootstrap");
    } catch (error) {
      logger.warn("销毁旧实例失败，已继续执行。", error);
    }
  }

  // 兜底清理遗留节点：某些热更新场景可能残留旧 DOM（文档对象模型）根节点。
  document.querySelectorAll("#ccn-root").forEach((node) => node.remove());

  const runtime = {
    destroyed: false,
    destroy: () => {}
  };
  window[RUNTIME_INSTANCE_KEY] = runtime;

  logger.info("扩展启动。", {
    build: "section-nav-v1.5-adapter-core",
    href: location.href,
    userAgent: navigator.userAgent
  });

  const registry = new AdapterRegistry({ logger: createLogger("adapter-registry") });
  registry.register(new ChatGPTAdapter(createLogger("chatgpt-adapter")));

  const adapter = registry.resolve({
    location,
    document
  });

  if (!adapter) {
    logger.info("当前页面未匹配可用平台 adapter，已退出。", {
      hostname: location.hostname,
      pathname: location.pathname
    });
    if (window[RUNTIME_INSTANCE_KEY] === runtime) {
      delete window[RUNTIME_INSTANCE_KEY];
    }
    return;
  }

  const container = await adapter.waitForReady({ document, logger });
  if (!container) {
    logger.warn("未检测到有效对话容器，不挂载导航面板。", {
      platform: adapter.platform
    });
    if (window[RUNTIME_INSTANCE_KEY] === runtime) {
      delete window[RUNTIME_INSTANCE_KEY];
    }
    return;
  }

  // 若等待期间已有更新实例接管，本实例直接退出，避免重复挂载。
  if (window[RUNTIME_INSTANCE_KEY] !== runtime) {
    logger.warn("检测到更新实例已接管，当前实例退出。");
    return;
  }

  const roundIdManager = new RoundIdManager();
  let latestRounds = [];
  let latestRoundMap = new Map();
  let activeRoundBeforeSectionView = null;
  const sectionRetryMemo = new Map();
  const SECTION_RETRY_COOLDOWN_MS = 2500;

  const requestSectionRetryIfNeeded = (roundId) => {
    if (!roundId) {
      return;
    }

    const round = latestRoundMap.get(roundId);
    if (!round || round.hasSections === true) {
      return;
    }

    const now = Date.now();
    const lastRetryAt = sectionRetryMemo.get(roundId) || 0;
    if (now - lastRetryAt < SECTION_RETRY_COOLDOWN_MS) {
      return;
    }

    sectionRetryMemo.set(roundId, now);
    debouncedRefresh();
  };

  // 打开二级章节视图：先记录当前轮次高亮，再切换到章节模式。
  const openSectionViewByRound = (roundId) => {
    const sectionState = panelView.getSectionViewState();
    if (sectionState.roundId === roundId) {
      panelView.backToRoundView({ roundId: activeRoundBeforeSectionView });
      scrollManager.clearSections();
      scrollManager.setViewMode("rounds");
      scrollManager.detectActiveRound("section-collapse");
      activeRoundBeforeSectionView = null;
      return;
    }

    const latestRound = latestRoundMap.get(roundId);
    if (!latestRound || latestRound.hasSections !== true || !Array.isArray(latestRound.sections)) {
      return;
    }

    activeRoundBeforeSectionView = panelView.getActiveRoundId();
    panelView.openSectionView(latestRound);
    scrollManager.setSections(latestRound.id, latestRound.sections);
    scrollManager.setViewMode("sections");
    scrollManager.detectActiveSection("open-sections");
  };

  const panelView = new PanelView({
    logger: createLogger("panel-view"),
    onRoundClick: (roundId) => {
      scrollManager.scrollToRound(roundId);
      // 点击轮次后按需重解析（带冷却），避免每次点击都触发全量解析。
      requestSectionRetryIfNeeded(roundId);
    },
    onRoundSectionClick: (roundId) => {
      openSectionViewByRound(roundId);
    },
    onSectionClick: (sectionId) => {
      scrollManager.scrollToSection(sectionId);
    },
    onToggleCollapse: (collapsed) => {
      savePanelCollapsed(collapsed).catch((error) => {
        logger.warn("保存面板折叠状态失败，已忽略。", error);
      });
    }
  });

  const scrollManager = new ScrollManager({
    logger: createLogger("scroll-manager"),
    adapter,
    offsetPx: CONFIG.SCROLL_TOP_OFFSET_PX,
    onActiveRoundChange: (roundId) => {
      panelView.setActiveRound(roundId);
      // 兜底：某些页面在滚动到旧轮次时才把正文节点挂载到 DOM（文档对象模型）。
      // 若当前轮次还没有章节，触发一次防抖重解析，避免“可见但未识别”。
      requestSectionRetryIfNeeded(roundId);
    },
    onActiveSectionChange: (sectionId) => {
      panelView.setActiveSection(sectionId);
    }
  });

  panelView.mount();

  const collapsed = await loadPanelCollapsed();
  panelView.setCollapsed(collapsed, { skipPersist: true });

  const parserLogger = createLogger("conversation-parser");

  const parseAndRender = () => {
    const messages = collectUnifiedMessages(adapter, container, {
      logger: parserLogger,
      document
    });

    const rounds = buildConversationRounds(messages, {
      roundIdManager,
      logger: parserLogger
    });

    const roundsChanged = !areRoundListsEquivalent(latestRounds, rounds);
    if (!roundsChanged) {
      logger.debug("轮次数据未变化，跳过重渲染。", {
        platform: adapter.platform
      });
      scrollManager.detectByView("rounds-unchanged-skip-render");
      return;
    }

    latestRounds = rounds;
    latestRoundMap = new Map(rounds.map((round) => [round.id, round]));
    for (const roundId of sectionRetryMemo.keys()) {
      if (!latestRoundMap.has(roundId)) {
        sectionRetryMemo.delete(roundId);
      }
    }

    panelView.setRounds(rounds);
    scrollManager.setRounds(rounds);

    const sectionState = panelView.getSectionViewState();
    if (!sectionState.roundId) {
      scrollManager.clearSections();
      scrollManager.setViewMode("rounds");
      return;
    }

    const targetRound = latestRoundMap.get(sectionState.roundId);
    const isValidSectionRound = Boolean(
      targetRound
      && targetRound.hasSections === true
      && targetRound.sectionSourceEl instanceof HTMLElement
      && targetRound.sectionSourceEl.isConnected
    );

    if (!isValidSectionRound) {
      panelView.backToRoundView({ roundId: activeRoundBeforeSectionView });
      scrollManager.clearSections();
      scrollManager.setViewMode("rounds");
      scrollManager.detectActiveRound("section-invalid-round");
      activeRoundBeforeSectionView = null;
      return;
    }

    panelView.syncSectionViewRound(targetRound, {
      preferredSectionId: sectionState.activeSectionId
    });
    scrollManager.setSections(targetRound.id, targetRound.sections);
    scrollManager.setViewMode("sections");
    scrollManager.detectActiveSection("sections-refreshed");
  };

  const debouncedRefresh = debounce(() => {
    logger.debug("触发目录刷新（防抖后执行）。", { platform: adapter.platform });
    parseAndRender();
  }, CONFIG.REFRESH_DEBOUNCE_MS);

  parseAndRender();

  const disconnectContentObserver = adapter.observeChanges(
    container,
    (mutations) => {
      if (!shouldRefreshByMutations(mutations)) {
        return;
      }
      logger.debug("检测到页面内容变化。", {
        mutationCount: mutations.length,
        platform: adapter.platform
      });
      debouncedRefresh();
    },
    { document }
  );

  runtime.destroy = (reason = "manual") => {
    if (runtime.destroyed) {
      return;
    }
    runtime.destroyed = true;
    if (typeof disconnectContentObserver === "function") {
      disconnectContentObserver();
    }
    scrollManager.destroy();
    panelView.destroy();
    if (window[RUNTIME_INSTANCE_KEY] === runtime) {
      delete window[RUNTIME_INSTANCE_KEY];
    }
    logger.info("历史对话导航实例已销毁。", { reason, platform: adapter.platform });
  };

  logger.info("历史对话导航已完成初始化。", {
    refreshDebounceMs: CONFIG.REFRESH_DEBOUNCE_MS,
    platform: adapter.platform
  });
}

bootstrap().catch((error) => {
  const logger = createLogger("main");
  logger.error("扩展初始化失败。", error);
});
