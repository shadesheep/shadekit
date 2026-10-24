/**
 * LoginSpec 跨 origin 快照算子（ADR-0015 D1）— `auth.capture` /
 * `auth.restore`，由 `runSpec` 按声明顺序执行。
 *
 * - `auth.capture`：在**登录 origin**捕获 cookie 与 storage（范围由算子参数
 *   声明），结果 `{ origin, cookies, localStorage?, sessionStorage? }` 进入绑定。
 * - `auth.restore`：消费捕获结果，在**目标 origin 的当前文档内**恢复——先按
 *   快照自带的范围清理同一批键，再写回。storage 是 origin 作用域的，必须在
 *   目标 origin 的文档内写入；origin 不符报 `INJECT_AUTH_FAILED`，绝不静默
 *   写错 origin（延续 ADR-0012 D7 的硬约束）。
 *
 * cookie 由 domain 决定归属，不依赖 tab 所在 origin；storage 的清理与写回
 * 都必须发生目标 origin 文档内。
 *
 * 本模块只依赖浏览器 API，以 spec 算子为 seam 可单测。
 */

import type { CookieRecord } from "../utils/host-cookies";
import { captureHostCookies, clearHostCookies } from "../utils/host-cookies";
import { ErrorCodes, LoginError } from "../utils/error-codes";
import type { AuthRange } from "../strategies/generic-recipe";
import type { SpecOp } from "./types";

/** `auth.capture` 的完整声明形状 */
export type AuthCaptureOp = Extract<SpecOp, { op: "auth.capture" }>;

/** `auth.restore` 的完整声明形状 */
export type AuthRestoreOp = Extract<SpecOp, { op: "auth.restore" }>;

/** 捕获结果（进入绑定 `$<as>`；`origin` 为捕获/恢复的目标 origin） */
export interface CapturedSnapshot {
  origin: string;
  cookies: CookieRecord[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

/** 三态范围 → storage 操作参数：`undefined` = 不够建读，`null` = 全部 */
function storageKeys(range: AuthRange): string[] | null | undefined {
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

/** 清除指定 storage 区内的键（`null` = 全部） */
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

/** 写回指定 storage 区 */
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

/** 校验 tab 当前文档确实位于目标 origin（storage 读写的前置条件） */
async function assertTabOnOrigin(tabId: number, origin: string): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new LoginError(ErrorCodes.TAB_CLOSED, "目标页面不存在或已关闭");
  }
  const url = tab.url || tab.pendingUrl || "";
  // origin 边界必须精确匹配（含端口），不能用 startsWith——
  // 避免 `https://a.com` 把 `https://a.com.evil.org` 也当成目标站点
  const originOf = (u: string): string => {
    try {
      return new URL(u).origin;
    } catch {
      return "";
    }
  };
  if (originOf(url) !== originOf(origin)) {
    throw new LoginError(
      ErrorCodes.INJECT_AUTH_FAILED,
      `无法写入认证数据：页面不在目标站点 (${origin})，当前为 ${url || "未知"}。` +
        "localStorage 属于 origin 作用域，必须先导航到目标站点再写入",
    );
  }
}

/**
 * 执行 `auth.capture`：在登录 origin 捕获会话。
 * cookie 按声明范围捕获；storage 只在声明的区内列表（none 不读）。
 */
export async function runAuthCapture(
  tabId: number,
  origin: string,
  op: AuthCaptureOp,
): Promise<CapturedSnapshot> {
  const cookiesRange = op.cookies ?? "none";
  const snapshot: CapturedSnapshot = {
    origin,
    cookies:
      cookiesRange === "none"
        ? []
        : await captureHostCookies(
            origin,
            cookiesRange === "all" ? undefined : cookiesRange,
          ),
  };

  const localKeys = storageKeys(op.localStorage ?? "none");
  if (localKeys !== undefined) {
    snapshot.localStorage = await readStorage(tabId, "local", localKeys);
  }
  const sessionKeys = storageKeys(op.sessionStorage ?? "none");
  if (sessionKeys !== undefined) {
    snapshot.sessionStorage = await readStorage(tabId, "session", sessionKeys);
  }
  return snapshot;
}

/**
 * 执行 `auth.restore`：在目标 origin 的当前文档内恢复。
 *
 * 顺序：先按快照自带的范围清理同一批键，再写回。
 * - cookie 不限 tab origin（domain 决定归属），但「清理再写」保证幂等
 * - storage 必须先通过 origin 校验再清理与写回，否则报 `INJECT_AUTH_FAILED`
 */
export async function runAuthRestore(
  tabId: number,
  snapshot: CapturedSnapshot,
): Promise<void> {
  const { origin } = snapshot;

  // —— 清理：cookie 只清快照捕获到的同名键（其 domain 归属 target host）——
  const cookieNames = snapshot.cookies.map((c) => c.name);
  if (cookieNames.length > 0) {
    await clearHostCookies(origin, { names: cookieNames });
  }

  // storage 是 origin 作用域：读写都必须在目标 origin 的文档内。无论快照里
  // 是否真的抓到键，只要捕获时声明了 storage（字段存在），恢复就必须先校验
  // 当前 tab 位于目标 origin——声明了却一空（或非空）都不静默写错 origin。
  const declaredStorage =
    snapshot.localStorage !== undefined ||
    snapshot.sessionStorage !== undefined;
  if (declaredStorage) await assertTabOnOrigin(tabId, origin);

  // —— 写回 cookie（保留 domain / path / secure / httpOnly / sameSite / 过期）——
  for (const cookie of snapshot.cookies) {
    const details: chrome.cookies.SetDetails = {
      url: `${cookie.secure ? "https" : "http"}://${origin.replace(/^https?:\/\//, "").replace(/\/$/, "")}${cookie.path ?? "/"}`,
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

  // —— 写回 storage：先清同一批键，再写（等价于恢复到捕获前状态）——
  if (snapshot.localStorage !== undefined) {
    await clearStorage(tabId, "local", Object.keys(snapshot.localStorage));
    await writeStorage(tabId, "local", snapshot.localStorage);
  }
  if (snapshot.sessionStorage !== undefined) {
    await clearStorage(tabId, "session", Object.keys(snapshot.sessionStorage));
    await writeStorage(tabId, "session", snapshot.sessionStorage);
  }
}

/** 运行时形状守卫：判断绑定值是否为合法的 `auth.capture` 产出 */
export function isCapturedSnapshot(value: unknown): value is CapturedSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.origin !== "string") return false;
  if (!Array.isArray(v.cookies)) return false;
  if (
    v.localStorage !== undefined &&
    (typeof v.localStorage !== "object" || v.localStorage === null)
  ) {
    return false;
  }
  if (
    v.sessionStorage !== undefined &&
    (typeof v.sessionStorage !== "object" || v.sessionStorage === null)
  ) {
    return false;
  }
  return true;
}