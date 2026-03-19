// 主入口：负责初始化、轮次解析刷新、面板与滚动管理器编排。
import { CONFIG } from "./constants.js";
import { createLogger } from "./logger.js";
import { DomAdapter } from "./dom-adapter.js";
import { RoundIdManager } from "./round-id.js";
import { buildConversationRounds } from "./conversation-parser.js";
import { PanelView } from "./panel-view.js";
import { ScrollManager } from "./scroll-manager.js";
import { loadPanelCollapsed, savePanelCollapsed } from "./state-store.js";

const RUNTIME_INSTANCE_KEY = "__CCN_RUNTIME_INSTANCE__";

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function isSupportedHost(hostname) {
  return hostname === "chatgpt.com" || hostname === "chat.openai.com";
}

function isEligiblePath(pathname) {
  if (pathname === "/") {
    return true;
  }
  return ["/c/", "/g/", "/share/"].some((prefix) => pathname.startsWith(prefix));
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
    if (
      left?.id !== right?.id
      || left?.title !== right?.title
      || left?.level !== right?.level
      || left?.index !== right?.index
      || left?.groupId !== right?.groupId
      || left?.itemType !== right?.itemType
      || left?.sourceType !== right?.sourceType
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
      || left?.sourceType !== right?.sourceType
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

async function waitForConversationContainer(adapter, logger) {
  const startAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let observer = null;

    const finish = (container, reason) => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (observer) {
        observer.disconnect();
      }

      if (container) {
        logger.info("主对话容器就绪。", {
          reason,
          costMs: Date.now() - startAt
        });
      } else {
        logger.warn("等待主对话容器超时。", {
          reason,
          costMs: Date.now() - startAt
        });
      }

      resolve(container || null);
    };

    const checkNow = (reason) => {
      const container = adapter.findConversationContainer(document, { silent: true });
      if (container) {
        finish(container, reason);
      }
    };

    checkNow("initial-check");

    pollTimer = setInterval(() => {
      checkNow("polling");
    }, CONFIG.WAIT_POLL_INTERVAL_MS);

    observer = new MutationObserver(() => {
      checkNow("mutation-observer");
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    timeoutTimer = setTimeout(() => {
      finish(null, "timeout");
    }, CONFIG.WAIT_CONTAINER_TIMEOUT_MS);
  });
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
    build: "section-nav-v1.4-panel-inline",
    href: location.href,
    userAgent: navigator.userAgent
  });

  if (!isSupportedHost(location.hostname)) {
    logger.info("当前域名不在支持范围内，已退出。", { hostname: location.hostname });
    if (window[RUNTIME_INSTANCE_KEY] === runtime) {
      delete window[RUNTIME_INSTANCE_KEY];
    }
    return;
  }

  if (!isEligiblePath(location.pathname)) {
    logger.info("当前页面不是有效对话页，已退出。", {
      pathname: location.pathname
    });
    if (window[RUNTIME_INSTANCE_KEY] === runtime) {
      delete window[RUNTIME_INSTANCE_KEY];
    }
    return;
  }

  const adapter = new DomAdapter(createLogger("dom-adapter"));
  const container = await waitForConversationContainer(adapter, logger);
  if (!container) {
    logger.warn("未检测到有效对话容器，不挂载导航面板。");
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
    offsetPx: CONFIG.SCROLL_TOP_OFFSET_PX,
    onActiveRoundChange: (roundId) => {
      panelView.setActiveRound(roundId);
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
    const messageElements = adapter.getOrderedMessageElements(container);
    const rounds = buildConversationRounds(messageElements, {
      adapter,
      roundIdManager,
      logger: parserLogger
    });

    const roundsChanged = !areRoundListsEquivalent(latestRounds, rounds);
    if (!roundsChanged) {
      logger.debug("轮次数据未变化，跳过重渲染。");
      scrollManager.detectByView("rounds-unchanged-skip-render");
      return;
    }

    latestRounds = rounds;
    latestRoundMap = new Map(rounds.map((round) => [round.id, round]));

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
      targetRound &&
      targetRound.hasSections === true &&
      targetRound.sectionSourceEl instanceof HTMLElement &&
      targetRound.sectionSourceEl.isConnected
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
    logger.debug("触发目录刷新（防抖后执行）。");
    parseAndRender();
  }, CONFIG.REFRESH_DEBOUNCE_MS);

  parseAndRender();

  const contentObserver = new MutationObserver((mutations) => {
    logger.debug("检测到页面内容变化。", { mutationCount: mutations.length });
    debouncedRefresh();
  });

  contentObserver.observe(container, {
    childList: true,
    subtree: true,
    characterData: true
  });

  runtime.destroy = (reason = "manual") => {
    if (runtime.destroyed) {
      return;
    }
    runtime.destroyed = true;
    contentObserver.disconnect();
    scrollManager.destroy();
    panelView.destroy();
    if (window[RUNTIME_INSTANCE_KEY] === runtime) {
      delete window[RUNTIME_INSTANCE_KEY];
    }
    logger.info("历史对话导航实例已销毁。", { reason });
  };

  logger.info("历史对话导航已完成初始化。", {
    refreshDebounceMs: CONFIG.REFRESH_DEBOUNCE_MS
  });
}

bootstrap().catch((error) => {
  const logger = createLogger("main");
  logger.error("扩展初始化失败。", error);
});
