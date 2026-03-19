/**
 * 本文件是 DomAdapter（旧适配器类名）兼容层。
 * 作用：把历史导入路径映射到新的 ChatGPTAdapter（ChatGPT 平台适配器），避免旧代码直接失效。
 */
import { ChatGPTAdapter, getSelectorRegistrySnapshot } from "./adapters/chatgpt-adapter.js";

export class DomAdapter extends ChatGPTAdapter {}

export { getSelectorRegistrySnapshot };
