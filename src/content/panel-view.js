import {
  CONFIG,
  SECTION_BUTTON_TEXT,
  SECTION_EMPTY_TEXT,
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

function hasImageIntent(text) {
  return /(?:图片|配图|画图|插画|海报|logo|图标|image|illustration|poster|icon|dalle)/i.test(String(text || ""));
}

function resolveRoundPreview(round) {
  const previewText = String(round?.assistantPreview || "").trim();
  if (previewText) {
    return previewText;
  }

  // 图片回答在某些 DOM（文档对象模型）结构下可能提取不到正文，这里做稳定兜底。
  const status = String(round?.status || "");
  const isSettled = status !== "pending_reply" && status !== "streaming";
  const imageFallback = round?.hasImageReply === true || (isSettled && hasImageIntent(round?.userText));
  return imageFallback ? "生成图片" : "";
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

/**
 * 面板视图层：负责一级“问答轮次导航”和二级“章节导航”的渲染与交互。
 */
export class PanelView {
  constructor(options) {
    this.logger = options.logger;
    this.onRoundClick = options.onRoundClick;
    this.onRoundSectionClick = options.onRoundSectionClick;
    this.onSectionClick = options.onSectionClick;
    this.onToggleCollapse = options.onToggleCollapse;

    this.root = null;
    this.shell = null;
    this.collapseButton = null;
    this.expandButton = null;
    this.searchWrap = null;
    this.searchInput = null;
    this.listContainer = null;
    this.emptyState = null;

    this.allRounds = [];
    this.filteredRounds = [];
    this.activeRoundId = null;
    this.roundItemNodeMap = new Map();

    this.sectionRoundId = null;
    this.sectionGroups = [];
    this.sectionItems = [];
    this.activeSectionId = null;
    this.inlineSectionNodeMap = new Map();

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
      <button type="button" class="ccn-expand-btn" aria-label="展开历史对话导航" title="展开历史对话导航">
        <img class="ccn-expand-icon" alt="" aria-hidden="true" />
        <span class="ccn-expand-fallback">历史</span>
      </button>
    `;

    document.body.appendChild(this.root);

    this.shell = this.root.querySelector(".ccn-shell");
    this.searchWrap = this.root.querySelector(".ccn-search-wrap");
    this.collapseButton = this.root.querySelector("[data-action='collapse']");
    this.expandButton = this.root.querySelector(".ccn-expand-btn");
    this.searchInput = this.root.querySelector(".ccn-search-input");
    this.listContainer = this.root.querySelector(".ccn-list");
    this.emptyState = this.root.querySelector(".ccn-empty");

    this.applyThemeVariables();
    this.applyExpandButtonIcon();

    this.collapseButton.addEventListener("click", () => this.setCollapsed(true));
    this.expandButton.addEventListener("click", (event) => this.handleExpandClick(event));
    this.expandButton.addEventListener("pointerdown", (event) => this.handleExpandPointerDown(event));
    this.searchInput.addEventListener("input", () => this.debouncedFilter());
    window.addEventListener("resize", this.boundHandleWindowResize, { passive: true });

    this.updateViewModeUI();
    this.logger.info("导航面板挂载完成。");
  }

  applyExpandButtonIcon() {
    if (!this.expandButton) {
      return;
    }

    const iconNode = this.expandButton.querySelector(".ccn-expand-icon");
    if (!(iconNode instanceof HTMLImageElement)) {
      return;
    }

    const iconUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL("icons/navchat-collapse-toggle.png")
      : "";

    if (!iconUrl) {
      this.expandButton.classList.remove("has-icon");
      return;
    }

    iconNode.addEventListener(
      "load",
      () => {
        this.expandButton?.classList.add("has-icon");
      },
      { once: true }
    );

    iconNode.addEventListener(
      "error",
      () => {
        this.expandButton?.classList.remove("has-icon");
      },
      { once: true }
    );

    iconNode.src = iconUrl;
  }

  destroy() {
    if (!this.root) {
      return;
    }

    this.detachDragListeners();
    window.removeEventListener("resize", this.boundHandleWindowResize);
    this.root.remove();
    this.root = null;
    this.roundItemNodeMap.clear();
    this.inlineSectionNodeMap.clear();
  }

  setCollapsed(collapsed, options = {}) {
    this.collapsed = Boolean(collapsed);
    if (!this.root) {
      return;
    }

    this.root.classList.toggle("is-collapsed", this.collapsed);
    // 收起/展开都要立即做边界钳制，避免展开后面板下半部落到视口外。
    this.setRootTop(this.clampRootTop(this.getCurrentRootTop(), { collapsed: this.collapsed }));

    if (options.skipPersist !== true && typeof this.onToggleCollapse === "function") {
      this.onToggleCollapse(this.collapsed);
    }
  }

  setRounds(rounds) {
    this.allRounds = Array.isArray(rounds) ? rounds : [];
    this.applyFilter(this.searchInput?.value || "");

    if (this.sectionRoundId) {
      const sectionRound = this.allRounds.find((item) => item.id === this.sectionRoundId);
      if (!sectionRound || sectionRound.hasSections !== true) {
        // 当前章节所属轮次失效时，显示空态，由 main 层决定是否自动回退。
        this.syncSectionViewRound(null);
        return;
      }
      this.syncSectionViewRound(sectionRound, {
        preferredSectionId: this.activeSectionId
      });
    }
  }

  setActiveRound(roundId) {
    this.activeRoundId = roundId;
    const shouldShowRoundActive = !this.sectionRoundId;

    for (const [id, node] of this.roundItemNodeMap.entries()) {
      node.classList.toggle("is-active", shouldShowRoundActive && id === roundId);
      node.classList.toggle("is-section-open", id === this.sectionRoundId);
    }

    this.ensureActiveVisible();
  }

  setActiveSection(sectionId) {
    this.activeSectionId = sectionId || null;
    this.syncInlineSectionActiveClasses();
    this.ensureActiveVisible();
  }

  getActiveRoundId() {
    return this.activeRoundId;
  }

  getViewMode() {
    return this.sectionRoundId ? "sections-inline" : "rounds";
  }

  getSectionViewState() {
    return {
      roundId: this.sectionRoundId,
      activeSectionId: this.activeSectionId
    };
  }

  openSectionView(round) {
    this.sectionRoundId = round?.id || null;
    this.sectionGroups = Array.isArray(round?.sectionGroups) ? round.sectionGroups : [];
    this.sectionItems = Array.isArray(round?.sections) ? round.sections : [];
    this.activeSectionId = null;
    this.activeRoundId = round?.id || this.activeRoundId;

    this.updateViewModeUI();
    this.renderRoundList();
  }

  syncSectionViewRound(round, options = {}) {
    this.sectionRoundId = round?.id || null;
    this.sectionGroups = Array.isArray(round?.sectionGroups) ? round.sectionGroups : [];
    this.sectionItems = Array.isArray(round?.sections) ? round.sections : [];

    const preferredSectionId = options.preferredSectionId || this.activeSectionId;
    const hasPreferred = this.sectionItems.some((item) => item.id === preferredSectionId);
    this.activeSectionId = hasPreferred ? preferredSectionId : null;

    this.updateViewModeUI();
    this.renderRoundList();
  }

  backToRoundView(options = {}) {
    this.sectionRoundId = null;
    this.sectionGroups = [];
    this.sectionItems = [];
    this.activeSectionId = null;
    this.inlineSectionNodeMap.clear();

    if (options.roundId) {
      this.activeRoundId = options.roundId;
    }

    this.updateViewModeUI();
    this.renderRoundList();
    this.setActiveRound(this.activeRoundId);
  }

  ensureActiveVisible() {
    if (this.activeSectionId) {
      const sectionNode = this.inlineSectionNodeMap.get(this.activeSectionId);
      if (sectionNode && sectionNode.parentElement) {
        sectionNode.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
    }

    if (!this.activeRoundId) {
      return;
    }

    const node = this.roundItemNodeMap.get(this.activeRoundId);
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

    const button = document.createElement("div");
    button.className = "ccn-item-btn";
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");

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

    const sectionActionNode = document.createElement("span");
    sectionActionNode.className = "ccn-item-section-action";
    sectionActionNode.hidden = true;

    const sectionDivider = document.createElement("span");
    sectionDivider.className = "ccn-item-section-divider";
    sectionDivider.textContent = "|";

    const sectionNavBtn = document.createElement("button");
    sectionNavBtn.type = "button";
    sectionNavBtn.className = "ccn-item-inline-section-btn";
    sectionNavBtn.textContent = SECTION_BUTTON_TEXT;
    sectionNavBtn.hidden = true;

    const previewNode = document.createElement("span");
    previewNode.className = "ccn-item-preview";

    const inlineSectionListNode = document.createElement("ul");
    inlineSectionListNode.className = "ccn-inline-section-list";
    inlineSectionListNode.hidden = true;

    headNode.appendChild(titleNode);
    headNode.appendChild(statusNode);
    sectionActionNode.appendChild(sectionDivider);
    sectionActionNode.appendChild(sectionNavBtn);
    headNode.appendChild(sectionActionNode);
    contentNode.appendChild(headNode);
    contentNode.appendChild(previewNode);

    button.appendChild(contentNode);
    item.appendChild(rulerNode);
    item.appendChild(button);
    item.appendChild(inlineSectionListNode);

    button.addEventListener("click", () => {
      // 点击后让按钮失焦，避免滚轮焦点停留在面板控件上。
      button.blur();
      const roundId = item.dataset.roundId;
      if (roundId && typeof this.onRoundClick === "function") {
        this.onRoundClick(roundId);
      }
    });

    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      button.blur();
      const roundId = item.dataset.roundId;
      if (roundId && typeof this.onRoundClick === "function") {
        this.onRoundClick(roundId);
      }
    });

    sectionNavBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const roundId = item.dataset.roundId;
      if (roundId && typeof this.onRoundSectionClick === "function") {
        this.onRoundSectionClick(roundId);
      }
    });

    item.__ccnRefs = {
      button,
      rulerNode,
      labelNode,
      titleNode,
      statusNode,
      previewNode,
      sectionActionNode,
      sectionDivider,
      sectionNavBtn,
      inlineSectionListNode
    };

    return item;
  }

  createSectionItem(section, options = {}) {
    const item = document.createElement("li");
    item.className = "ccn-inline-section-item";
    item.dataset.sectionId = section.id;
    item.dataset.itemType = section.itemType || "flat";
    item.dataset.groupId = section.groupId || "";
    item.classList.toggle("is-group", options.isGroup === true);
    item.classList.toggle("is-child", options.isChild === true);
    item.classList.toggle("is-flat", options.isFlat === true);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ccn-inline-section-btn";
    button.classList.toggle("is-group", options.isGroup === true);
    button.classList.toggle("is-child", options.isChild === true);
    button.setAttribute("aria-label", `跳转到章节：${section.title}`);

    const indexNode = document.createElement("span");
    indexNode.className = "ccn-inline-section-index";
    // 子章节不展示数字序号，改为小圆点，减少层级噪音。
    indexNode.textContent = options.isChild === true ? "•" : String(section.index || "");

    const textNode = document.createElement("span");
    textNode.className = "ccn-inline-section-title";
    const title = String(section?.title || "").trim();
    textNode.textContent = title || `章节 ${section.index}`;

    button.appendChild(indexNode);
    button.appendChild(textNode);
    item.appendChild(button);

    button.addEventListener("click", () => {
      button.blur();
      if (typeof this.onSectionClick === "function") {
        this.onSectionClick(section.id);
      }
    });

    return item;
  }

  createRenderSectionSignature() {
    if (!this.sectionRoundId) {
      return "";
    }

    if (this.sectionGroups.length > 0) {
      return this.sectionGroups
        .map((group) => {
          const childSignature = Array.isArray(group.children)
            ? group.children.map((child) => `${child.id}:${child.title}:${child.index}`).join(",")
            : "";
          return `${group.id}:${group.title}:${group.index}|${childSignature}`;
        })
        .join(";");
    }

    return this.sectionItems.map((section) => `${section.id}:${section.title}:${section.index}`).join("|");
  }

  syncInlineSectionActiveClasses() {
    for (const node of this.inlineSectionNodeMap.values()) {
      node.classList.remove("is-active", "is-group-active-light");
    }

    if (!this.activeSectionId) {
      return;
    }

    const activeNode = this.inlineSectionNodeMap.get(this.activeSectionId);
    if (!activeNode) {
      return;
    }

    activeNode.classList.add("is-active");
    if (activeNode.dataset.itemType !== "child") {
      return;
    }

    const groupId = activeNode.dataset.groupId;
    if (!groupId) {
      return;
    }

    const groupNode = this.inlineSectionNodeMap.get(groupId);
    if (groupNode && groupNode !== activeNode) {
      groupNode.classList.add("is-group-active-light");
    }
  }

  createSectionEmptyItem() {
    const item = document.createElement("li");
    item.className = "ccn-inline-section-empty";
    item.textContent = SECTION_EMPTY_TEXT;
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

    const hasSections = round.hasSections === true;
    const isExpanded = hasSections && round.id === this.sectionRoundId;
    const expandedSectionSignature = isExpanded ? this.createRenderSectionSignature() : "";
    const nextRenderKey = [
      round.id,
      round.index,
      round.title,
      round.status,
      round.assistantPreview,
      round.hasImageReply ? "1" : "0",
      hasSections ? "1" : "0",
      isExpanded ? "1" : "0",
      expandedSectionSignature
    ].join("::");

    if (item.dataset.renderKey === nextRenderKey) {
      return;
    }
    item.dataset.renderKey = nextRenderKey;

    item.dataset.roundId = round.id;
    refs.button.setAttribute("aria-label", `跳转到第${round.index}轮对话`);

    this.updateRuler(refs, round.index);
    refs.titleNode.textContent = round.title;

    // 本轮 UI 要求：不展示“生成中/异常”等状态标签，保持列表更简洁。
    refs.statusNode.hidden = true;
    refs.statusNode.className = "ccn-item-status";
    refs.statusNode.textContent = "";

    item.classList.toggle("is-section-open", isExpanded);
    refs.sectionActionNode.hidden = !hasSections;
    refs.sectionNavBtn.hidden = !hasSections;
    refs.sectionNavBtn.dataset.expanded = isExpanded ? "1" : "0";
    refs.sectionNavBtn.setAttribute("aria-pressed", isExpanded ? "true" : "false");
    refs.sectionNavBtn.textContent = SECTION_BUTTON_TEXT;
    refs.sectionNavBtn.setAttribute("aria-label", isExpanded ? `收起第${round.index}轮章节` : `打开第${round.index}轮回答的章节导航`);
    refs.sectionNavBtn.onmouseenter = () => {
      refs.sectionNavBtn.textContent = refs.sectionNavBtn.dataset.expanded === "1" ? "收起" : SECTION_BUTTON_TEXT;
    };
    refs.sectionNavBtn.onmouseleave = () => {
      refs.sectionNavBtn.textContent = SECTION_BUTTON_TEXT;
    };

    const finalPreview = resolveRoundPreview(round);
    if (finalPreview) {
      refs.previewNode.classList.remove("is-empty");
      refs.previewNode.removeAttribute("aria-hidden");
      refs.previewNode.textContent = finalPreview;
    } else {
      // 无回复时保留一行占位，避免列表高度在刷新时跳动。
      refs.previewNode.classList.add("is-empty");
      refs.previewNode.setAttribute("aria-hidden", "true");
      refs.previewNode.textContent = "　";
    }

    const inlineSections = isExpanded ? this.sectionItems : [];
    refs.inlineSectionListNode.hidden = !isExpanded;
    refs.inlineSectionListNode.textContent = "";

    if (isExpanded && this.sectionGroups.length > 0) {
      const fragment = document.createDocumentFragment();
      for (const group of this.sectionGroups) {
        const groupNode = this.createSectionItem(
          {
            id: group.id,
            title: group.title,
            index: group.index,
            groupId: group.id,
            itemType: "group"
          },
          { isGroup: true }
        );
        this.inlineSectionNodeMap.set(group.id, groupNode);
        fragment.appendChild(groupNode);

        for (const child of Array.isArray(group.children) ? group.children : []) {
          const childNode = this.createSectionItem(
            {
              ...child,
              groupId: group.id,
              itemType: "child"
            },
            { isChild: true }
          );
          this.inlineSectionNodeMap.set(child.id, childNode);
          fragment.appendChild(childNode);
        }
      }
      refs.inlineSectionListNode.appendChild(fragment);
      this.syncInlineSectionActiveClasses();
    } else if (inlineSections.length > 0) {
      const fragment = document.createDocumentFragment();
      for (const section of inlineSections) {
        const sectionNode = this.createSectionItem(
          {
            ...section,
            itemType: section.itemType || "flat"
          },
          { isFlat: true }
        );
        this.inlineSectionNodeMap.set(section.id, sectionNode);
        fragment.appendChild(sectionNode);
      }
      refs.inlineSectionListNode.appendChild(fragment);
      this.syncInlineSectionActiveClasses();
    } else if (isExpanded) {
      refs.inlineSectionListNode.appendChild(this.createSectionEmptyItem());
    }
  }

  renderRoundList() {
    if (!this.listContainer) {
      return;
    }

    const validRoundIds = new Set(this.allRounds.map((round) => round.id));
    const fragment = document.createDocumentFragment();

    // 先清理掉已失效轮次，避免 DOM（文档对象模型）缓存持续膨胀。
    for (const [id] of this.roundItemNodeMap.entries()) {
      if (!validRoundIds.has(id)) {
        this.roundItemNodeMap.delete(id);
      }
    }

    this.inlineSectionNodeMap.clear();
    this.listContainer.textContent = "";

    for (const round of this.filteredRounds) {
      let item = this.roundItemNodeMap.get(round.id);
      if (!item) {
        item = this.createRoundItem();
        this.roundItemNodeMap.set(round.id, item);
      }

      this.updateRoundItem(item, round);
      const shouldShowRoundActive = !this.sectionRoundId;
      item.classList.toggle("is-active", shouldShowRoundActive && round.id === this.activeRoundId);
      item.classList.toggle("is-section-open", round.id === this.sectionRoundId);
      fragment.appendChild(item);
    }

    this.listContainer.appendChild(fragment);

    const hasResult = this.filteredRounds.length > 0;
    this.emptyState.textContent = "没有匹配的对话，请换个关键词试试。";
    this.emptyState.hidden = hasResult;
    this.listContainer.hidden = !hasResult;
  }

  renderSectionList() {
    // 兼容旧调用：现在章节渲染改为“当前列表内联展开”。保留空实现避免外部引用报错。
    this.renderRoundList();
  }

  updateViewModeUI() {
    if (!this.searchInput || !this.searchWrap || !this.listContainer || !this.emptyState) {
      return;
    }

    this.root?.classList.toggle("is-section-inline", Boolean(this.sectionRoundId));
    // 章节改为“列表内联展开”，不再切换到独立二级视图。
    this.searchWrap.classList.remove("is-section-mode");
    this.searchInput.hidden = false;
    this.searchInput.disabled = false;
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

  getVisiblePanelHeight(collapsed = this.collapsed) {
    if (collapsed) {
      return this.expandButton?.offsetHeight || 40;
    }
    return this.shell?.offsetHeight || this.root?.offsetHeight || 420;
  }

  clampRootTop(top, options = {}) {
    const collapsed = options.collapsed ?? this.collapsed;
    const minTop = 8;
    const visibleHeight = this.getVisiblePanelHeight(collapsed);
    const maxTop = Math.max(minTop, window.innerHeight - visibleHeight - 8);
    return Math.min(Math.max(top, minTop), maxTop);
  }
}
