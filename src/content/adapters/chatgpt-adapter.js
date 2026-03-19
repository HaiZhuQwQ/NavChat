/**
 * 本文件实现 ChatGPTAdapter（ChatGPT 平台适配器）。
 * 作用：封装 ChatGPT Web（网页端）页面结构差异，向 core（核心层）提供统一接口。
 */
import { CONFIG } from "../constants.js";
import { BaseAdapter } from "../core/base-adapter.js";

const SELECTOR_REGISTRY = {
  conversationContainer: {
    primary: [
      "main [data-testid='conversation-turns']",
      "main [data-testid='conversation-container']",
      "main"
    ],
    fallback: ["[role='main']", "body"]
  },
  messageRoots: {
    primary: [
      "[data-message-author-role]",
      "div[data-message-author-role]",
      "article[data-message-author-role]",
      "article[data-testid^='conversation-turn-'] [data-message-author-role]",
      "article[data-testid*='conversation-turn'] [data-message-author-role]",
      "[data-testid^='conversation-turn-']",
      "[data-testid*='conversation-turn']",
      "[data-testid='user-message']",
      "[data-testid='assistant-message']",
      "[data-testid='conversation-turn-content']",
      "[data-message-id]"
    ],
    fallback: [
      "article[data-testid^='conversation-turn-']",
      "[data-testid^='conversation-turn-']",
      "article[data-testid*='conversation-turn']",
      "main [data-testid*='message']",
      "[data-testid*='message']",
      "[data-message-id]",
      "main article",
      "[role='article']"
    ]
  },
  messageRootsDocumentFallback: {
    primary: [
      "main [data-testid^='conversation-turn-']",
      "main [data-testid*='conversation-turn']",
      "main [data-message-author-role]",
      "main [data-testid='conversation-turn-content']",
      "main [data-message-id]"
    ],
    fallback: [
      "[data-testid^='conversation-turn-']",
      "[data-testid*='conversation-turn']",
      "[data-message-author-role]",
      "[data-testid='conversation-turn-content']",
      "[data-message-id]",
      "article"
    ]
  },
  messageRoleHints: {
    primary: ["[data-message-author-role]", "[aria-label]", "[data-testid]"],
    fallback: ["article", "div"]
  },
  messageTextRoots: {
    primary: [
      "[data-message-author-role] [dir='auto']",
      "[dir='auto']",
      "[data-testid='conversation-turn-content']"
    ],
    fallback: [".markdown", "p", "div"]
  },
  assistantErrorHints: {
    primary: ["[data-testid='error-message']", "[role='alert']"],
    fallback: [".text-red-500", ".text-danger"]
  },
  assistantStreamingHints: {
    // 仅保留“强信号”按钮，避免 aria-live（实时播报区域）造成误判。
    primary: ["[data-testid='stop-button']"],
    fallback: ["button[aria-label*='Stop']", "button[aria-label*='停止']"]
  }
};

const LOW_CONFIDENCE_SELECTORS = new Set([
  "main article",
  "[role='article']",
  ".markdown",
  ".text-red-500",
  ".text-danger"
]);

const ROLE_KEYWORDS = {
  user: ["user", "you", "你"],
  assistant: ["assistant", "chatgpt", "助手"]
};

function uniqueElements(elements) {
  return Array.from(new Set(elements));
}

function sortByDomOrder(elements) {
  return [...elements].sort((a, b) => {
    if (a === b) {
      return 0;
    }
    const relation = a.compareDocumentPosition(b);
    return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
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

function isScrollableElement(element) {
  if (!element || !(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const overflowY = style.overflowY;
  const canScrollY = /(auto|scroll|overlay)/.test(overflowY);
  const hasScrollableContent = element.scrollHeight > element.clientHeight + 2;
  return canScrollY && hasScrollableContent;
}

function findNearestScrollContainer(anchor) {
  let current = anchor?.parentElement || null;
  while (current && current !== document.body && current !== document.documentElement) {
    if (isScrollableElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function hasLikelyImageNode(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  return Boolean(
    element.querySelector(
      "img, picture, canvas, svg image, figure img, video, [role='img'], [aria-label*='image'], [aria-label*='图片'], [data-testid*='image'], [data-testid*='dalle']"
    )
  );
}

function textScore(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return -1;
  }

  const charLength = Array.from(normalized).length;
  const chineseCount = (normalized.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latinWordCount = (normalized.match(/[A-Za-z]{2,}/g) || []).length;
  const punctuationCount = (normalized.match(/[，。！？,.!?：:；;]/g) || []).length;

  // 低信息短句（例如“好”“可以”“A”）在标题提取阶段价值低，降低分数避免被误选为主文本。
  const lowInfo = /^(?:[A-Za-z]|好|好的|可以|当然可以|收到|嗯|ok|okay|yes|no)$/i.test(normalized);
  const lowInfoPenalty = lowInfo ? 20 : 0;

  return charLength + chineseCount * 2 + latinWordCount * 2 + punctuationCount - lowInfoPenalty;
}

export class ChatGPTAdapter extends BaseAdapter {
  constructor(logger) {
    super("chatgpt");
    this.logger = logger || console;
    this.selectorLogMemo = new Set();
    this.emptyHintLogged = false;
    this.emptyMessageScanCount = 0;
    // 文本提取缓存：避免同一消息节点在多次刷新中重复执行昂贵的 clone/query。
    this.messageTextCache = new WeakMap();
  }

  detect(context = {}) {
    const locationObj = context.location || globalThis.location;
    if (!locationObj) {
      return false;
    }

    return isSupportedHost(locationObj.hostname) && isEligiblePath(locationObj.pathname);
  }

  async waitForReady(context = {}) {
    const doc = context.document || document;
    const logger = context.logger || this.logger;
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
          logger?.info("主对话容器就绪。", {
            reason,
            costMs: Date.now() - startAt
          });
        } else {
          logger?.warn("等待主对话容器超时。", {
            reason,
            costMs: Date.now() - startAt
          });
        }

        resolve(container || null);
      };

      const checkNow = (reason) => {
        const container = this.getConversationRoot({ document: doc, silent: true });
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

      if (doc.body) {
        observer.observe(doc.body, {
          childList: true,
          subtree: true
        });
      }

      timeoutTimer = setTimeout(() => {
        finish(null, "timeout");
      }, CONFIG.WAIT_CONTAINER_TIMEOUT_MS);
    });
  }

  getConversationRoot(context = {}) {
    const root = context.document || document;
    return this.findConversationContainer(root, { silent: context.silent === true });
  }

  getMessageElements(root, _context = {}) {
    if (!(root instanceof HTMLElement)) {
      return [];
    }
    return this.getOrderedMessageElements(root);
  }

  parseMessage(element, context = {}) {
    const role = this.detectMessageRole(element);
    const text = this.extractMessageText(element);
    const state = role === "assistant"
      ? this.detectStreamingState(element, {
        isTailMessage: context.isTailMessage === true,
        messageText: text
      })
      : {
        isStreaming: false,
        isError: false,
        isEmpty: normalizeText(text).length === 0
      };

    return {
      id: this._resolveMessageId(element, context.index),
      role,
      text,
      html: element instanceof HTMLElement ? element.innerHTML || "" : "",
      element,
      index: Number.isFinite(context.index) ? context.index : -1,
      platform: this.platform,
      state,
      meta: {
        timestamp: this._extractTimestamp(element),
        attachments: this._extractAttachments(element),
        sourceType: "dom"
      }
    };
  }

  getScrollContainer(anchor, _context = {}) {
    if (!(anchor instanceof HTMLElement) || !anchor.isConnected) {
      return null;
    }
    return findNearestScrollContainer(anchor);
  }

  scrollToMessage(anchor, context = {}) {
    if (!(anchor instanceof HTMLElement) || !anchor.isConnected) {
      return 0;
    }

    const offsetPx = Number.isFinite(context.offsetPx) ? context.offsetPx : CONFIG.SCROLL_TOP_OFFSET_PX;
    const container = context.container || this.getScrollContainer(anchor);

    if (container) {
      const containerRect = container.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const targetTop = container.scrollTop + (anchorRect.top - containerRect.top) - offsetPx;
      const normalizedTop = Math.max(0, targetTop);
      container.scrollTo({
        top: normalizedTop,
        behavior: "smooth"
      });
      return normalizedTop;
    }

    const rect = anchor.getBoundingClientRect();
    const targetTop = window.scrollY + rect.top - offsetPx;
    const normalizedTop = Math.max(0, targetTop);
    window.scrollTo({
      top: normalizedTop,
      behavior: "smooth"
    });
    return normalizedTop;
  }

  observeChanges(root, onChange, context = {}) {
    const target = root instanceof HTMLElement ? root : (context.document || document).body;
    if (!target || typeof onChange !== "function") {
      return () => {};
    }

    const observer = new MutationObserver((mutations) => {
      onChange(mutations);
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });

    return () => {
      observer.disconnect();
    };
  }

  detectStreamingState(element, context = {}) {
    const normalized = normalizeText(context.messageText || this.extractMessageText(element));
    const hasText = normalized.length > 0;

    const hasErrorHint = this._hasAnySelector(element, "assistantErrorHints");
    const looksLikeError = /(something went wrong|出错|错误|failed|network error)/i.test(normalized);

    let isStreaming = this._hasAnySelector(element, "assistantStreamingHints");
    if (isStreaming === false && context.isTailMessage) {
      // 兜底：仅当全局“停止生成”按钮可见且可交互时，才判定仍在流式输出。
      isStreaming = this._hasVisibleGlobalStopButton(context.document || document);
    }

    return {
      isStreaming,
      isError: hasErrorHint || looksLikeError,
      isEmpty: hasText === false
    };
  }

  findConversationContainer(root = document, options = {}) {
    const result = this.selectFirstWithFallback(root, "conversationContainer", options);
    if (!result.element) {
      if (options.silent !== true) {
        this.logger.warn("未找到主对话容器：所有主/备选择器都匹配失败。");
      }
      return null;
    }
    return result.element;
  }

  getOrderedMessageElements(container) {
    const result = this.selectAllWithFallback(container, "messageRoots", {
      silent: true,
      mapElement: (el) => this.normalizeMessageElement(el),
      filterElement: (el) => Boolean(el)
    });

    let ordered = sortByDomOrder(uniqueElements(result.elements));
    if (ordered.length === 0) {
      const globalFallback = this.selectAllWithFallback(document, "messageRootsDocumentFallback", {
        silent: true,
        mapElement: (el) => this.normalizeMessageElement(el),
        filterElement: (el) => Boolean(el)
      });
      ordered = sortByDomOrder(uniqueElements(globalFallback.elements));
    }

    if (ordered.length === 0) {
      const heuristic = this._collectHeuristicMessageElements(container);
      ordered = sortByDomOrder(uniqueElements(heuristic));
    }

    if (ordered.length === 0) {
      this.emptyMessageScanCount += 1;
      const containerTextLength = normalizeText(container?.textContent || "").length;
      // 页面初始阶段常出现短暂空扫描，延后告警以减少误报噪音。
      const shouldWarn = this.emptyMessageScanCount >= 8 && containerTextLength > 20;

      if (shouldWarn) {
        this.logger.warn("主对话容器已找到，但消息节点匹配为空。", {
          containerTag: container?.tagName,
          emptyScanCount: this.emptyMessageScanCount,
          containerTextLength
        });
        this._logContainerHints(container);
      }
    } else {
      this.emptyMessageScanCount = 0;
      this.emptyHintLogged = false;
    }

    return ordered;
  }

  normalizeMessageElement(element) {
    if (!element) {
      return null;
    }

    const byMessageId = element.closest("[data-message-id]");
    if (byMessageId) {
      return byMessageId;
    }

    const byTurnData = element.closest("[data-testid^='conversation-turn-'], [data-testid*='conversation-turn']");
    if (byTurnData) {
      return byTurnData;
    }

    const byTurnArticle = element.closest("article[data-testid^='conversation-turn-']");
    if (byTurnArticle) {
      return byTurnArticle;
    }

    const byRole = element.closest("[data-message-author-role]");
    if (byRole) {
      return byRole;
    }

    return element;
  }

  detectMessageRole(element) {
    if (!element) {
      return "unknown";
    }

    const directRole = normalizeText(element.getAttribute("data-message-author-role")).toLowerCase();
    if (directRole === "user" || directRole === "assistant") {
      return directRole;
    }

    const selfTestId = normalizeText(element.getAttribute("data-testid")).toLowerCase();
    if (selfTestId.includes("user-message") || selfTestId.includes("conversation-turn-user")) {
      return "user";
    }
    if (selfTestId.includes("assistant-message") || selfTestId.includes("conversation-turn-assistant")) {
      return "assistant";
    }

    // 兜底：很多页面改版会把 role 放在外层 turn（轮次）容器上。
    const turnHintNode = element.closest("[data-testid*='conversation-turn-user'], [data-testid*='conversation-turn-assistant']");
    if (turnHintNode instanceof HTMLElement) {
      const turnTestId = normalizeText(turnHintNode.getAttribute("data-testid")).toLowerCase();
      if (turnTestId.includes("conversation-turn-user")) {
        return "user";
      }
      if (turnTestId.includes("conversation-turn-assistant")) {
        return "assistant";
      }
    }

    const hintNodes = this._queryHints(element, "messageRoleHints");
    for (const node of hintNodes) {
      const dataRole = normalizeText(node.getAttribute("data-message-author-role")).toLowerCase();
      if (dataRole === "user" || dataRole === "assistant") {
        return dataRole;
      }

      const ariaLabel = normalizeText(node.getAttribute("aria-label")).toLowerCase();
      const dataTestId = normalizeText(node.getAttribute("data-testid")).toLowerCase();
      const allHints = `${ariaLabel} ${dataTestId}`;

      if (this._containsKeyword(allHints, ROLE_KEYWORDS.user)) {
        return "user";
      }
      if (this._containsKeyword(allHints, ROLE_KEYWORDS.assistant)) {
        return "assistant";
      }
    }

    // 最后兜底：若节点明显是图片回答容器，按 assistant 处理，避免“生成图片”预览丢失。
    if (hasLikelyImageNode(element)) {
      return "assistant";
    }

    // 若角色完全未知，返回 unknown，由解析器选择跳过该节点。
    return "unknown";
  }

  extractMessageText(element) {
    if (!element) {
      return "";
    }

    const cacheKey = this._buildMessageTextCacheKey(element);
    const cached = this.messageTextCache.get(element);
    if (cached && cached.key === cacheKey) {
      return cached.text;
    }

    const rootResult = this.selectAllWithFallback(element, "messageTextRoots", {
      silent: true,
      filterElement: (el) => Boolean(el)
    });

    const candidates = rootResult.elements.length > 0 ? rootResult.elements : [element];
    let bestText = "";
    let bestScore = -1;

    for (const node of candidates) {
      const text = this._extractCleanText(node);
      const score = textScore(text);
      if (score > bestScore || (score === bestScore && text.length > bestText.length)) {
        bestText = text;
        bestScore = score;
      }
    }

    // 兜底：若候选子节点文本过短，尝试整块节点文本，防止只抓到“单字/单词”。
    const rootText = this._extractCleanText(element);
    const rootScore = textScore(rootText);
    if (rootScore > bestScore || (rootScore === bestScore && rootText.length > bestText.length)) {
      bestText = rootText;
      bestScore = rootScore;
    }

    // 再兜底：拼接结构化文本段落，避免误选装饰节点导致信息过短。
    if (bestText.length < 8) {
      const structuredText = this._extractStructuredText(element);
      const structuredScore = textScore(structuredText);
      if (structuredScore > bestScore || (structuredScore === bestScore && structuredText.length > bestText.length)) {
        bestText = structuredText;
      }
    }

    const resolved = String(bestText || "");
    this.messageTextCache.set(element, {
      key: cacheKey,
      text: resolved
    });
    return resolved;
  }

  getAssistantState(element, messageText, context = {}) {
    return this.detectStreamingState(element, {
      ...context,
      messageText
    });
  }

  selectFirstWithFallback(root, key, options = {}) {
    const config = SELECTOR_REGISTRY[key];
    if (!config) {
      if (options.silent !== true) {
        this.logger.warn(`选择器键不存在：${key}`);
      }
      return { element: null, selector: null, tier: null };
    }

    for (const tier of ["primary", "fallback"]) {
      for (const selector of config[tier]) {
        try {
          const element = this._queryFirstWithShadow(root, selector);
          if (!element) {
            continue;
          }
          if (options.silent !== true) {
            this._logSelectorTier(key, selector, tier);
          }
          return { element, selector, tier };
        } catch (error) {
          if (options.silent !== true) {
            this.logger.warn(`选择器执行失败：${selector}`, error);
          }
        }
      }
    }

    if (options.silent !== true) {
      this.logger.warn(`选择器全部失效：${key}`);
    }
    return { element: null, selector: null, tier: null };
  }

  selectAllWithFallback(root, key, options = {}) {
    const config = SELECTOR_REGISTRY[key];
    if (!config) {
      if (options.silent !== true) {
        this.logger.warn(`选择器键不存在：${key}`);
      }
      return { elements: [], selector: null, tier: null };
    }

    const mapElement = options.mapElement || ((el) => el);
    const filterElement = options.filterElement || ((el) => Boolean(el));

    for (const tier of ["primary", "fallback"]) {
      for (const selector of config[tier]) {
        try {
          const raw = this._queryAllWithShadow(root, selector);
          const mapped = raw.map(mapElement).filter(filterElement);
          const elements = uniqueElements(mapped);

          if (elements.length === 0) {
            continue;
          }

          if (options.silent !== true) {
            this._logSelectorTier(key, selector, tier, elements.length);
          }
          return { elements, selector, tier };
        } catch (error) {
          if (options.silent !== true) {
            this.logger.warn(`选择器执行失败：${selector}`, error);
          }
        }
      }
    }

    if (options.silent !== true) {
      this.logger.warn(`选择器全部失效：${key}`);
    }
    return { elements: [], selector: null, tier: null };
  }

  _queryHints(element, key) {
    const result = this.selectAllWithFallback(element, key, { silent: true });
    return result.elements;
  }

  _extractCleanText(element) {
    try {
      const cloned = element.cloneNode(true);
      const removableSelectors = [
        "button",
        "nav",
        "svg",
        "style",
        "script",
        "textarea",
        "input",
        "select",
        "[aria-hidden='true']"
      ];
      for (const selector of removableSelectors) {
        cloned.querySelectorAll(selector).forEach((node) => node.remove());
      }

      const rawText = normalizeText(cloned.textContent || "");
      return rawText;
    } catch (_error) {
      return normalizeText(element.textContent || "");
    }
  }

  _extractStructuredText(element) {
    try {
      const blocks = Array.from(
        element.querySelectorAll("p, li, h1, h2, h3, h4, blockquote, pre, code, [dir='auto']")
      );
      const textParts = [];
      for (const block of blocks) {
        const text = this._extractCleanText(block);
        if (!text) {
          continue;
        }
        if (textParts[textParts.length - 1] === text) {
          continue;
        }
        textParts.push(text);
      }
      return normalizeText(textParts.join(" "));
    } catch (_error) {
      return "";
    }
  }

  _containsKeyword(source, keywords) {
    return keywords.some((word) => source.includes(word));
  }

  _collectHeuristicMessageElements(container) {
    if (!container) {
      return [];
    }

    const broadCandidates = this._queryAllWithShadow(
      container,
      "[data-message-author-role], [data-message-id], [data-testid*='conversation-turn'], [data-testid='conversation-turn-content'], [data-testid*='message']"
    );

    const normalized = broadCandidates
      .map((element) => this.normalizeMessageElement(element))
      .filter(Boolean);

    return uniqueElements(normalized);
  }

  _hasAnySelector(root, key) {
    const result = this.selectFirstWithFallback(root, key, { silent: true });
    return Boolean(result.element);
  }

  _hasVisibleGlobalStopButton(root) {
    const host = root || document;
    const selectors = [
      "[data-testid='stop-button']",
      "button[aria-label*='Stop']",
      "button[aria-label*='停止']"
    ];

    for (const selector of selectors) {
      const nodes = this._queryAllWithShadow(host, selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLButtonElement)) {
          continue;
        }

        if (!this._isVisible(node)) {
          continue;
        }

        if (node.disabled || node.getAttribute("aria-disabled") === "true") {
          continue;
        }

        return true;
      }
    }

    return false;
  }

  _isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (!element.isConnected) {
      return false;
    }

    if (element.closest("[hidden], [aria-hidden='true']")) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  _logSelectorTier(key, selector, tier, count) {
    const memoKey = `${key}|${selector}|${tier}`;
    if (this.selectorLogMemo.has(memoKey)) {
      return;
    }
    this.selectorLogMemo.add(memoKey);

    const lowConfidence = LOW_CONFIDENCE_SELECTORS.has(selector);
    const countText = typeof count === "number" ? `，命中数量：${count}` : "";

    if (tier === "fallback") {
      this.logger.warn(`主选择器失效，已降级到备用选择器：${key} -> ${selector}${countText}`);
      return;
    }

    if (lowConfidence) {
      this.logger.warn(`当前命中低置信度选择器：${key} -> ${selector}${countText}`);
      return;
    }

    this.logger.debug(`选择器命中：${key} -> ${selector}${countText}`);
  }

  _queryFirstWithShadow(root, selector) {
    if (!root || typeof root.querySelector !== "function") {
      return null;
    }
    const direct = root.querySelector(selector);
    if (direct) {
      return direct;
    }

    const shadowRoots = this._collectShadowRoots(root);
    for (const shadowRoot of shadowRoots) {
      const hit = shadowRoot.querySelector(selector);
      if (hit) {
        return hit;
      }
    }

    return null;
  }

  _queryAllWithShadow(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return [];
    }

    const direct = Array.from(root.querySelectorAll(selector));
    if (direct.length > 0) {
      return uniqueElements(direct);
    }

    const shadowRoots = this._collectShadowRoots(root);
    const collected = [...direct];
    for (const shadowRoot of shadowRoots) {
      collected.push(...shadowRoot.querySelectorAll(selector));
    }

    return uniqueElements(collected);
  }

  _collectShadowRoots(root) {
    const roots = [];
    const walkerRoot = root instanceof Document ? root.documentElement : root;
    if (!walkerRoot) {
      return roots;
    }

    const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
      }
      node = walker.nextNode();
    }

    return roots;
  }

  _logContainerHints(container) {
    if (this.emptyHintLogged) {
      return;
    }
    this.emptyHintLogged = true;

    try {
      const sampleNodes = Array.from(
        container.querySelectorAll("[data-testid], [data-message-author-role], [role], article")
      ).slice(0, 40);

      const summary = sampleNodes.map((node) => ({
        tag: node.tagName,
        dataTestId: node.getAttribute("data-testid") || "",
        role: node.getAttribute("role") || "",
        dataMessageRole: node.getAttribute("data-message-author-role") || "",
        dataMessageId: node.getAttribute("data-message-id") || ""
      }));

      this.logger.info("消息识别调试快照（前40个节点）。", summary);
    } catch (error) {
      this.logger.warn("输出消息识别调试快照失败。", error);
    }
  }

  _resolveMessageId(element, index = 0) {
    if (!(element instanceof HTMLElement)) {
      return `${this.platform}-msg-${index}`;
    }

    const directMessageId = normalizeText(element.getAttribute("data-message-id"));
    if (directMessageId) {
      return directMessageId;
    }

    const turnNode = element.closest("[data-testid^='conversation-turn-'], [data-testid*='conversation-turn']");
    const turnTestId = normalizeText(turnNode?.getAttribute("data-testid"));
    if (turnTestId) {
      return `${this.platform}-${turnTestId}`;
    }

    return `${this.platform}-msg-${index}`;
  }

  _extractTimestamp(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const timeNode = element.querySelector("time[datetime]") || element.closest("article")?.querySelector("time[datetime]");
    if (!(timeNode instanceof HTMLElement)) {
      return null;
    }

    const raw = normalizeText(timeNode.getAttribute("datetime"));
    if (!raw) {
      return null;
    }

    const timestamp = Date.parse(raw);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  _extractAttachments(element) {
    if (!(element instanceof HTMLElement)) {
      return [];
    }

    const result = [];
    const nodes = element.querySelectorAll(
      "img, video, audio, a[download], [data-testid*='attachment'], [data-testid*='image']"
    );

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      const tagName = node.tagName.toLowerCase();
      const src = node.getAttribute("src") || node.getAttribute("href") || "";
      result.push({
        type: tagName,
        src
      });
    }

    return result;
  }

  _buildMessageTextCacheKey(element) {
    if (!(element instanceof HTMLElement)) {
      return "invalid";
    }

    // 使用轻量快照做缓存键：避免每次都走深度 DOM（文档对象模型）清洗。
    // 说明：若文本长度相同但内容变化，首尾片段也能捕获大部分更新。
    const rawText = normalizeText(element.textContent || "");
    const head = rawText.slice(0, 24);
    const tail = rawText.slice(-24);
    const childCount = element.childElementCount;
    const messageId = normalizeText(element.getAttribute("data-message-id"));
    const testId = normalizeText(element.getAttribute("data-testid"));
    return `${rawText.length}|${head}|${tail}|${childCount}|${messageId}|${testId}`;
  }
}

export function getSelectorRegistrySnapshot() {
  return JSON.parse(JSON.stringify(SELECTOR_REGISTRY));
}
