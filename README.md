# 历史对话导航 NavChat

一个用于 ChatGPT 网页版的 Chrome 扩展（Chrome Extension，浏览器扩展）。
当前版本已完成“多平台架构抽象第一步”：把代码拆分为 core（核心层）+ adapter（平台适配层），并保持 ChatGPT 现有能力。

## 1. 平台支持等级

| 平台 | 支持等级 | 说明 |
|---|---|---|
| ChatGPT Web | Stable（稳定） | 已接入，功能完整可用 |
| Gemini Web | Experimental（实验性） | 架构预留，尚未接入 |
| 豆包 Web | Experimental（实验性） | 架构预留，尚未接入 |

### 平台“已接入”最小标准

以下 5 项全部通过，才标记为“已接入”：
1. detect（平台识别）
2. 消息识别
3. 一级导航
4. 点击跳转
5. 滚动高亮

## 2. 项目结构与文件作用

```text
NavChat/
├─ manifest.json
├─ README.md
└─ src/
   └─ content/
      ├─ loader.js
      ├─ main.js
      ├─ constants.js
      ├─ logger.js
      ├─ panel-view.js
      ├─ styles.css
      ├─ scroll-manager.js
      ├─ state-store.js
      ├─ title-extractor.js
      ├─ round-id.js
      ├─ answer-outline.js
      ├─ dom-adapter.js                  # 兼容层（旧路径）
      ├─ conversation-parser.js          # 兼容层（旧路径）
      ├─ adapters/
      │  └─ chatgpt-adapter.js           # ChatGPT 适配器实现
      └─ core/
         ├─ base-adapter.js              # 适配器基础接口
         ├─ adapter-registry.js          # 适配器注册表
         ├─ models.js                    # 统一消息模型
         ├─ message-pipeline.js          # 消息归一化流水线
         └─ conversation-parser.js       # 统一轮次解析
```

## 3. 架构说明（第一阶段）

- `main.js`：只负责编排，不写平台细节。
- `adapters/chatgpt-adapter.js`：封装 ChatGPT 页面差异，提供统一接口。
- `core/*`：只处理统一数据模型与轮次结构，不依赖具体平台 DOM。
- `panel-view.js` 与 `styles.css`：本轮保持功能与视觉行为不变。

## 4. 安装步骤（无代码基础）

1. 打开 Chrome，访问 `chrome://extensions/`。
2. 开启“开发者模式”（Developer mode，开发者模式）。
3. 点击“加载已解压的扩展程序”（Load unpacked，加载本地文件夹）。
4. 选择本项目根目录 `NavChat/`。
5. 打开 ChatGPT 对话页面并刷新，右侧应出现导航面板。

## 5. 当前功能清单（ChatGPT）

- 一级问答导航
- assistantPreview（助手预览）
- 二级章节导航
- 搜索
- 点击跳转
- 滚动高亮
- 动态刷新
- 收起/展开

## 6. DEBUG（调试）开关

在浏览器控制台（Console，控制台）执行：

```js
localStorage.setItem("CCN_DEBUG", "1");
location.reload();
```

关闭：

```js
localStorage.setItem("CCN_DEBUG", "0");
location.reload();
```

## 7. 已知限制

- ChatGPT 页面 DOM（文档对象模型）结构变化时，可能需要更新 `chatgpt-adapter.js`。
- 超长对话场景下，目录刷新可能有轻微延迟（已有防抖处理）。
