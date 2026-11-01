import { ErrorCodes, LoginError } from "../utils/error-codes";
import { normalizedOrigin, originMatches } from "../utils/env";
import type { PagePort } from "./host";

export { normalizedOrigin };

export async function assertPageOnExactOrigin(page: PagePort, expectedOrigin: string): Promise<void> {
  let url = "";
  try {
    url = await page.currentUrl();
  } catch {
    throw new LoginError(ErrorCodes.TAB_CLOSED, "目标页面不存在或已关闭");
  }
  const expected = normalizedOrigin(expectedOrigin);
  const actualOrigin = normalizedOrigin(url);
  if (!expected || !originMatches(expectedOrigin, url)) {
    throw new LoginError(
      ErrorCodes.LOGIN_REJECTED,
      `页面不在目标站点 (${expected || "未知"})，当前 origin 为 ${actualOrigin || "未知"}；已停止登录副作用`,
    );
  }
}
