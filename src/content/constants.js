export const EXTENSION_NAME = "历史对话导航";

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
