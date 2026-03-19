# 历史对话导航 NavChat

NavChat 是一个用于 ChatGPT Web（网页端）的 Chrome Extension（浏览器扩展），帮助你在长对话中快速定位内容。当前版本 `v1.7`，已完成多平台架构第一阶段（core 核心层 + adapter 适配层），并优先保证 ChatGPT 现有能力不回退。

## 核心功能（ChatGPT）

- 一级问答导航（按轮次浏览历史对话）
- assistantPreview（助手预览）
- 二级章节导航（基于回答中的标题结构）
- 搜索（关键词过滤）
- 点击跳转
- 滚动高亮
- 动态刷新
- 面板收起/展开

## 平台支持等级

| 平台 | 支持等级 | 说明 |
|---|---|---|
| ChatGPT Web | Stable（稳定） | 已接入，功能完整可用 |
| Gemini Web | Experimental（实验性） | 架构预留，尚未接入 |
| 豆包 Web | Experimental（实验性） | 架构预留，尚未接入 |

平台“已接入”最小标准（5 项）：
1. detect（平台识别）
2. 消息识别
3. 一级导航
4. 点击跳转
5. 滚动高亮

## 快速安装（Chrome）

1. 打开 `chrome://extensions/`。
2. 打开右上角“Developer mode（开发者模式）”。
3. 点击“Load unpacked（加载已解压扩展）”。
4. 选择项目目录 `NavChat/`。
5. 打开 ChatGPT 对话页面并刷新，右侧出现导航面板即安装成功。

## 使用注意

- 当前稳定支持域名：`chatgpt.com`、`chat.openai.com`。
- 章节导航采用保守提取策略，主要依赖 `h1/h2/h3` 标题结构；不满足条件时不会显示“章节”按钮。
- 若面板未出现，先执行“重新加载扩展 + 刷新页面”。
- ChatGPT 页面 DOM（文档对象模型）改版时，可能需要更新 `src/content/adapters/chatgpt-adapter.js`。

## 项目结构（关键目录）

```text
NavChat/
├─ manifest.json
├─ README.md
└─ src/content/
   ├─ main.js
   ├─ panel-view.js
   ├─ scroll-manager.js
   ├─ answer-outline.js
   ├─ adapters/
   │  └─ chatgpt-adapter.js
   └─ core/
      ├─ base-adapter.js
      ├─ adapter-registry.js
      ├─ models.js
      ├─ message-pipeline.js
      └─ conversation-parser.js
```

## 架构说明（第一阶段）

- `main.js`：流程编排层（不绑定具体平台细节）
- `adapters/chatgpt-adapter.js`：平台 DOM（文档对象模型）适配
- `core/*`：统一消息模型与轮次解析
- `panel-view.js` / `styles.css`：导航面板渲染与交互

## 调试开关（DEBUG）

开启调试日志：

```js
localStorage.setItem("CCN_DEBUG", "1");
location.reload();
```

关闭调试日志：

```js
localStorage.setItem("CCN_DEBUG", "0");
location.reload();
```
