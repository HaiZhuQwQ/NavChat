(() => {
  const base = chrome.runtime.getURL("src/content/main.js");
  console.info("[历史对话导航][loader] 开始加载主模块", base);
  import(base).catch((error) => {
    console.error("[历史对话导航][loader] 模块加载失败", error);
  });
})();
