/**
 * 认证快照原语（ADR-0012 D6 / D7 / D8）
 *
 * 提供 cookie / localStorage / sessionStorage 的 capture / clear / restore。
 * 策略只声明 `AuthSpec`，由引擎调用；策略层不得自行挑 tab 写 storage。
 *
 * ⚠️ 管线不变量（D7）：storage 是 origin 作用域的，必须在对目标 origin 的文档内
 * 写入。`login-tab-flow` 固定序列：
 *   create tab @ targetOrigin → waitForTabLoaded → clear → set storage → reload
 * 在错误的 origin 上写 storage 会抛 `INJECT_AUTH_FAILED`，绝不静默成功。
 */

import type { AuthSpec } from "../strategies/generic-recipe";
import { ErrorCodes, LoginError } from "./error-codes";
import {
  captureHostCookies,
  clearHostCookies,
  type CookieRecord,
} from "./host-cookies";

/** 三态范围归一化后的形式 */
export type Range = "all" | "none" | string[];

export interface AuthSnapshot {
  cookies: CookieRecord[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

/**
 * 登录 origin 上捕获的快照 + 产生它的规格。
 * 引擎在登录完成后由 `auth.capture` 算子捕获，交给 login-tab-flow 在目标 origin 恢复。
 */
export interface CapturedAuth {
  spec: AuthSpec;
  snapshot: AuthSnapshot;
}

function normalizeRange(raw: Range | undefined, fallback: Range): Range {
  if (raw === undefined) return fallback;
  if (raw === "all" || raw === "none") return raw;
  return raw;
}

function _isWildcard(range: Range): boolean {
  return range === "all";
}

/** 把三态范围转成 storage 操作参数：`undefined` = 不清 / 不读，`null` = 全部 */
function storageKeys(range: Range): string[] | null | undefined {
  if (range === "none") return undefined;
  return range === "all" ? null : range;
}

/** 读取当前 tab 文档的 storage（页面内执行） */
async function readStorage(
  tabId: number,
  area: "local" | "session",
  keys: string[] | null,
): Promise<Record<string, string>> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (areaName: string, keyList: string[] | null) => {
      const store = areaName === "local" ? localStorage : sessionStorage;
      const out: Record<string, string> = {};
      const names = keyList ?? Object.keys(store);
      for (const key of names) {
        const value = store.getItem(key);
        if (value !== null) out[key] = value;
      }
      return out;
    },
    args: [area, keys],
  });
  return (results[0]?.result as Record<string, string>) ?? {};
}

async function writeStorage(
  tabId: number,
  area: "local" | "session",
  entries: Record<string, string>,
): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (areaName: string, data: Record<string, string>) => {
      const store = areaName === "local" ? localStorage : sessionStorage;
      for (const [key, value] of Object.entries(data)) store.setItem(key, value);
    },
    args: [area, entries],
  });
}

async function clearStorage(
  tabId: number,
  area: "local" | "session",
  keys: string[] | null,
): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (areaName: string, keyList: string[] | null) => {
      const store = areaName === "local" ? localStorage : sessionStorage;
      if (keyList === null) {
        store.clear();
        return;
      }
      for (const key of keyList) store.removeItem(key);
    },
    args: [area, keys],
  });
}

/** 校验 tab 当前文档确实位于目标 origin（storage 写入的前置条件） */
async function assertTabOnOrigin(tabId: number, origin: string): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new LoginError(ErrorCodes.TAB_CLOSED, "目标页面不存在或已关闭");
  }
  const url = tab.url || tab.pendingUrl || "";
  if (!url.startsWith(origin)) {
    throw new LoginError(
      ErrorCodes.INJECT_AUTH_FAILED,
      `无法写入认证数据：页面不在目标站点 (${origin})，当前为 ${url || "未知"}。` +
        "localStorage 属于 origin 作用域，必须先导航到目标站点再写入",
    );
  }
}

/** 快照规格：把 AuthSpec 归一为三态（缺省值见 ADR-0012 D6/D8） */
export function normalizeSnapshotSpec(spec: AuthSpec): {
  cookies: Range;
  cookiesClear: Range;
  localStorage: Range;
  sessionStorage: Range;
} | null {
  if (spec.mode !== "snapshot") return null;
  return {
    cookies: normalizeRange(spec.cookies, "none"),
    // 默认「全部（精确 host）」：换号必须清干净（P0-6）
    cookiesClear: normalizeRange(spec.cookiesClear, "all"),
    localStorage: normalizeRange(spec.localStorage, "none"),
    sessionStorage: normalizeRange(spec.sessionStorage, "none"),
  };
}

/**
 * 捕获：按规格读取 cookie 与 storage。
 * storage 只能在当前 tab 文档内读取，调用方需保证 tab 位于目标 origin。
 */
export async function captureAuth(
  origin: string,
  tabId: number,
  spec: AuthSpec,
): Promise<AuthSnapshot> {
  const ranges = normalizeSnapshotSpec(spec);
  if (!ranges) return { cookies: [] };

  const cookieNames = storageKeys(ranges.cookies);
  const snapshot: AuthSnapshot = {
    cookies:
      cookieNames === undefined
        ? []
        : await captureHostCookies(
            origin,
            cookieNames === null ? undefined : cookieNames,
          ),
  };

  const localKeys = storageKeys(ranges.localStorage);
  if (localKeys !== undefined) {
    snapshot.localStorage = await readStorage(tabId, "local", localKeys);
  }
  const sessionKeys = storageKeys(ranges.sessionStorage);
  if (sessionKeys !== undefined) {
    snapshot.sessionStorage = await readStorage(tabId, "session", sessionKeys);
  }
  return snapshot;
}

/** 清除：按规格清理 cookie 与 storage（换号前置）。 */
export async function clearAuth(
  origin: string,
  tabId: number,
  spec: AuthSpec,
  options: { includeParent?: boolean } = {},
): Promise<void> {
  const ranges = normalizeSnapshotSpec(spec);
  if (!ranges) return;

  if (ranges.cookiesClear === "all") {
    await clearHostCookies(origin, {
      includeParent: options.includeParent,
    });
  } else if (ranges.cookiesClear !== "none") {
    await clearHostCookies(origin, { names: ranges.cookiesClear });
  }

  const localKeys = storageKeys(ranges.localStorage);
  if (localKeys !== undefined) {
    await assertTabOnOrigin(tabId, origin);
    await clearStorage(tabId, "local", localKeys);
  }
  const sessionKeys = storageKeys(ranges.sessionStorage);
  if (sessionKeys !== undefined) {
    await assertTabOnOrigin(tabId, origin);
    await clearStorage(tabId, "session", sessionKeys);
  }
}

/**
 * 恢复：把快照写回目标 origin。
 * cookie 保留 domain / path / secure / sameSite / expirationDate 等属性；
 * storage 必须在目标 origin 的文档内写入（D7），否则报 INJECT_AUTH_FAILED。
 */
export async function restoreAuth(
  origin: string,
  tabId: number,
  spec: AuthSpec,
  snapshot: AuthSnapshot,
): Promise<void> {
  const ranges = normalizeSnapshotSpec(spec);
  if (!ranges) return;

  for (const cookie of snapshot.cookies) {
    const details: chrome.cookies.SetDetails = {
      url: `${cookie.secure ? "https" : "http"}://${origin.replace(/^https?:\/\//, "").replace(/\/$/, "")}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite as chrome.cookies.SameSiteStatus | undefined,
    };
    if (!cookie.session && cookie.expirationDate !== undefined) {
      details.expirationDate = cookie.expirationDate;
    }
    await chrome.cookies.set(details);
  }

  if (snapshot.localStorage && ranges.localStorage !== "none") {
    await assertTabOnOrigin(tabId, origin);
    await writeStorage(tabId, "local", snapshot.localStorage);
  }
  if (snapshot.sessionStorage && ranges.sessionStorage !== "none") {
    await assertTabOnOrigin(tabId, origin);
    await writeStorage(tabId, "session", snapshot.sessionStorage);
  }
}
