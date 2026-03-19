/**
 * 本文件定义 BaseAdapter（基础适配器）接口。
 * 作用：统一平台适配器能力，避免 core（核心层）直接依赖平台 DOM（文档对象模型）细节。
 */
export class BaseAdapter {
  constructor(platform) {
    this.platform = platform || "unknown";
  }

  // detect（检测）: 当前页面是否属于该平台。
  detect(_context = {}) {
    throw new Error("BaseAdapter.detect() 必须由子类实现");
  }

  // waitForReady（等待就绪）: 等待对话容器可用。
  async waitForReady(_context = {}) {
    throw new Error("BaseAdapter.waitForReady() 必须由子类实现");
  }

  // getConversationRoot（获取对话根容器）: 返回平台对话主容器。
  getConversationRoot(_context = {}) {
    throw new Error("BaseAdapter.getConversationRoot() 必须由子类实现");
  }

  // getMessageElements（获取消息节点）: 返回有序消息节点数组。
  getMessageElements(_root, _context = {}) {
    throw new Error("BaseAdapter.getMessageElements() 必须由子类实现");
  }

  // parseMessage（解析单条消息）: 输出统一消息模型。
  parseMessage(_element, _context = {}) {
    throw new Error("BaseAdapter.parseMessage() 必须由子类实现");
  }

  // getScrollContainer（获取滚动容器）: 返回内部滚动容器，若无则返回 null。
  getScrollContainer(_anchor, _context = {}) {
    throw new Error("BaseAdapter.getScrollContainer() 必须由子类实现");
  }

  // scrollToMessage（滚动到消息）: 执行滚动并返回目标 top 值。
  scrollToMessage(_anchor, _context = {}) {
    throw new Error("BaseAdapter.scrollToMessage() 必须由子类实现");
  }

  // observeChanges（监听变更）: 注册变更监听并返回取消监听函数。
  observeChanges(_root, _onChange, _context = {}) {
    throw new Error("BaseAdapter.observeChanges() 必须由子类实现");
  }

  // detectStreamingState（检测流式状态）: 返回 { isStreaming, isError, isEmpty }。
  detectStreamingState(_element, _context = {}) {
    throw new Error("BaseAdapter.detectStreamingState() 必须由子类实现");
  }
}
