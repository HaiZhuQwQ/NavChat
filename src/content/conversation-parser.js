/**
 * 本文件是 conversation-parser（轮次解析）兼容层。
 * 作用：兼容旧导入路径，真实实现位于 core/conversation-parser.js。
 * 说明：当前主流程已迁移到 core 目录；保留此文件用于向后兼容，后续确认无外部依赖后可删除。
 */
export * from "./core/conversation-parser.js";
