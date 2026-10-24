import type { ToolDefinition } from "./types";

/**
 * 所有工具的统一注册表
 * popup 组件 → popup/tools/{tool_id}/Popup.vue
 * 配置组件 → tools/{tool_id}/Config.vue
 * content script → content/tools/{tool-id}.vue
 */
export const allTools: ToolDefinition[] = [
  {
    id: "account-switch",
    name: "环境与账号",
    description: "快速切换测试账号，支持多环境多角色",
    icon: "i-lucide-user-cog",
    enabledByDefault: true,
    popupAction: { label: "环境与账号" },
    contentScript: {
      inject: true,
      panel: {
        title: "账号切换",
        component: () => import("../tools/account-switch/SwitcherPanel.vue"),
      },
    },
    configSection: {
      id: "account-switch",
      label: "环境与账号",
      icon: "i-lucide-user-cog",
      component: () => import("../tools/account-switch/Config.vue"),
    },
    backgroundHandlers: {
      SWITCH_ACCOUNT: async (msg, sender) => {
        // 委托给 background.ts 的主逻辑处理
        const { handleSwitchAccount } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleSwitchAccount(msg.account, msg.domain, sender);
      },
      QUICK_LOGIN: async (msg, sender) => {
        const { handleQuickLogin } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleQuickLogin(
          msg.url,
          msg.username,
          msg.password,
          msg.hasUrl ?? true,
          sender,
          msg.debugRedirect,
        );
      },
      TEST_RECIPE: async (msg, sender) => {
        const { handleTestRecipe } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleTestRecipe(
          msg.recipe,
          msg.origin,
          sender,
          msg.tabId,
          msg.only,
        );
      },
      SCAN_LOGIN_FORM: async (msg, sender) => {
        const { handleScanLoginForm } = await import(
          "../tools/account-switch/background-handler"
        );
        // origin 保留在协议里（发送方按目标环境挑 tab），处理器不需要它
        return handleScanLoginForm(sender, msg.tabId);
      },
      TRIAL_LOGIN: async (msg) => {
        const { handleTrialLogin } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleTrialLogin({
          spec: msg.spec,
          origin: msg.origin,
          username: msg.username,
          password: msg.password,
          writeSession: msg.writeSession,
        });
      },
    },
    defaultConfig: {
      accounts: [],
      domains: {},
      quickLoginDefaultDomain: "",
      // ADR-0017 D1：env-indicator 并入，指示器默认关闭
      envBadge: { enabled: false, position: "bottom-right", whitelist: [] },
    },
  },
  {
    id: "json-formatter",
    name: "JSON 格式化",
    description: "JSON 格式化、压缩、排序、校验、JSONPath 查询",
    icon: "i-lucide-braces",
    enabledByDefault: true,
    openInTab: { url: "json-format.html", allowMultiple: false },
    configSection: {
      id: "json-formatter",
      label: "JSON 格式化",
      icon: "i-lucide-braces",
      component: () => import("../tools/json-formatter/Config.vue"),
    },
    defaultConfig: {
      indent: 2,
      nestedEscapeParse: true,
      autoDecode: false,
      jsonLint: true,
      allowMultiple: false,
      autoParseJson: true,
    },
  },
  {
    id: "json-diff",
    name: "JSON 对比",
    description: "左右对比两个 JSON，RFC 6902 标准差异高亮",
    icon: "i-lucide-git-compare",
    enabledByDefault: true,
    openInTab: { url: "json-diff.html", allowMultiple: false },
    configSection: {
      id: "json-diff",
      label: "JSON 对比",
      icon: "i-lucide-git-compare",
      component: () => import("../tools/json-diff/Config.vue"),
    },
    defaultConfig: {
      autoCompare: true,
      debounceMs: 300,
      allowMultiple: false,
    },
  },
  {
    id: "image-base64",
    name: "图片 Base64",
    description: "图片与 Base64 互转，支持上传/粘贴/拖拽/URL",
    icon: "i-lucide-image",
    enabledByDefault: true,
    openInTab: { url: "image-base64.html", allowMultiple: false },
    configSection: {
      id: "image-base64",
      label: "图片 Base64",
      icon: "i-lucide-image",
      component: () => import("../tools/image-base64/Config.vue"),
    },
    defaultConfig: {
      imageFormat: "jpeg",
      imageQuality: 0.92,
      allowMultiple: false,
    },
  },
  {
    id: "code-beautify",
    name: "代码美化",
    description: "JS/CSS/HTML/XML/SQL 代码自动美化，支持自动识别格式",
    icon: "i-lucide-code",
    enabledByDefault: true,
    openInTab: { url: "code-beautify.html", allowMultiple: false },
    configSection: {
      id: "code-beautify",
      label: "代码美化",
      icon: "i-lucide-code",
      component: () => import("../tools/code-beautify/Config.vue"),
    },
    defaultConfig: {
      indentSize: 4,
      showLineNumbers: true,
      allowMultiple: false,
    },
  },
  {
    id: "mock-data",
    name: "模拟数据",
    description:
      "批量生成中文测试数据：人员/企业/招投标字段，JSON/CSV/SQL 导出",
    icon: "i-lucide-dices",
    enabledByDefault: true,
    openInTab: { url: "mock-data.html", allowMultiple: false },
    configSection: {
      id: "mock-data",
      label: "模拟数据",
      icon: "i-lucide-dices",
      component: () => import("../tools/mock-data/Config.vue"),
    },
    defaultConfig: {
      count: 10,
      format: "json",
      viewMode: "card",
      quickCount: 6,
      tablePreviewLimit: 200,
      autoGenerate: true,
      allowMultiple: false,
    },
  },
];

/**
 * 根据 ID 查找工具
 */
export function getToolById(id: string): ToolDefinition | undefined {
  return allTools.find((t) => t.id === id);
}

/**
 * 获取所有工具 ID 列表
 */
export function getAllToolIds(): string[] {
  return allTools.map((t) => t.id);
}
