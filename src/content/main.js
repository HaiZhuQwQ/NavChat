import { CONFIG } from "./constants.js";
import { createLogger } from "./logger.js";
import { DomAdapter } from "./dom-adapter.js";
import { RoundIdManager } from "./round-id.js";
import { buildConversationRounds } from "./conversation-parser.js";
import { PanelView } from "./panel-view.js";
import { ScrollManager } from "./scroll-manager.js";
import { loadPanelCollapsed, savePanelCollapsed } from "./state-store.js";

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
  logger.info("扩展启动。", {
    href: location.href,
    userAgent: navigator.userAgent
  });

  if (!isSupportedHost(location.hostname)) {
    logger.info("当前域名不在支持范围内，已退出。", { hostname: location.hostname });
    return;
  }

  if (!isEligiblePath(location.pathname)) {
    logger.info("当前页面不是有效对话页，已退出。", {
      pathname: location.pathname
    });
    return;
  }

  const adapter = new DomAdapter(createLogger("dom-adapter"));
  const container = await waitForConversationContainer(adapter, logger);
  if (!container) {
    logger.warn("未检测到有效对话容器，不挂载导航面板。");
    return;
  }

  const roundIdManager = new RoundIdManager();
  const panelView = new PanelView({
    logger: createLogger("panel-view"),
    onRoundClick: (roundId) => {
      scrollManager.scrollToRound(roundId);
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

    panelView.setRounds(rounds);
    scrollManager.setRounds(rounds);
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

  logger.info("历史对话导航已完成初始化。", {
    refreshDebounceMs: CONFIG.REFRESH_DEBOUNCE_MS
  });
}

bootstrap().catch((error) => {
  const logger = createLogger("main");
  logger.error("扩展初始化失败。", error);
});
