/**
 * Options 配置页的组件加载器（按 toolId 索引）。
 *
 * 刻意不放进 shared/tool-definitions.ts：background 与 content script 都会
 * import 该注册表，而 WXT 的 lib/IIFE 构建会 inlineDynamicImports，把这里
 * 所有 Config.vue（含 scoped CSS 与 Vue runtime）内联进 background/content。
 * 仅在 options 入口引用，才能保持按需加载。
 */
export const configComponentLoaders: Record<string, () => Promise<any>> = {
  "account-switch": () => import("../tools/account-switch/Config.vue"),
  "json-formatter": () => import("../tools/json-formatter/Config.vue"),
  "json-diff": () => import("../tools/json-diff/Config.vue"),
  "image-base64": () => import("../tools/image-base64/Config.vue"),
  "code-beautify": () => import("../tools/code-beautify/Config.vue"),
  "mock-data": () => import("../tools/mock-data/Config.vue"),
};
