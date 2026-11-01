import { ErrorCodes, LoginError } from "../utils/error-codes";
import { normalizedOrigin, originMatches } from "../utils/env";

export { normalizedOrigin };

/** 在实际页面/会话副作用前重新读取 tab，拒绝异步导航后的 origin 漂移。 */
export async function assertTabOnExactOrigin(
  tabId: number,
  expectedOrigin: string,
): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new LoginError(ErrorCodes.TAB_CLOSED, "目标页面不存在或已关闭");
  }
  const url = tab.pendingUrl || tab.url || "";
  const actualOrigin = normalizedOrigin(url);
  const expected = normalizedOrigin(expectedOrigin);
  if (!expected || !originMatches(expectedOrigin, url)) {
    throw new LoginError(
      ErrorCodes.LOGIN_REJECTED,
      `页面不在目标站点 (${expected || "未知"})，当前 origin 为 ${actualOrigin || "未知"}；已停止登录副作用`,
    );
  }
}
