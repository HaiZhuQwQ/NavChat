import { CONFIG, EXTENSION_NAME } from "./constants.js";

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function readDebugOverride() {
  try {
    const runtimeFlag = globalThis?.__CCN_DEBUG__;
    if (typeof runtimeFlag === "boolean") {
      return runtimeFlag;
    }
    const localFlag = globalThis?.localStorage?.getItem("CCN_DEBUG");
    if (localFlag === "1" || localFlag === "true") {
      return true;
    }
    if (localFlag === "0" || localFlag === "false") {
      return false;
    }
  } catch (_error) {
    // 某些页面上下文可能禁用 localStorage，这里静默降级。
  }
  return null;
}

function resolveMinLevel() {
  const override = readDebugOverride();
  const debugEnabled = override == null ? CONFIG.DEBUG_DEFAULT : override;
  return debugEnabled ? "debug" : "info";
}

export function createLogger(namespace = "main") {
  const minLevel = resolveMinLevel();

  function shouldLog(level) {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
  }

  function emit(level, message, extra) {
    if (shouldLog(level) === false) {
      return;
    }
    const prefix = `[${EXTENSION_NAME}][${namespace}][${level.toUpperCase()}]`;
    const time = new Date().toISOString();
    if (extra === undefined) {
      console[level](`${time} ${prefix} ${message}`);
      return;
    }
    console[level](`${time} ${prefix} ${message}`, extra);
  }

  return {
    debug(message, extra) {
      emit("debug", message, extra);
    },
    info(message, extra) {
      emit("info", message, extra);
    },
    warn(message, extra) {
      emit("warn", message, extra);
    },
    error(message, extra) {
      emit("error", message, extra);
    }
  };
}
