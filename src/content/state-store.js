import { STORAGE_KEYS } from "./constants.js";

const memoryFallback = {
  [STORAGE_KEYS.PANEL_COLLAPSED]: false,
  [STORAGE_KEYS.DEBUG_ENABLED]: null
};

function hasChromeStorage() {
  return Boolean(globalThis?.chrome?.storage?.local);
}

function hasValidRuntime() {
  return Boolean(globalThis?.chrome?.runtime?.id);
}

function storageGet(key) {
  if (!hasChromeStorage() || !hasValidRuntime()) {
    return Promise.resolve({ [key]: memoryFallback[key] });
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime?.lastError) {
          resolve({ [key]: memoryFallback[key] });
          return;
        }
        resolve(result);
      });
    } catch (_error) {
      // 扩展重载后旧上下文可能失效，这里回退到内存状态。
      resolve({ [key]: memoryFallback[key] });
    }
  });
}

function storageSet(payload) {
  if (!hasChromeStorage() || !hasValidRuntime()) {
    Object.assign(memoryFallback, payload);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(payload, () => {
        if (chrome.runtime?.lastError) {
          Object.assign(memoryFallback, payload);
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (_error) {
      Object.assign(memoryFallback, payload);
      resolve(false);
    }
  });
}

export async function loadPanelCollapsed() {
  const result = await storageGet(STORAGE_KEYS.PANEL_COLLAPSED);
  return Boolean(result[STORAGE_KEYS.PANEL_COLLAPSED]);
}

export async function savePanelCollapsed(collapsed) {
  const payload = { [STORAGE_KEYS.PANEL_COLLAPSED]: Boolean(collapsed) };
  const stored = await storageSet(payload);
  if (stored === false) {
    Object.assign(memoryFallback, payload);
  }
}
