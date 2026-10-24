/**
 * 等待 tab 加载完成的共享工具
 * 带超时上限：超时后清理事件监听并报「页面加载超时」，
 * 页面被拦截（chrome:// 等受限页）或 tab 被关闭时立即报明确错误，
 * 避免「正在登录...」永远转圈。
 * 所有失败均抛出带错误码的 LoginError。
 */

import { ErrorCodes, LoginError } from "./error-codes";

/** 等待页面加载的默认超时时间（毫秒） */
export const DEFAULT_TAB_LOAD_TIMEOUT = 15000;

/** 浏览器内部/扩展页面的受限 scheme，无法注入脚本执行登录操作 */
export const RESTRICTED_PAGE_SCHEME =
  /^(chrome|edge|about|opera|brave|vivaldi|devtools|view-source|chrome-extension|moz-extension|safari-web-extension|chrome-search|chrome-untrusted):/i;

/**
 * 等待指定 tab 加载完成（监听 onUpdated 的 'complete' 状态事件）。
 *
 * - tab 已加载完成时直接返回
 * - 受限页面（chrome:// 等）立即抛出明确错误
 * - tab 被关闭时提前抛出错误
 * - 超时后抛出错误并清理所有事件监听，不泄漏
 */
export async function waitForTabLoaded(
  tabId: number,
  timeoutMs: number = DEFAULT_TAB_LOAD_TIMEOUT,
): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new LoginError(
      ErrorCodes.TAB_CLOSED,
      "目标页面不存在或已关闭，无法继续登录",
    );
  }

  const url = tab.pendingUrl || tab.url || "";
  if (url && RESTRICTED_PAGE_SCHEME.test(url)) {
    const scheme = url.slice(0, url.indexOf(":"));
    throw new LoginError(
      ErrorCodes.TAB_RESTRICTED,
      `页面地址受限 (${scheme}://)，无法在此页面执行登录操作`,
    );
  }

  if (tab.status === "complete") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      done();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new LoginError(
            ErrorCodes.TAB_LOAD_TIMEOUT,
            `页面加载超时 (${timeoutMs}ms)`,
          ),
        ),
      );
    }, timeoutMs);

    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        settle(resolve);
      }
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        settle(() =>
          reject(new LoginError(ErrorCodes.TAB_CLOSED, "页面已关闭，登录中断")),
        );
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // 关闭竞态：页面可能在前置 status 检查与注册监听之间已完成加载，
    // 注册后复查一次，避免空等到超时。
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") {
          settle(resolve);
        }
      })
      .catch(() => {
        settle(() =>
          reject(
            new LoginError(
              ErrorCodes.TAB_CLOSED,
              "目标页面不存在或已关闭，无法继续登录",
            ),
          ),
        );
      });
  });
}

/**
 * 刷新 tab 并等待**刷新后**的页面加载完成。
 *
 * 与 `waitForTabLoaded` 的区别：`chrome.tabs.reload()` 的 Promise 只代表
 * 「刷新已发起」，紧接着 `tabs.get()` 读到仍可能是旧文档的 `complete`——
 * 直接复用 `waitForTabLoaded` 会立即返回，等待形同虚设。因此监听器必须在
 * 调用 reload **之前**注册，只认随后到达的 `complete`。
 *
 * 失败语义与 `waitForTabLoaded` 一致：tab 关闭 / 受限页面 / 超时均抛
 * 带错误码的 `LoginError`。
 */
export async function reloadTabAndWait(
  tabId: number,
  timeoutMs: number = DEFAULT_TAB_LOAD_TIMEOUT,
): Promise<void> {
  let url = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.pendingUrl || tab.url || "";
  } catch {
    throw new LoginError(
      ErrorCodes.TAB_CLOSED,
      "目标页面不存在或已关闭，无法继续登录",
    );
  }
  if (url && RESTRICTED_PAGE_SCHEME.test(url)) {
    const scheme = url.slice(0, url.indexOf(":"));
    throw new LoginError(
      ErrorCodes.TAB_RESTRICTED,
      `页面地址受限 (${scheme}://)，无法在此页面执行登录操作`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      done();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new LoginError(
            ErrorCodes.TAB_LOAD_TIMEOUT,
            `页面加载超时 (${timeoutMs}ms)`,
          ),
        ),
      );
    }, timeoutMs);

    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        settle(resolve);
      }
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        settle(() =>
          reject(new LoginError(ErrorCodes.TAB_CLOSED, "页面已关闭，登录中断")),
        );
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    try {
      Promise.resolve(chrome.tabs.reload(tabId)).catch((e: unknown) => {
        settle(() => reject(e));
      });
    } catch (e: unknown) {
      settle(() => reject(e));
    }
  });
}
