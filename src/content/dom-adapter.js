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
    primary: ["[data-testid='stop-button']", "[aria-live='polite']"],
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

export class DomAdapter {
  constructor(logger) {
    this.logger = logger;
    this.selectorLogMemo = new Set();
    this.emptyHintLogged = false;
    this.emptyMessageScanCount = 0;
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

    return bestText;
  }

  getAssistantState(element, messageText, context = {}) {
    const normalized = normalizeText(messageText);
    const hasText = normalized.length > 0;

    const hasErrorHint = this._hasAnySelector(element, "assistantErrorHints");
    const looksLikeError = /(something went wrong|出错|错误|failed|network error)/i.test(normalized);

    let isStreaming = this._hasAnySelector(element, "assistantStreamingHints");
    if (isStreaming === false && context.isTailMessage) {
      // 兜底：最后一条消息若页面有“停止生成”按钮，通常代表仍在流式输出。
      isStreaming = this._hasAnySelector(document, "assistantStreamingHints");
    }

    return {
      isStreaming,
      isError: hasErrorHint || looksLikeError,
      isEmpty: hasText === false
    };
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
}

export function getSelectorRegistrySnapshot() {
  return JSON.parse(JSON.stringify(SELECTOR_REGISTRY));
}
