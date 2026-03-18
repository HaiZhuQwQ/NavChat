# 历史对话导航 ChatGPT Conversation Navigator

一个用于 ChatGPT 网页版的 Chrome 扩展（Chrome Extension），在页面右侧显示“历史对话导航”面板，支持快速搜索、跳转和当前轮次高亮。

## 1. 项目结构与文件作用

```text
历史对话导航/
├─ manifest.json
├─ README.md
└─ src/
   └─ content/
      ├─ loader.js
      ├─ main.js
      ├─ constants.js
      ├─ logger.js
      ├─ dom-adapter.js
      ├─ title-extractor.js
      ├─ round-id.js
      ├─ conversation-parser.js
      ├─ scroll-manager.js
      ├─ state-store.js
      ├─ panel-view.js
      └─ styles.css
```

- `manifest.json`：扩展清单（Manifest），声明权限、注入脚本与样式。
- `src/content/main.js`：启动入口，负责页面检查、等待容器、挂载面板、启动监听。
- `src/content/loader.js`：内容脚本加载器，负责动态导入 `main.js`。
- `src/content/dom-adapter.js`：所有 DOM 选择器集中管理（主选择器 primary + 备用选择器 fallback）。
- `src/content/conversation-parser.js`：把消息组装成“轮次”，并处理异常状态。
- `src/content/round-id.js`：生成稳定本地轮次 ID（id），减少刷新跳变。
- `src/content/scroll-manager.js`：处理平滑滚动（smooth scroll）和当前轮次高亮同步。
- `src/content/panel-view.js`：面板 UI（用户界面）渲染、搜索、折叠交互。
- `src/content/title-extractor.js`：标题提取与口语前缀清洗规则。
- `src/content/logger.js`：日志统一输出，支持 DEBUG（调试）开关。
- `src/content/state-store.js`：存储面板展开/收起状态。
- `src/content/styles.css`：全部视觉样式。

## 2. 无代码基础也可完成的安装步骤

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`。
2. 打开右上角“开发者模式”（Developer mode，开发者模式）。
3. 点击“加载已解压的扩展程序”（Load unpacked，加载本地文件夹）。
4. 选择本项目根目录：`历史对话导航/`。
5. 看到扩展卡片出现后，确保开关是开启状态。
6. 打开 `https://chatgpt.com/` 或 `https://chat.openai.com/` 的对话页面。
7. 刷新页面一次，右侧应出现“历史对话导航”面板。

## 3. 使用说明

- 自动识别页面消息，并按“用户 + assistant（助手）”组装轮次。
- 点击导航项：平滑滚动到对应用户消息位置。
- 搜索框：输入关键词实时过滤导航项。
- 收起按钮：可折叠面板；折叠后会保留一个“历史”小按钮。
- 滚动页面：面板会自动高亮当前可见轮次。
- 页面内容变化（新消息、流式生成）：目录自动刷新。

## 4. 你最常改的三个点

- 改样式：编辑 `src/content/styles.css`。
- 改标题规则：编辑 `src/content/title-extractor.js`。
- 扩展失效时优先检查：
  1. `manifest.json` 里的匹配域名是否包含你正在访问的域名。
  2. 扩展是否在 `chrome://extensions/` 中启用。
  3. 当前页面是否是有效对话页（`/`、`/c/...`、`/g/...`、`/share/...`）。
  4. ChatGPT 页面结构是否变更（重点检查 `src/content/dom-adapter.js` 选择器）。

## 5. DEBUG 调试开关（可选）

- 打开 ChatGPT 页面后按 `F12` 打开开发者工具（DevTools，开发者工具）。
- 切到 Console（控制台）并执行：

```js
localStorage.setItem("CCN_DEBUG", "1");
location.reload();
```

- 关闭 DEBUG：

```js
localStorage.setItem("CCN_DEBUG", "0");
location.reload();
```

开启后会输出关键生命周期日志：初始化、选择器降级、轮次解析、高亮更新、刷新触发等。

## 6. MVP 已知限制

- ChatGPT 页面 DOM 结构变化时，可能需要更新 `dom-adapter.js`。
- 角色识别优先依赖语义属性；当页面缺失这些属性时，fallback（降级）准确率会下降。
- 大型长对话下会有防抖优化，但极端长度仍可能出现轻微延迟。

## 7. 可判定验收清单

- 导航生成：进入有效对话页后，1 秒内看到面板。
- 跳转：点击导航项后平滑滚动，目标消息进入可视区。
- 搜索：输入关键词后 200ms 左右列表更新；无匹配显示空状态。
- 高亮：滚动时约 300ms 内切换当前轮次高亮。
- 动态刷新：新消息出现或流式输出时，目录自动更新。
- 非对话页：不挂载面板，并输出明确日志。
