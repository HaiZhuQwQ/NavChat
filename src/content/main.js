// 主入口：负责初始化、平台适配器选择、轮次解析刷新、面板与滚动管理器编排。
import { CONFIG } from "./constants.js";
import { createLogger } from "./logger.js";
import { RoundIdManager } from "./round-id.js";
import { buildConversationRounds } from "./core/conversation-parser.js";
import {
  collectUnifiedMessagesIncremental,
  createMessagePipelineState
} from "./core/message-pipeline.js";
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

function areUnifiedMessagesEquivalent(prevMessages, nextMessages) {
  const prev = Array.isArray(prevMessages) ? prevMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];
  if (prev.length !== next.length) {
    return false;
  }

  for (let i = 0; i < prev.length; i += 1) {
    const left = prev[i];
    const right = next[i];
    if (left === right) {
      continue;
    }

    if (
      left?.id !== right?.id
      || left?.role !== right?.role
      || left?.text !== right?.text
      || left?.html !== right?.html
      || left?.element !== right?.element
      || left?.index !== right?.index
      || left?.state?.isStreaming !== right?.state?.isStreaming
      || left?.state?.isError !== right?.state?.isError
      || left?.state?.isEmpty !== right?.state?.isEmpty
    ) {
      return false;
    }
  }

  return true;
}

function isConversationDetailPath(pathname) {
  if (typeof pathname !== "string") {
    return false;
  }
  return pathname.startsWith("/c/") || pathname.startsWith("/share/") || pathname.startsWith("/g/");
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

  const initialContainer = await adapter.waitForReady({ document, logger });
  if (!initialContainer) {
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
  let latestMessages = [];
  let latestRounds = [];
  let latestRoundMap = new Map();
  let activeRoundBeforeSectionView = null;
  const sectionRetryMemo = new Map();
  const SECTION_RETRY_COOLDOWN_MS = 2500;
  // 尾轮次兜底重试：覆盖“流式结束后未再触发有效 mutation（页面变更）”导致章节未更新的场景。
  const TAIL_SETTLE_RETRY_MAX = 8;
  const TAIL_SETTLE_RETRY_DELAY_MS = 650;
  const TAIL_STREAMING_POLL_DELAY_MS = 700;
  const EMPTY_ROUNDS_REFRESH_INTERVAL_MS = 1200;
  const ROUTE_CHECK_INTERVAL_MS = 360;
  let tailSettleRetryTimer = null;
  let tailSettleRetryRoundId = null;
  let tailSettleRetryCount = 0;
  let tailSettleRetryStatus = null;
  let debouncedRefresh = () => {};
  let lastSeenHref = location.href;

  const clearTailSettleRetry = () => {
    if (tailSettleRetryTimer) {
      clearTimeout(tailSettleRetryTimer);
      tailSettleRetryTimer = null;
    }
  };

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

  const scheduleTailSettleRetryIfNeeded = () => {
    clearTailSettleRetry();

    const tailRound = latestRounds[latestRounds.length - 1] || null;
    const shouldRetry = Boolean(
      tailRound
      && tailRound.hasSections !== true
      && Array.isArray(tailRound.assistantMessageEls)
      && tailRound.assistantMessageEls.length > 0
      && (tailRound.status === "streaming" || tailRound.status === "complete")
    );

    if (!shouldRetry) {
      tailSettleRetryRoundId = null;
      tailSettleRetryCount = 0;
      tailSettleRetryStatus = null;
      return;
    }

    if (tailSettleRetryRoundId !== tailRound.id) {
      tailSettleRetryRoundId = tailRound.id;
      tailSettleRetryCount = 0;
      tailSettleRetryStatus = tailRound.status;
    } else if (tailSettleRetryStatus !== tailRound.status) {
      // 状态切换（例如 streaming -> complete）后重置计数，避免在关键时刻用尽重试额度。
      tailSettleRetryCount = 0;
      tailSettleRetryStatus = tailRound.status;
    }

    // 流式阶段用低频轮询持续兜底，直到进入 complete 再走有限重试。
    if (tailRound.status === "streaming") {
      tailSettleRetryTimer = setTimeout(() => {
        tailSettleRetryTimer = null;
        if (runtime.destroyed) {
          return;
        }
        parseAndRender({ force: true });
      }, TAIL_STREAMING_POLL_DELAY_MS);
      return;
    }

    if (tailSettleRetryCount >= TAIL_SETTLE_RETRY_MAX) {
      return;
    }

    tailSettleRetryTimer = setTimeout(() => {
      tailSettleRetryTimer = null;
      tailSettleRetryCount += 1;
      if (runtime.destroyed) {
        return;
      }
      parseAndRender({ force: true });
    }, TAIL_SETTLE_RETRY_DELAY_MS);
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
  logger.info("已读取导航面板折叠状态。", { collapsed });
  // 开发/调试场景下扩展重载后优先保证面板可见，避免历史折叠状态让用户误以为未挂载。
  panelView.setCollapsed(false, { skipPersist: true });
  if (collapsed) {
    savePanelCollapsed(false).catch((error) => {
      logger.warn("重置面板折叠状态失败，已忽略。", error);
    });
  }

  const parserLogger = createLogger("conversation-parser");
  const messagePipelineState = createMessagePipelineState();
  let panelMissingLogged = false;

  const ensurePanelMounted = (source = "watchdog") => {
    if (panelView.isMounted()) {
      panelMissingLogged = false;
      return false;
    }

    if (!panelMissingLogged) {
      logger.info("导航面板节点丢失，尝试重新挂载。", { source });
      panelMissingLogged = true;
    }
    panelView.mount();
    panelView.setCollapsed(false, { skipPersist: true });
    panelView.setRounds(latestRounds);
    panelView.setActiveRound(panelView.getActiveRoundId());
    return true;
  };

  const parseAndRender = (options = {}) => {
    ensurePanelMounted("parse-and-render");

    const force = options.force === true;
    const conversationRoot = adapter.getConversationRoot({ document, silent: true }) || initialContainer;
    const messages = collectUnifiedMessagesIncremental(adapter, conversationRoot, {
      logger: parserLogger,
      document,
      state: messagePipelineState
    });

    // 消息层短路：当消息模型未变化时，直接跳过轮次构建与面板重渲染。
    if (!force && areUnifiedMessagesEquivalent(latestMessages, messages)) {
      logger.debug("消息数据未变化，跳过轮次构建。", {
        platform: adapter.platform
      });
      scheduleTailSettleRetryIfNeeded();
      scrollManager.detectByView("messages-unchanged-skip-build");
      return;
    }
    latestMessages = messages;

    const rounds = buildConversationRounds(messages, {
      roundIdManager,
      logger: parserLogger
    });

    const roundsChanged = !areRoundListsEquivalent(latestRounds, rounds);
    if (!force && !roundsChanged) {
      logger.debug("轮次数据未变化，跳过重渲染。", {
        platform: adapter.platform
      });
      scheduleTailSettleRetryIfNeeded();
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
    scheduleTailSettleRetryIfNeeded();

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

  debouncedRefresh = debounce(() => {
    logger.debug("触发目录刷新（防抖后执行）。", { platform: adapter.platform });
    parseAndRender();
  }, CONFIG.REFRESH_DEBOUNCE_MS);

  parseAndRender();

  const disconnectContentObserver = adapter.observeChanges(
    document.body || initialContainer,
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

  const resetRouteScopedState = () => {
    latestMessages = [];
    latestRounds = [];
    latestRoundMap = new Map();
    activeRoundBeforeSectionView = null;
    sectionRetryMemo.clear();
    tailSettleRetryRoundId = null;
    tailSettleRetryCount = 0;
    tailSettleRetryStatus = null;
    clearTailSettleRetry();
    messagePipelineState.previousElements = [];
    messagePipelineState.normalizedCache = new WeakMap();

    panelView.backToRoundView({ roundId: null });
    panelView.setRounds([]);
    scrollManager.clearSections();
    scrollManager.setViewMode("rounds");
    scrollManager.setRounds([]);
  };

  const scheduleRouteRefresh = () => {
    // 路由切换后分 3 次强制刷新，覆盖 ChatGPT SPA（单页应用）异步挂载阶段。
    const retryDelays = [80, 360, 980];
    for (const delay of retryDelays) {
      setTimeout(() => {
        if (runtime.destroyed) {
          return;
        }
        parseAndRender({ force: true });
      }, delay);
    }
  };

  const routeCheckTimer = setInterval(() => {
    if (runtime.destroyed) {
      return;
    }
    if (location.href === lastSeenHref) {
      return;
    }

    const previousHref = lastSeenHref;
    lastSeenHref = location.href;
    logger.info("检测到对话路由变化，刷新导航数据。", {
      from: previousHref,
      to: lastSeenHref
    });

    resetRouteScopedState();
    scheduleRouteRefresh();
  }, ROUTE_CHECK_INTERVAL_MS);

  // 兜底：从首页进入对话时，若初始轮次仍为空，定期触发轻量刷新直到识别出首批消息。
  const emptyRoundsRefreshTimer = setInterval(() => {
    if (runtime.destroyed) {
      return;
    }
    if (!isConversationDetailPath(location.pathname)) {
      return;
    }
    if (latestRounds.length > 0) {
      return;
    }
    debouncedRefresh();
  }, EMPTY_ROUNDS_REFRESH_INTERVAL_MS);

  const panelMountWatchdogTimer = setInterval(() => {
    if (runtime.destroyed) {
      return;
    }
    ensurePanelMounted("interval");
  }, 500);

  runtime.destroy = (reason = "manual") => {
    if (runtime.destroyed) {
      return;
    }
    runtime.destroyed = true;
    if (typeof disconnectContentObserver === "function") {
      disconnectContentObserver();
    }
    clearInterval(routeCheckTimer);
    clearInterval(emptyRoundsRefreshTimer);
    clearInterval(panelMountWatchdogTimer);
    clearTailSettleRetry();
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
