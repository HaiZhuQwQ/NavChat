import { CONFIG, STATUS_LABEL_MAP } from "./constants.js";

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

function resolveRulerTickLevel(roundIndex) {
  if (roundIndex % 10 === 0) {
    return "major";
  }
  if (roundIndex % 5 === 0) {
    return "mid";
  }
  return "minor";
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

    this.debouncedFilter = debounce(() => {
      this.applyFilter(this.searchInput?.value || "");
    }, CONFIG.SEARCH_DEBOUNCE_MS);
  }

  mount() {
    if (this.root) {
      return;
    }

    this.root = document.createElement("aside");
    this.root.id = "ccn-root";
    this.root.innerHTML = `
      <div class="ccn-shell" aria-label="历史对话导航面板">
        <div class="ccn-header">
          <h2 class="ccn-title">历史对话导航</h2>
          <button type="button" class="ccn-toggle-btn" data-action="collapse">收起</button>
        </div>
        <div class="ccn-search-wrap">
          <input type="search" class="ccn-search-input" placeholder="搜索问题关键词..." aria-label="搜索导航项" />
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

    this.collapseButton.addEventListener("click", () => this.setCollapsed(true));
    this.expandButton.addEventListener("click", () => this.setCollapsed(false));
    this.searchInput.addEventListener("input", () => this.debouncedFilter());

    this.logger.info("导航面板挂载完成。");
  }

  destroy() {
    if (!this.root) {
      return;
    }
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
    if (!node) {
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
        const text = normalizeSearchTerm(round.searchText);
        return text.includes(searchTerm);
      });
    }

    this.renderRoundList();
  }

  createRulerNode(roundIndex) {
    const tickLevel = resolveRulerTickLevel(roundIndex);

    const rulerNode = document.createElement("span");
    rulerNode.className = "ccn-item-ruler";

    const railNode = document.createElement("span");
    railNode.className = "ccn-ruler-rail";

    const tickNode = document.createElement("span");
    tickNode.className = `ccn-ruler-tick is-${tickLevel}`;

    const labelNode = document.createElement("span");
    labelNode.className = "ccn-ruler-label";
    if (tickLevel === "major") {
      labelNode.classList.add("is-visible");
      labelNode.textContent = String(roundIndex);
    }

    rulerNode.appendChild(railNode);
    rulerNode.appendChild(tickNode);
    rulerNode.appendChild(labelNode);

    return rulerNode;
  }

  renderRoundList() {
    if (!this.listContainer) {
      return;
    }

    this.listContainer.innerHTML = "";
    this.itemNodeMap.clear();

    const fragment = document.createDocumentFragment();

    for (const round of this.filteredRounds) {
      const item = document.createElement("li");
      item.className = "ccn-item";
      item.dataset.roundId = round.id;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "ccn-item-btn";
      button.setAttribute("aria-label", `跳转到第${round.index}轮对话`);

      const rulerNode = this.createRulerNode(round.index);

      const contentNode = document.createElement("span");
      contentNode.className = "ccn-item-main";

      const headNode = document.createElement("span");
      headNode.className = "ccn-item-head";

      const titleNode = document.createElement("span");
      titleNode.className = "ccn-item-title";
      titleNode.textContent = round.title;

      headNode.appendChild(titleNode);

      const statusLabel = STATUS_LABEL_MAP[round.status];
      if (statusLabel) {
        const statusNode = document.createElement("span");
        statusNode.className = `ccn-item-status is-${round.status}`;
        statusNode.textContent = statusLabel;
        headNode.appendChild(statusNode);
      }

      const previewNode = document.createElement("span");
      previewNode.className = "ccn-item-preview";

      const previewText = String(round.assistantPreview || "").trim();
      if (previewText) {
        previewNode.textContent = previewText;
      } else {
        // 无回复时保留一行占位，避免列表高度在刷新时跳动。
        previewNode.classList.add("is-empty");
        previewNode.setAttribute("aria-hidden", "true");
        previewNode.textContent = "　";
      }

      contentNode.appendChild(headNode);
      contentNode.appendChild(previewNode);

      button.appendChild(rulerNode);
      button.appendChild(contentNode);

      button.addEventListener("click", () => {
        // 点击后让按钮失焦，避免滚轮焦点停留在面板控件上。
        button.blur();
        if (typeof this.onRoundClick === "function") {
          this.onRoundClick(round.id);
        }
      });

      item.appendChild(button);
      fragment.appendChild(item);
      this.itemNodeMap.set(round.id, item);

      if (round.id === this.activeRoundId) {
        item.classList.add("is-active");
      }
    }

    this.listContainer.appendChild(fragment);

    const hasResult = this.filteredRounds.length > 0;
    this.emptyState.hidden = hasResult;
    this.listContainer.hidden = !hasResult;
  }
}
