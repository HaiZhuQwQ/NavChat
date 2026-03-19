// 全局常量：统一管理导航面板、章节导航与状态枚举的配置项。
export const EXTENSION_NAME = "历史对话导航";

export const THEME_PRIMARY = "#287CFF";
export const PREVIEW_MAX_LENGTH = 24;
export const MINOR_TICK_STEP = 5;
export const MAJOR_TICK_STEP = 5;
export const SECTION_BUTTON_TEXT = "章节";
export const SECTION_EMPTY_TEXT = "未检测到可导航章节";
// 章节导航最小显示数量：少于 2 个章节时不显示按钮。
export const SECTION_MIN_COUNT = 2;
// 章节导航最大数量：最多保留 50 个章节。
export const SECTION_MAX_COUNT = 50;
// 章节选择器（selector，选择器）：仅允许从 h1/h2/h3 提取章节。
export const SECTION_HEADING_SELECTOR = "h1, h2, h3";

export const STORAGE_KEYS = {
  PANEL_COLLAPSED: "ccn_panel_collapsed",
  DEBUG_ENABLED: "ccn_debug_enabled"
};

export const CONFIG = {
  DEBUG_DEFAULT: false,
  WAIT_CONTAINER_TIMEOUT_MS: 15000,
  WAIT_POLL_INTERVAL_MS: 250,
  REFRESH_DEBOUNCE_MS: 200,
  SEARCH_DEBOUNCE_MS: 120,
  SCROLL_HIGHLIGHT_THROTTLE_MS: 150,
  SCROLL_TOP_OFFSET_PX: 96,
  PANEL_MAX_HEIGHT_VH: 78
};

export const ROUND_STATUS = {
  COMPLETE: "complete",
  PENDING_REPLY: "pending_reply",
  STREAMING: "streaming",
  ERROR: "error",
  EMPTY: "empty"
};

export const STATUS_LABEL_MAP = {
  [ROUND_STATUS.COMPLETE]: "",
  [ROUND_STATUS.PENDING_REPLY]: "待回复",
  [ROUND_STATUS.STREAMING]: "生成中",
  [ROUND_STATUS.ERROR]: "异常",
  [ROUND_STATUS.EMPTY]: "空回复"
};
