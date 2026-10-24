/**
 * LoginSpec 模块入口（ADR-0014 / ADR-0015）。
 *
 * 纯函数层：数据模型、输入命名空间、模板解析、静态校验器、迁移链。
 * 执行器 `runSpec` 是唯一生产执行路径（ADR-0015 D12）。
 */

export * from "./migrate";
export * from "./namespace";
export * from "./package";
export * from "./run";
export * from "./trial";
export * from "./template";
export * from "./types";
export * from "./validate";
export * from "./editor";
export * from "./http";
export * from "./transform";
export * from "./strategy-library";
