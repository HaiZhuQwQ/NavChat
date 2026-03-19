/**
 * 本文件是 DomAdapter（旧适配器类名）兼容层。
 * 作用：把历史导入路径映射到新的 ChatGPTAdapter（ChatGPT 平台适配器），避免旧代码直接失效。
 * 说明：当前主流程直接使用 ChatGPTAdapter；保留该别名仅为兼容旧代码，后续可逐步移除。
 */
import { ChatGPTAdapter, getSelectorRegistrySnapshot } from "./adapters/chatgpt-adapter.js";

export class DomAdapter extends ChatGPTAdapter {}

export { getSelectorRegistrySnapshot };
