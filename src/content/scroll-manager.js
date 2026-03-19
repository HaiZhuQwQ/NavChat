import { CONFIG } from "./constants.js";

function throttle(fn, delayMs) {
  let lastRun = 0;
  let timer = null;

  return (...args) => {
    const now = Date.now();
    const remain = delayMs - (now - lastRun);

    if (remain <= 0) {
      lastRun = now;
      fn(...args);
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(() => {
      lastRun = Date.now();
      fn(...args);
    }, remain);
  };
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

function isValidAnchor(element) {
  return element instanceof HTMLElement && element.isConnected;
}

/**
 * 滚动管理层：复用同一套平滑滚动与高亮检测，按视图模式切换“轮次”或“章节”。
 */
export class ScrollManager {
  constructor(options) {
    this.logger = options.logger;
    this.onActiveRoundChange = options.onActiveRoundChange;
    this.onActiveSectionChange = options.onActiveSectionChange;

    this.offsetPx = options.offsetPx || CONFIG.SCROLL_TOP_OFFSET_PX;
    this.viewMode = "rounds";

    this.rounds = [];
    this.roundMap = new Map();
    this.activeRoundId = null;
    this.roundAnchorSnapshot = [];

    this.sectionRoundId = null;
    this.sections = [];
    this.sectionMap = new Map();
    this.activeSectionId = null;
    this.sectionAnchorSnapshot = [];

    this.intersectionObserver = null;
    this.scrollContainer = null;
    this.scrollEventTarget = window;
    this.lastLoggedContainerKey = "";

    this.throttledDetect = throttle(() => {
      this.detectByView("scroll");
    }, CONFIG.SCROLL_HIGHLIGHT_THROTTLE_MS);

    this.boundOnScroll = this.throttledDetect;
    this.boundOnResize = this.throttledDetect;
  }

  setViewMode(mode) {
    const nextMode = mode === "sections" ? "sections" : "rounds";
    if (this.viewMode === nextMode) {
      return;
    }

    this.viewMode = nextMode;
    this.detectByView("view-mode");
  }

  setRounds(rounds) {
    this.rounds = rounds.filter((round) => Boolean(round?.userAnchorEl));
    this.roundMap.clear();

    for (const round of this.rounds) {
      this.roundMap.set(round.id, round);
    }

    const nextRoundAnchors = this.rounds
      .map((round) => round?.userAnchorEl)
      .filter((anchor) => isValidAnchor(anchor));
    const anchorsChanged = this._isAnchorSnapshotChanged(this.roundAnchorSnapshot, nextRoundAnchors);
    this.roundAnchorSnapshot = nextRoundAnchors;

    const nextContainer = this._resolveScrollContainer();
    const containerChanged = nextContainer !== this.scrollContainer;
    this.scrollContainer = nextContainer;

    if (!anchorsChanged && !containerChanged) {
      this.detectByView("rounds-updated-no-reset");
      return;
    }

    this._resetObserver();
    this.detectByView("rounds-updated");
  }

  setSections(roundId, sections) {
    this.sectionRoundId = roundId || null;
    this.sections = (Array.isArray(sections) ? sections : []).filter((section) => isValidAnchor(section?.element));
    this.sectionMap.clear();

    for (const section of this.sections) {
      this.sectionMap.set(section.id, section);
    }

    if (this.sections.length === 0) {
      this._setActiveSection(null, "sections-empty");
    }

    const nextSectionAnchors = this.sections
      .map((section) => section?.element)
      .filter((anchor) => isValidAnchor(anchor));
    const anchorsChanged = this._isAnchorSnapshotChanged(this.sectionAnchorSnapshot, nextSectionAnchors);
    this.sectionAnchorSnapshot = nextSectionAnchors;

    const nextContainer = this._resolveScrollContainer();
    const containerChanged = nextContainer !== this.scrollContainer;
    this.scrollContainer = nextContainer;

    if (!anchorsChanged && !containerChanged) {
      this.detectByView("sections-updated-no-reset");
      return;
    }

    this._resetObserver();
    this.detectByView("sections-updated");
  }

  clearSections() {
    this.sectionRoundId = null;
    this.sections = [];
    this.sectionMap.clear();
    this.sectionAnchorSnapshot = [];
    this._setActiveSection(null, "sections-cleared");

    this.scrollContainer = this._resolveScrollContainer();
    this._resetObserver();
  }

  scrollToRound(roundId) {
    const round = this.roundMap.get(roundId);
    if (!round || !round.userAnchorEl) {
      this.logger.warn("滚动定位失败：找不到对应轮次锚点。", { roundId });
      return;
    }

    const targetTop = this._scrollToAnchor(round.userAnchorEl);
    this._handoffFocusToConversation(round.userAnchorEl);

    this._setActiveRound(roundId, "manual-jump");
    setTimeout(() => this.detectActiveRound("jump-finish"), 420);

    this.logger.info("执行平滑滚动跳转。", { roundId, targetTop: Math.max(0, targetTop) });
  }

  scrollToSection(sectionId) {
    const section = this.sectionMap.get(sectionId);
    if (!section || !isValidAnchor(section.element)) {
      this.logger.warn("滚动定位失败：找不到对应章节锚点。", { sectionId });
      return;
    }

    const targetTop = this._scrollToAnchor(section.element);
    this._handoffFocusToConversation(section.element);

    this._setActiveSection(sectionId, "manual-jump");
    setTimeout(() => this.detectActiveSection("jump-finish"), 420);

    this.logger.info("执行章节平滑滚动跳转。", { sectionId, targetTop: Math.max(0, targetTop) });
  }

  destroy() {
    this._disconnectObserver();
    this._unbindScrollListener();
    window.removeEventListener("resize", this.boundOnResize);
  }

  detectByView(source) {
    if (this.viewMode === "sections") {
      this.detectActiveSection(source);
      return;
    }

    this.detectActiveRound(source);
  }

  detectActiveRound(source) {
    if (this.rounds.length === 0) {
      return;
    }

    const marker = this._resolveViewportMarker();
    let nearestAbove = null;
    let nearestBelow = null;

    for (const round of this.rounds) {
      if (!isValidAnchor(round.userAnchorEl)) {
        continue;
      }
      const top = round.userAnchorEl.getBoundingClientRect().top;
      if (top <= marker) {
        nearestAbove = round;
      } else if (!nearestBelow) {
        nearestBelow = round;
      }
    }

    const nextActive = nearestAbove || nearestBelow || this.rounds[0];
    if (!nextActive) {
      return;
    }

    this._setActiveRound(nextActive.id, source);
  }

  detectActiveSection(source) {
    if (this.sections.length === 0) {
      this._setActiveSection(null, source);
      return;
    }

    const marker = this._resolveViewportMarker();
    let nearestAbove = null;
    let nearestBelow = null;

    for (const section of this.sections) {
      if (!isValidAnchor(section.element)) {
        continue;
      }
      const top = section.element.getBoundingClientRect().top;
      if (top <= marker) {
        nearestAbove = section;
      } else if (!nearestBelow) {
        nearestBelow = section;
      }
    }

    const nextActive = nearestAbove || nearestBelow || this.sections[0];
    this._setActiveSection(nextActive?.id || null, source);
  }

  _setActiveRound(roundId, source) {
    if (this.activeRoundId === roundId) {
      return;
    }

    this.activeRoundId = roundId;
    if (typeof this.onActiveRoundChange === "function") {
      this.onActiveRoundChange(roundId, { source });
    }

    this.logger.debug("当前高亮轮次更新。", { roundId, source });
  }

  _setActiveSection(sectionId, source) {
    if (this.activeSectionId === sectionId) {
      return;
    }

    this.activeSectionId = sectionId || null;
    if (typeof this.onActiveSectionChange === "function") {
      this.onActiveSectionChange(this.activeSectionId, { source });
    }

    this.logger.debug("当前高亮章节更新。", { sectionId: this.activeSectionId, source });
  }

  _resetObserver() {
    this._disconnectObserver();

    const root = this.scrollContainer || null;
    this.intersectionObserver = new IntersectionObserver(
      () => {
        this.detectByView("intersection");
      },
      {
        root,
        rootMargin: `-${this.offsetPx}px 0px -55% 0px`,
        threshold: [0, 0.2, 0.5, 0.8]
      }
    );

    for (const anchor of this._collectObservedAnchors()) {
      this.intersectionObserver.observe(anchor);
    }

    this._unbindScrollListener();
    this._bindScrollListener();
    window.removeEventListener("resize", this.boundOnResize);
    window.addEventListener("resize", this.boundOnResize);
  }

  _collectObservedAnchors() {
    const anchors = [];

    for (const round of this.rounds) {
      if (isValidAnchor(round?.userAnchorEl)) {
        anchors.push(round.userAnchorEl);
      }
    }

    for (const section of this.sections) {
      if (isValidAnchor(section?.element)) {
        anchors.push(section.element);
      }
    }

    return Array.from(new Set(anchors));
  }

  _disconnectObserver() {
    if (!this.intersectionObserver) {
      return;
    }
    this.intersectionObserver.disconnect();
    this.intersectionObserver = null;
  }

  _isAnchorSnapshotChanged(prevList, nextList) {
    if (prevList.length !== nextList.length) {
      return true;
    }

    for (let i = 0; i < prevList.length; i += 1) {
      if (prevList[i] !== nextList[i]) {
        return true;
      }
    }

    return false;
  }

  _resolveScrollContainer() {
    const anchor = this._resolveContainerAnchor();
    if (!anchor) {
      return null;
    }

    const container = findNearestScrollContainer(anchor);
    if (container) {
      const key = `${container.tagName}|${container.className || ""}`;
      if (this.lastLoggedContainerKey !== key) {
        this.lastLoggedContainerKey = key;
        this.logger.info("检测到内部滚动容器。", {
          tag: container.tagName,
          className: container.className || ""
        });
      }
    } else if (this.lastLoggedContainerKey !== "window") {
      this.lastLoggedContainerKey = "window";
      this.logger.info("未检测到内部滚动容器，使用 window 滚动。");
    }

    return container;
  }

  _resolveContainerAnchor() {
    if (this.viewMode === "sections" && this.sections[0]?.element) {
      return this.sections[0].element;
    }

    if (this.rounds[0]?.userAnchorEl) {
      return this.rounds[0].userAnchorEl;
    }

    if (this.sections[0]?.element) {
      return this.sections[0].element;
    }

    return null;
  }

  _resolveViewportMarker() {
    if (this.scrollContainer) {
      const containerRect = this.scrollContainer.getBoundingClientRect();
      return containerRect.top + this.offsetPx + 24;
    }
    return this.offsetPx + 24;
  }

  _scrollToAnchor(anchor) {
    if (this.scrollContainer) {
      const containerRect = this.scrollContainer.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const targetTop = this.scrollContainer.scrollTop + (anchorRect.top - containerRect.top) - this.offsetPx;
      this.scrollContainer.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "smooth"
      });
      return Math.max(0, targetTop);
    }

    const rect = anchor.getBoundingClientRect();
    const targetTop = window.scrollY + rect.top - this.offsetPx;
    window.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth"
    });
    return Math.max(0, targetTop);
  }

  _bindScrollListener() {
    this.scrollEventTarget = this.scrollContainer || window;
    this.scrollEventTarget.addEventListener("scroll", this.boundOnScroll, { passive: true });
  }

  _unbindScrollListener() {
    if (!this.scrollEventTarget) {
      return;
    }
    this.scrollEventTarget.removeEventListener("scroll", this.boundOnScroll);
    this.scrollEventTarget = null;
  }

  _handoffFocusToConversation(anchor) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("#ccn-root")) {
      active.blur();
    }
    // 不再把焦点移交给页面容器，避免触发 ChatGPT 的“跳至内容”悬浮按钮。
    // 这里保留空实现，是为了与现有调用路径兼容。
  }
}
