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

function canSafelyFocusTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target === document.body || target === document.documentElement) {
    return false;
  }
  if (target.tagName === "MAIN") {
    return false;
  }
  return true;
}

export class ScrollManager {
  constructor(options) {
    this.logger = options.logger;
    this.onActiveRoundChange = options.onActiveRoundChange;

    this.offsetPx = options.offsetPx || CONFIG.SCROLL_TOP_OFFSET_PX;
    this.rounds = [];
    this.roundMap = new Map();
    this.activeRoundId = null;
    this.intersectionObserver = null;
    this.scrollContainer = null;
    this.scrollEventTarget = window;
    this.lastLoggedContainerKey = "";

    this.throttledDetect = throttle(() => {
      this.detectActiveRound("scroll");
    }, CONFIG.SCROLL_HIGHLIGHT_THROTTLE_MS);

    this.boundOnScroll = this.throttledDetect;
    this.boundOnResize = this.throttledDetect;
  }

  setRounds(rounds) {
    this.rounds = rounds.filter((round) => Boolean(round?.userAnchorEl));
    this.roundMap.clear();

    for (const round of this.rounds) {
      this.roundMap.set(round.id, round);
    }

    this.scrollContainer = this._resolveScrollContainer();
    this._resetObserver();
    this.detectActiveRound("rounds-updated");
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

  destroy() {
    this._disconnectObserver();
    this._unbindScrollListener();
    window.removeEventListener("resize", this.boundOnResize);
  }

  detectActiveRound(source) {
    if (this.rounds.length === 0) {
      return;
    }

    const marker = this._resolveViewportMarker();
    let nearestAbove = null;
    let nearestBelow = null;

    for (const round of this.rounds) {
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

  _resetObserver() {
    this._disconnectObserver();

    const root = this.scrollContainer || null;
    this.intersectionObserver = new IntersectionObserver(
      () => {
        this.detectActiveRound("intersection");
      },
      {
        root,
        rootMargin: `-${this.offsetPx}px 0px -55% 0px`,
        threshold: [0, 0.2, 0.5, 0.8]
      }
    );

    for (const round of this.rounds) {
      this.intersectionObserver.observe(round.userAnchorEl);
    }

    this._unbindScrollListener();
    this._bindScrollListener();
    window.removeEventListener("resize", this.boundOnResize);
    window.addEventListener("resize", this.boundOnResize);
  }

  _disconnectObserver() {
    if (!this.intersectionObserver) {
      return;
    }
    this.intersectionObserver.disconnect();
    this.intersectionObserver = null;
  }

  _resolveScrollContainer() {
    const firstRound = this.rounds[0];
    if (!firstRound?.userAnchorEl) {
      return null;
    }
    const container = findNearestScrollContainer(firstRound.userAnchorEl);
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

    // 只把焦点交给“真实滚动容器”，避免触发页面的“跳至内容”可访问按钮。
    const focusTarget = this.scrollContainer;
    if (canSafelyFocusTarget(focusTarget) === false) {
      return;
    }

    let addedTabIndex = false;
    if (focusTarget.hasAttribute("tabindex") === false) {
      focusTarget.setAttribute("tabindex", "-1");
      addedTabIndex = true;
    }

    try {
      focusTarget.focus({ preventScroll: true });
    } catch (_error) {
      // 某些节点不可聚焦，忽略即可。
    }

    if (addedTabIndex) {
      setTimeout(() => {
        focusTarget.removeAttribute("tabindex");
      }, 800);
    }

    // 给滚轮事件窗口一个短暂缓冲，然后自动失焦，减少键盘焦点副作用。
    setTimeout(() => {
      if (document.activeElement === focusTarget) {
        focusTarget.blur();
      }
    }, 280);
  }
}
