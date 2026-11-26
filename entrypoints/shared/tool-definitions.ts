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
      },
    },
    configSection: {
      id: "account-switch",
      label: "环境与账号",
      icon: "i-lucide-user-cog",
    },
    backgroundHandlers: {
      GET_ACCOUNT_PANEL: async (_msg, sender) => {
        const { handleGetAccountPanel } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleGetAccountPanel(sender);
      },
      SWITCH_ACCOUNT: async (msg, sender) => {
        // 委托给 background.ts 的主逻辑处理
        const { handleSwitchAccount } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleSwitchAccount(msg.accountId, msg.environmentId, sender);
      },
      REQUEST_ENVIRONMENT_PERMISSIONS: async (msg) => {
        const { requestEnvironmentPermissions } = await import("../tools/account-switch/permissions/permission-gateway");
        try {
          await requestEnvironmentPermissions(msg.environmentId);
          return { success: true };
        } catch (error) {
          const { errorCodeOf } = await import("../tools/account-switch/utils/error-codes");
          return { success: false, error: error instanceof Error ? error.message : "权限申请失败", errorCode: errorCodeOf(error) };
        }
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
      ACCOUNT_CONFIG_GET: async () => {
        const { handleAccountConfigGet } = await import("../tools/account-switch/config-background-handler");
        return handleAccountConfigGet();
      },
      ACCOUNT_CONFIG_SAVE: async (msg) => {
        const { handleAccountConfigSave } = await import("../tools/account-switch/config-background-handler");
        return handleAccountConfigSave(msg.patch);
      },
      BACKUP_EXPORT: async () => {
        const { handleBackupExport } = await import("../tools/account-switch/config-background-handler");
        return handleBackupExport();
      },
      BACKUP_PREPARE: async (msg) => {
        const { handleBackupPrepare } = await import("../tools/account-switch/config-background-handler");
        return handleBackupPrepare(msg.text);
      },
      BACKUP_CONFIRM: async (msg) => {
        const { handleBackupConfirm } = await import("../tools/account-switch/config-background-handler");
        return handleBackupConfirm(msg.acceptPlaintextWarning);
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
      LOCK_LOGIN_FORM: async (msg) => {
        const { handleLockLoginForm } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleLockLoginForm({
          operationId: msg.operationId,
          envKey: msg.envKey,
          expectedSpec: msg.expectedSpec,
          tabId: msg.tabId,
        });
      },
      // 动态导入：本注册表被 popup/options/content 共用，静态导入会把
      // background 专用依赖树打进所有 bundle（同其余 handler 的既有模式）。
      OPEN_ACCOUNT_SETTINGS: async () => {
        const { handleOpenAccountSettings } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleOpenAccountSettings();
      },
      OPEN_ACCOUNT_ENVIRONMENT: async (msg) => {
        const { handleOpenAccountEnvironment } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleOpenAccountEnvironment(msg.envKey);
      },
      TRIAL_SAVED_ACCOUNT: async (msg) => {
        const { handleTrialSavedAccount } = await import(
          "../tools/account-switch/background-handler"
        );
        return handleTrialSavedAccount(msg.accountId, msg.environmentId);
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
    name: "JSON / 文本对比",
    description: "JSON 语义对比与文本差异高亮，支持差异导航和 JSON Patch 导出",
    icon: "i-lucide-git-compare",
    enabledByDefault: true,
    openInTab: { url: "json-diff.html", allowMultiple: false },
    configSection: {
      id: "json-diff",
      label: "JSON / 文本对比",
      icon: "i-lucide-git-compare",
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
