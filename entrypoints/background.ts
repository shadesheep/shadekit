import { defineBackground } from 'wxt/utils/define-background';
import { authLog } from './shared/logger';
import { sendContentMessage } from './shared/messages';
import { getConfig, initConfig } from './shared/tool-config';
import {
  buildMessageRouteTable,
  createBackgroundMessageListener,
} from './shared/message-router';
import { allTools } from './shared/tool-definitions';
import { ErrorCodes, buildErrorDetail } from './tools/account-switch/utils/error-codes';
import type { AccountSwitchConfig } from './tools/account-switch/types';

export default defineBackground({
  main() {
    // 注意:快捷键无法零交互强制注册。
    // - manifest suggested_key 仅在安装时且无冲突时生效(冲突会静默失败);
    // - chrome.commands.update 需要 Chrome 131+,Edge 当前(151)未实现,且
    //   只能覆盖非用户显式设置的快捷键。
    // 因此这里不做"自动注册",未生效时由选项页检测并引导用户(见 account-switch Config.vue 快捷键状态块)。

    chrome.runtime.onInstalled.addListener(async (details) => {

      // 首次安装：打开选项页引导配置（定位到账号切换）
      if (details.reason === 'install') {
        chrome.tabs.create({
          url: chrome.runtime.getURL('options.html?section=account-switch'),
        });
      }
    });

    // 初始化默认配置：任一步失败只记日志，不阻塞启动。
    void initToolDefaults();

    // 注册右键菜单
    void registerContextMenus();

    // 注册快捷键监听
    chrome.commands.onCommand.addListener(async (command) => {
      if (command === 'open-account-switcher') {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) return;
        try {
          // 尝试获取页面选中文本
          const [{ result: selectedText }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.getSelection()?.toString().trim() || '',
          });

          if (selectedText) {
            // 有选中文本，尝试快捷登录
            await handleQuickLoginFromSelection(selectedText, tab.id, tab.url || '');
          } else {
            // 无选中文本，打开账号切换面板
            await sendContentMessage(tab.id, 'OPEN_ACCOUNT_SWITCHER');
          }
        } catch {
          // Content script may not be available on this tab (e.g. chrome://, about:blank)
          // 回退到发送消息打开面板
          try {
            await sendContentMessage(tab.id!, 'OPEN_ACCOUNT_SWITCHER');
          } catch {
            // 受限页面（chrome://、扩展商店、空白页等）无法注入，明确告知用户
            // 附错误码，便于反馈定位
            chrome.notifications.create({
              type: 'basic',
              iconUrl: chrome.runtime.getURL('logo_48.png'),
              title: 'ShadeKit',
              message: `此页面不支持账号切换（浏览器内置页面），请在目标系统页面上使用 [${ErrorCodes.TAB_RESTRICTED}]`,
            });
            // 非 dev 模式也可事后查日志定位（最小失败摘要）
            void authLog.error(
              `快捷打开账号切换失败 [${ErrorCodes.TAB_RESTRICTED}] 页面地址受限，无法注入`,
              {
                extra: {
                  action: 'OPEN_ACCOUNT_SWITCHER',
                  errorCode: ErrorCodes.TAB_RESTRICTED,
                  url: tab.url,
                  failureSummary: true,
                },
              },
            );
          }
        }
      }
    });

    // 注册表驱动的消息路由：按消息 type 全局路由（ADR-0003 D1）。
    // 建表时校验 type 唯一性，冲突立即抛错（fail fast）。
    // 监听回调工厂见 message-router.ts（round-trip 测试 seam）。
    const routeTable = buildMessageRouteTable(allTools);
    chrome.runtime.onMessage.addListener(
      createBackgroundMessageListener(routeTable, { openToolTab }),
    );

    // 处理右键菜单点击
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      const menuId = info.menuItemId;
      const selectedText = info.selectionText || '';

      if (menuId === 'json-formatter-context') {
        await openToolTab('json-formatter', { text: selectedText });
      } else if (menuId === 'json-diff-context') {
        await openToolTab('json-diff', { left: selectedText });
      } else if (menuId === 'quick-login-selection' && tab?.id) {
        await handleQuickLoginFromSelection(selectedText, tab.id, tab.url || '');
      }
    });
  },
});

/**
 * 根据 selectedText 打开工具标签页
 * @param toolId 工具 ID
 * @param params 通过 URL 参数传递的数据
 * @param forceNew 强制新开标签页（跳过复用逻辑，如 popup 中键点击）
 */
async function openToolTab(
  toolId: string,
  params: Record<string, string> = {},
  forceNew = false,
): Promise<void> {
  const tool = allTools.find((t) => t.id === toolId);
  if (!tool?.openInTab) return;

  // 读取 allowMultiple 配置
  const config = await getConfig<Record<string, unknown>>(toolId);
  const allowMultiple =
    (config?.allowMultiple as boolean) ?? tool.openInTab.allowMultiple ?? false;

  // 构建 URL（带参数）
  let url = chrome.runtime.getURL(tool.openInTab.url);
  const paramEntries = Object.entries(params).filter(([, v]) => v);
  if (paramEntries.length > 0) {
    const query = new URLSearchParams(
      paramEntries.map(([k, v]) => [k, encodeURIComponent(v)]),
    ).toString();
    url += `?${query}`;
  }

  if (!allowMultiple && !forceNew) {
    // 查找已打开的同工具标签页
    const tabs = await chrome.tabs.query({ url });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id!, { active: true });
      return;
    }
    // 更宽松的匹配：仅匹配基础 URL
    const allTabs = await chrome.tabs.query({});
    const existing = allTabs.find((t) => t.url?.startsWith(url.split('?')[0]));
    if (existing) {
      await chrome.tabs.update(existing.id!, { active: true });
      // 更新 URL 以传递新参数
      await chrome.tabs.update(existing.id!, { url });
      return;
    }
  }

  await chrome.tabs.create({ url });
}

/**
 * 注册右键菜单
 */
async function registerContextMenus() {
  // 先清除已存在的菜单项，避免热重载时重复创建
  chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: 'json-formatter-context',
    title: '用 JSON 格式化',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'json-diff-context',
    title: '用 JSON 对比（填入左侧）',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'quick-login-selection',
    title: '快捷登录',
    contexts: ['selection'],
  });
}

async function initToolDefaults() {
  for (const tool of allTools) {
    if (tool.defaultConfig) {
      await initConfig(tool.id, tool.defaultConfig);
    }
  }
}

/**
 * 从选中文本解析登录信息并执行快捷登录（新标签页模式）
 */
async function handleQuickLoginFromSelection(
  selectedText: string,
  tabId: number,
  _pageUrl: string,
): Promise<void> {
  const { parseLoginText } = await import(
    './tools/account-switch/utils/parse-text'
  );
  const { handleQuickLoginInNewTab } = await import(
    './tools/account-switch/background-handler'
  );
  const { showPageToast } = await import(
    './tools/account-switch/utils/show-page-toast'
  );
  const { LOGIN_BUSY_ERROR } = await import(
    './tools/account-switch/utils/error-codes'
  );

  // 读取配置
  const asConfig = await getConfig<AccountSwitchConfig>(
    'account-switch',
  );
  const defaultDomain = asConfig?.quickLoginDefaultDomain || '';

  // 尝试解析选中文本
  const parsed = parseLoginText(selectedText, defaultDomain);
  if (!parsed) {
    // 无法解析，回退到打开面板
    try {
      await sendContentMessage(tabId, 'OPEN_ACCOUNT_SWITCHER');
    } catch {
      // ignore
    }
    return;
  }

  if (!parsed.url && !defaultDomain) {
    // 无 URL 且无默认域名，回退到打开面板
    try {
      await sendContentMessage(tabId, 'OPEN_ACCOUNT_SWITCHER');
    } catch {
      // ignore
    }
    return;
  }

  // 环境匹配与密码回退收口至 Account View Model(resolveEnvironment / resolvePassword)
  const { resolveEnvironment, resolvePassword } = await import(
    './tools/account-switch/account-view'
  );
  let matchedDebugRedirect: string | undefined;
  let matchedDefaultPassword: string | undefined;
  if (asConfig?.domains) {
    try {
      const checkOrigin = parsed.hasUrl
        ? new URL(parsed.url).origin
        : new URL(defaultDomain).origin;
      const resolved = resolveEnvironment(checkOrigin, asConfig.domains);
      if (resolved) {
        if (resolved.env.debugRedirect && resolved.env.debugRedirectEnabled) {
          matchedDebugRedirect = resolved.env.debugRedirect;
        }
        if (resolved.env.defaultPassword) {
          matchedDefaultPassword = resolved.env.defaultPassword;
        }
      }
    } catch {
      // 忽略 URL 解析失败
    }
  }

  // 显示「正在登录」提示
  showPageToast(tabId, '正在登录...', 'info', 0);

  // 在新标签页执行快捷登录
  // 密码优先级与面板路径一致（resolvePassword）：文本输入 > 环境默认密码 > 全局默认密码
  const password = resolvePassword({
    input: parsed.password,
    envDefault: matchedDefaultPassword,
    globalDefault: asConfig?.globalDefaultPassword,
  });
  if (!password) {
    showPageToast(tabId, '未找到可用密码：请在文本中包含密码，或配置环境/全局默认密码', 'error', 5000);
    return;
  }
  const result = await handleQuickLoginInNewTab(
    parsed.url,
    parsed.username,
    password,
    parsed.hasUrl,
    matchedDebugRedirect,
    tabId,
  );

  if (result.success) {
    // 通知用户已在新标签页打开
    showPageToast(tabId, `已以 ${parsed.username} 登录成功`, 'success', 4000);
  } else if (result.error === LOGIN_BUSY_ERROR) {
    // 并发互斥拒绝是「忙碌」而非失败
    showPageToast(tabId, result.error!, 'info', 3000);
  } else {
    // 页面内 Toast 附「复制详情」按钮：错误码 + 上下文一键复制
    const code = result.errorCode ?? ErrorCodes.UNKNOWN;
    const detail = buildErrorDetail(code, result.error || '未知错误', {
      action: 'QUICK_LOGIN_NEW_TAB',
      origin: parsed.url,
      username: parsed.username,
      recipeSteps: result.recipeSteps,
    });
    showPageToast(tabId, `登录失败：${result.error || '未知错误'} [${code}]`, 'error', 8000, detail);
  }
}
