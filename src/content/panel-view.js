import {
  CONFIG,
  THEME_PRIMARY
} from "./constants.js";

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function normalizeSearchTerm(text) {
  return String(text || "").trim().toLowerCase();
}

function hexToRgbString(hexColor) {
  const raw = String(hexColor || "").trim().replace(/^#/, "");
  if (![3, 6].includes(raw.length)) {
    return "";
  }

  const fullHex = raw.length === 3 ? raw.split("").map((char) => `${char}${char}`).join("") : raw;
  const value = Number.parseInt(fullHex, 16);
  if (Number.isNaN(value)) {
    return "";
  }

  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `${r}, ${g}, ${b}`;
}

export class PanelView {
  constructor(options) {
    this.logger = options.logger;
    this.onRoundClick = options.onRoundClick;
    this.onToggleCollapse = options.onToggleCollapse;

    this.root = null;
    this.shell = null;
    this.collapseButton = null;
    this.expandButton = null;
    this.searchInput = null;
    this.listContainer = null;
    this.emptyState = null;

    this.allRounds = [];
    this.filteredRounds = [];
    this.activeRoundId = null;
    this.itemNodeMap = new Map();
    this.collapsed = false;

    this.suppressNextExpandClick = false;
    this.dragState = {
      pointerId: null,
      startY: 0,
      startTop: 0,
      isDragging: false
    };

    this.debouncedFilter = debounce(() => {
      this.applyFilter(this.searchInput?.value || "");
    }, CONFIG.SEARCH_DEBOUNCE_MS);

    this.boundHandleWindowResize = () => this.handleWindowResize();
    this.boundHandleExpandPointerMove = (event) => this.handleExpandPointerMove(event);
    this.boundHandleExpandPointerEnd = (event) => this.handleExpandPointerEnd(event);
  }

  mount() {
    if (this.root) {
      return;
    }

    // 保险清理：热更新或多次注入时，先移除残留根节点，避免出现双层面板。
    document.querySelectorAll("#ccn-root").forEach((node) => node.remove());

    this.root = document.createElement("aside");
    this.root.id = "ccn-root";
    this.root.innerHTML = `
      <div class="ccn-shell" aria-label="历史对话导航面板">
        <div class="ccn-search-wrap">
          <input type="search" class="ccn-search-input" placeholder="搜索问题关键词..." aria-label="搜索导航项" />
          <button
            type="button"
            class="ccn-toggle-btn is-icon"
            data-action="collapse"
            aria-label="收起历史对话导航"
            title="收起"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M5.5 3.5L10 8l-4.5 4.5" />
            </svg>
          </button>
        </div>
        <ul class="ccn-list" aria-live="polite"></ul>
        <div class="ccn-empty" hidden>没有匹配的对话，请换个关键词试试。</div>
      </div>
      <button type="button" class="ccn-expand-btn" aria-label="展开历史对话导航">历史</button>
    `;

    document.body.appendChild(this.root);

    this.shell = this.root.querySelector(".ccn-shell");
    this.collapseButton = this.root.querySelector("[data-action='collapse']");
    this.expandButton = this.root.querySelector(".ccn-expand-btn");
    this.searchInput = this.root.querySelector(".ccn-search-input");
    this.listContainer = this.root.querySelector(".ccn-list");
    this.emptyState = this.root.querySelector(".ccn-empty");

    this.applyThemeVariables();

    this.collapseButton.addEventListener("click", () => this.setCollapsed(true));
    this.expandButton.addEventListener("click", (event) => this.handleExpandClick(event));
    this.expandButton.addEventListener("pointerdown", (event) => this.handleExpandPointerDown(event));
    this.searchInput.addEventListener("input", () => this.debouncedFilter());
    window.addEventListener("resize", this.boundHandleWindowResize, { passive: true });

    this.logger.info("导航面板挂载完成。");
  }

  destroy() {
    if (!this.root) {
      return;
    }

    this.detachDragListeners();
    window.removeEventListener("resize", this.boundHandleWindowResize);
    this.root.remove();
    this.root = null;
    this.itemNodeMap.clear();
  }

  setCollapsed(collapsed, options = {}) {
    this.collapsed = Boolean(collapsed);
    if (!this.root) {
      return;
    }

    this.root.classList.toggle("is-collapsed", this.collapsed);

    if (this.collapsed) {
      this.setRootTop(this.clampRootTop(this.getCurrentRootTop()));
    }

    if (options.skipPersist !== true && typeof this.onToggleCollapse === "function") {
      this.onToggleCollapse(this.collapsed);
    }
  }

  setRounds(rounds) {
    this.allRounds = Array.isArray(rounds) ? rounds : [];
    this.applyFilter(this.searchInput?.value || "");
  }

  setActiveRound(roundId) {
    this.activeRoundId = roundId;

    for (const [id, node] of this.itemNodeMap.entries()) {
      node.classList.toggle("is-active", id === roundId);
    }

    this.ensureActiveVisible();
  }

  ensureActiveVisible() {
    if (!this.activeRoundId) {
      return;
    }

    const node = this.itemNodeMap.get(this.activeRoundId);
    if (!node || node.parentElement !== this.listContainer) {
      return;
    }

    node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  applyFilter(rawTerm) {
    const searchTerm = normalizeSearchTerm(rawTerm);

    if (!searchTerm) {
      this.filteredRounds = this.allRounds;
    } else {
      this.filteredRounds = this.allRounds.filter((round) => {
        // 搜索强制覆盖标题与 assistantPreview（助手预览），并保留原 searchText 兼容历史行为。
        const titleText = normalizeSearchTerm(round.title);
        const previewText = normalizeSearchTerm(round.assistantPreview);
        const legacyText = normalizeSearchTerm(round.searchText);
        return titleText.includes(searchTerm) || previewText.includes(searchTerm) || legacyText.includes(searchTerm);
      });
    }

    this.renderRoundList();
  }

  applyThemeVariables() {
    if (!this.root) {
      return;
    }

    this.root.style.setProperty("--ccn-theme-primary", THEME_PRIMARY);
    const rgb = hexToRgbString(THEME_PRIMARY);
    if (rgb) {
      this.root.style.setProperty("--ccn-theme-primary-rgb", rgb);
    }
  }

  createRulerNode() {
    const rulerNode = document.createElement("span");
    rulerNode.className = "ccn-item-ruler";

    const labelNode = document.createElement("span");
    labelNode.className = "ccn-ruler-label";

    rulerNode.appendChild(labelNode);

    return {
      rulerNode,
      labelNode
    };
  }

  createRoundItem() {
    const item = document.createElement("li");
    item.className = "ccn-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ccn-item-btn";

    const { rulerNode, labelNode } = this.createRulerNode();

    const contentNode = document.createElement("span");
    contentNode.className = "ccn-item-main";

    const headNode = document.createElement("span");
    headNode.className = "ccn-item-head";

    const titleNode = document.createElement("span");
    titleNode.className = "ccn-item-title";

    const statusNode = document.createElement("span");
    statusNode.className = "ccn-item-status";
    statusNode.hidden = true;

    const previewNode = document.createElement("span");
    previewNode.className = "ccn-item-preview";

    headNode.appendChild(titleNode);
    headNode.appendChild(statusNode);
    contentNode.appendChild(headNode);
    contentNode.appendChild(previewNode);

    button.appendChild(contentNode);
    item.appendChild(rulerNode);
    item.appendChild(button);

    button.addEventListener("click", () => {
      // 点击后让按钮失焦，避免滚轮焦点停留在面板控件上。
      button.blur();
      const roundId = item.dataset.roundId;
      if (roundId && typeof this.onRoundClick === "function") {
        this.onRoundClick(roundId);
      }
    });

    item.__ccnRefs = {
      button,
      rulerNode,
      labelNode,
      titleNode,
      statusNode,
      previewNode
    };

    return item;
  }

  updateRuler(refs, roundIndex) {
    refs.labelNode.classList.add("is-visible");
    refs.labelNode.textContent = String(roundIndex);
  }

  updateRoundItem(item, round) {
    const refs = item.__ccnRefs;
    // 兼容旧版本 DOM（文档对象模型）结构：若刻度曾在卡片内部，迁移到卡片外侧。
    const legacyRulerInButton = refs.button.querySelector(".ccn-item-ruler");
    if (legacyRulerInButton && legacyRulerInButton.parentElement === refs.button) {
      item.insertBefore(legacyRulerInButton, refs.button);
      refs.rulerNode = legacyRulerInButton;
    }

    if (!refs.rulerNode || !item.contains(refs.rulerNode)) {
      refs.rulerNode = item.querySelector(".ccn-item-ruler");
    }
    if (!refs.rulerNode) {
      const created = this.createRulerNode();
      refs.rulerNode = created.rulerNode;
      refs.labelNode = created.labelNode;
      item.insertBefore(refs.rulerNode, refs.button);
    }
    if (refs.rulerNode.parentElement !== item) {
      item.insertBefore(refs.rulerNode, refs.button);
    }

    if (!refs.labelNode || !refs.rulerNode.contains(refs.labelNode)) {
      refs.labelNode = refs.rulerNode.querySelector(".ccn-ruler-label");
    }
    if (!refs.labelNode) {
      refs.labelNode = document.createElement("span");
      refs.labelNode.className = "ccn-ruler-label";
    }

    // 规范子节点：只保留数字序号（label），不显示任何刻度线。
    refs.rulerNode.appendChild(refs.labelNode);
    for (const child of Array.from(refs.rulerNode.children)) {
      if (child !== refs.labelNode) {
        child.remove();
      }
    }
    // 清理旧版本遗留的纵向轨道线节点。
    item.querySelectorAll(".ccn-ruler-rail").forEach((node) => node.remove());

    item.dataset.roundId = round.id;
    refs.button.setAttribute("aria-label", `跳转到第${round.index}轮对话`);

    this.updateRuler(refs, round.index);
    refs.titleNode.textContent = round.title;

    // 本轮 UI 要求：不展示“生成中/异常”等状态标签，保持列表更简洁。
    refs.statusNode.hidden = true;
    refs.statusNode.className = "ccn-item-status";
    refs.statusNode.textContent = "";

    const previewText = String(round.assistantPreview || "").trim();
    if (previewText) {
      refs.previewNode.classList.remove("is-empty");
      refs.previewNode.removeAttribute("aria-hidden");
      refs.previewNode.textContent = previewText;
    } else {
      // 无回复时保留一行占位，避免列表高度在刷新时跳动。
      refs.previewNode.classList.add("is-empty");
      refs.previewNode.setAttribute("aria-hidden", "true");
      refs.previewNode.textContent = "　";
    }
  }

  renderRoundList() {
    if (!this.listContainer) {
      return;
    }

    const validRoundIds = new Set(this.allRounds.map((round) => round.id));
    const visibleRoundIds = new Set();
    const fragment = document.createDocumentFragment();

    // 先清理掉已失效轮次，避免 DOM（文档对象模型）缓存持续膨胀。
    for (const [id, node] of this.itemNodeMap.entries()) {
      if (validRoundIds.has(id)) {
        continue;
      }
      if (node.parentElement === this.listContainer) {
        this.listContainer.removeChild(node);
      }
      this.itemNodeMap.delete(id);
    }

    for (const round of this.filteredRounds) {
      let item = this.itemNodeMap.get(round.id);
      if (!item) {
        item = this.createRoundItem();
        this.itemNodeMap.set(round.id, item);
      }

      this.updateRoundItem(item, round);
      item.classList.toggle("is-active", round.id === this.activeRoundId);
      visibleRoundIds.add(round.id);
      fragment.appendChild(item);
    }

    // 统一 append（追加）可复用节点，避免每次 innerHTML 全量重建导致闪烁。
    this.listContainer.appendChild(fragment);

    for (const [id, node] of this.itemNodeMap.entries()) {
      if (visibleRoundIds.has(id)) {
        continue;
      }
      if (node.parentElement === this.listContainer) {
        this.listContainer.removeChild(node);
      }
    }

    const hasResult = this.filteredRounds.length > 0;
    this.emptyState.hidden = hasResult;
    this.listContainer.hidden = !hasResult;
  }

  handleExpandClick(event) {
    if (this.suppressNextExpandClick) {
      event.preventDefault();
      return;
    }
    this.setCollapsed(false);
  }

  handleExpandPointerDown(event) {
    if (!this.collapsed || !this.root || !this.expandButton) {
      return;
    }
    if (event.button !== 0) {
      return;
    }

    this.dragState.pointerId = event.pointerId;
    this.dragState.startY = event.clientY;
    this.dragState.startTop = this.getCurrentRootTop();
    this.dragState.isDragging = false;

    this.expandButton.classList.add("is-dragging");
    if (typeof this.expandButton.setPointerCapture === "function") {
      try {
        this.expandButton.setPointerCapture(event.pointerId);
      } catch (error) {
        this.logger.warn("设置拖拽捕获失败。", error);
      }
    }

    window.addEventListener("pointermove", this.boundHandleExpandPointerMove, { passive: false });
    window.addEventListener("pointerup", this.boundHandleExpandPointerEnd);
    window.addEventListener("pointercancel", this.boundHandleExpandPointerEnd);
  }

  handleExpandPointerMove(event) {
    if (event.pointerId !== this.dragState.pointerId || !this.collapsed) {
      return;
    }

    const deltaY = event.clientY - this.dragState.startY;
    if (!this.dragState.isDragging && Math.abs(deltaY) >= 4) {
      this.dragState.isDragging = true;
    }
    if (!this.dragState.isDragging) {
      return;
    }

    event.preventDefault();
    const nextTop = this.clampRootTop(this.dragState.startTop + deltaY);
    this.setRootTop(nextTop);
  }

  handleExpandPointerEnd(event) {
    if (event.pointerId !== this.dragState.pointerId) {
      return;
    }

    if (this.dragState.isDragging) {
      this.suppressNextExpandClick = true;
      setTimeout(() => {
        this.suppressNextExpandClick = false;
      }, 0);
    }

    if (this.expandButton && typeof this.expandButton.releasePointerCapture === "function") {
      try {
        this.expandButton.releasePointerCapture(event.pointerId);
      } catch (error) {
        this.logger.warn("释放拖拽捕获失败。", error);
      }
    }

    this.dragState.pointerId = null;
    this.dragState.startY = 0;
    this.dragState.startTop = 0;
    this.dragState.isDragging = false;
    this.expandButton?.classList.remove("is-dragging");
    this.detachDragListeners();
  }

  detachDragListeners() {
    window.removeEventListener("pointermove", this.boundHandleExpandPointerMove);
    window.removeEventListener("pointerup", this.boundHandleExpandPointerEnd);
    window.removeEventListener("pointercancel", this.boundHandleExpandPointerEnd);
  }

  handleWindowResize() {
    if (!this.root) {
      return;
    }
    this.setRootTop(this.clampRootTop(this.getCurrentRootTop()));
  }

  getCurrentRootTop() {
    if (!this.root) {
      return 84;
    }

    const inlineTop = Number.parseFloat(this.root.style.top);
    if (Number.isFinite(inlineTop)) {
      return inlineTop;
    }

    return this.root.getBoundingClientRect().top;
  }

  setRootTop(top) {
    if (!this.root) {
      return;
    }
    this.root.style.top = `${Math.round(top)}px`;
  }

  clampRootTop(top) {
    const minTop = 8;
    const buttonHeight = this.expandButton?.offsetHeight || 42;
    const maxTop = Math.max(minTop, window.innerHeight - buttonHeight - 8);
    return Math.min(Math.max(top, minTop), maxTop);
  }
}
