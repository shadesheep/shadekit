/**
 * Content script 浮动面板组件加载器（按 toolId 索引）。
 *
 * 不放进 shared/tool-definitions.ts：background 也会 import 该注册表，
 * 放进去会让 background.js 内联 SwitcherPanel + Vue runtime。
 * 仅在 content 入口引用，保持 UI 代码只进入 content bundle。
 */
export const panelComponentLoaders: Record<string, () => Promise<any>> = {
  "account-switch": () => import("../tools/account-switch/SwitcherPanel.vue"),
};
