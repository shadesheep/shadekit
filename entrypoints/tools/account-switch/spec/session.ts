/**
 * LoginSpec 会话算子（ADR-0015 D7）— 清理与写会话，由 `runSpec` 按声明顺序执行。
 *
 * - `clear.cookies`：三态范围 `all | none | string[]` + `includeParent`
 * - `clear.storage`：local / session 两区，三态范围
 * - `auth.write`：按 `AuthSpec` 的写入声明落库（cookie + storage）
 *
 * cookie 写入参数化 `setCookie`（`auth-storage.ts` 的 host-only 版本）：
 * `domain` / `path` / `secure(auto)` / `httpOnly` / `sameSite` / `expiresFrom`。
 * `sameSite` 缺省 `unspecified`——不写该属性，保持历史登录的 cookie 行为。
 *
 * storage 写入必须在目标 origin 的文档内执行（D7）；origin 不符报
 * `INJECT_AUTH_FAILED`，绝不静默写错 origin。
 *
 * 本模块只依赖浏览器 API 与纯函数，以 spec 算子为 seam 可单测。
 */

import { ErrorCodes, LoginError } from "../utils/error-codes";
import { clearHostCookies } from "../utils/host-cookies";
import type { AuthRange } from "../strategies/generic-recipe";
import { readBindingPath, resolveTemplate, TemplateError } from "./template";
import type { AuthSpec, CookieWrite, StorageWrite } from "./types";

// ============================================================
// clear.cookies
// ============================================================

export interface ClearCookiesOp {
  range: AuthRange;
  includeParent?: boolean;
}

/**
 * 按三态范围清除 cookie。`includeParent` 对 `all` 与 `string[]` 都生效
 * （白名单语义下父域由名单 + 该 flag 共同决定）。
 */
export async function runClearCookies(
  origin: string,
  op: ClearCookiesOp,
): Promise<number> {
  if (op.range === "none") return 0;
  return clearHostCookies(origin, {
    ...(op.range === "all" ? {} : { names: op.range }),
    includeParent: op.includeParent === true,
  });
}

// ============================================================
// clear.storage
// ============================================================

export interface ClearStorageOp {
  area: "local" | "session";
  range: AuthRange;
}

/** 清除指定 storage 区（在目标 origin 文档内执行）。 */
export async function runClearStorage(
  tabId: number,
  op: ClearStorageOp,
): Promise<void> {
  if (op.range === "none") return;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (areaName: string, range: string | string[]) => {
      const store = areaName === "local" ? localStorage : sessionStorage;
      if (range === "all") {
        store.clear();
        return;
      }
      for (const key of range) store.removeItem(key);
    },
    args: [op.area, op.range],
  });
}

// ============================================================
// auth.write（D7）
// ============================================================

/** 模板上下文：`auth.write` 只引用绑定与输入，不产出绑定。 */
export interface AuthWriteState {
  inputs: Record<string, unknown>;
  bindings: Record<string, unknown>;
}

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

/** cookie 写入地址：`domain` 缺省 host-only；否则用 `scheme://domain path`。 */
function cookieUrl(
  origin: string,
  write: Pick<CookieWrite, "domain" | "path">,
): string {
  const hostname = new URL(origin).hostname;
  const domain = write.domain ? write.domain.replace(/^\./, "") : hostname;
  const path = write.path ?? "/";
  const secure = new URL(origin).protocol === "https:";
  return `http${secure ? "s" : ""}://${domain}${path}`;
}

/** 把 `expiresFrom` 解析成 `expirationDate`（epoch 秒）。 */
function resolveExpiration(ctx: AuthWriteState, write: CookieWrite): number | undefined {
  if (!write.expiresFrom) return undefined;
  const { from, path, unit } = write.expiresFrom;
  const { found, value } = readBindingPath(ctx.bindings[from], path);
  if (!found) {
    throw new LoginError(
      ErrorCodes.LOGIN_REJECTED,
      `cookie "${write.name}" 的过期时间来源 $${from}.${path} 不存在`,
    );
  }
  const raw = value as number;
  switch (unit) {
    case "epochMs":
      // epochMs → epoch 秒；不规整为整数（毫秒级精度）
      return raw / 1000;
    case "epochS":
      return raw;
    case "iso": {
      const ms = new Date(String(value)).getTime();
      if (Number.isNaN(ms)) {
        throw new LoginError(
          ErrorCodes.LOGIN_REJECTED,
          `cookie "${write.name}" 的过期时间无法解析（${String(value)}）`,
        );
      }
      return ms / 1000;
    }
    case "relativeSeconds":
      return Math.floor(Date.now() / 1000) + Number(value);
  }
}

/** 解析写入值：模板引用 → 字符串。 */
function resolveWriteValue(ctx: AuthWriteState, template: string): string {
  try {
    return resolveTemplate(template, ctx);
  } catch (e) {
    if (e instanceof TemplateError) {
      throw new LoginError(
        e.code === "TEMPLATE_UNRESOLVED"
          ? ErrorCodes.TEMPLATE_UNRESOLVED
          : ErrorCodes.CONFIG_INVALID,
        e.message,
      );
    }
    throw e;
  }
}

/** 写单个 cookie（参数化 setCookie，ADR-0015 D7）。 */
async function writeCookie(ctx: AuthWriteState, write: CookieWrite, origin: string): Promise<void> {
  const value = resolveWriteValue(ctx, write.value);
  // `secure` 缺省 "auto"：按 origin 协议推导（https → true）
  const secure =
    write.secure === undefined || write.secure === "auto"
      ? new URL(origin).protocol === "https:"
      : write.secure;
  const details: chrome.cookies.SetDetails = {
    url: cookieUrl(origin, write),
    name: write.name,
    value,
    secure,
  };
  const path = write.path ?? "/";
  if (path) details.path = path;
  if (typeof write.domain === "string") details.domain = write.domain;
  if (write.httpOnly !== undefined) details.httpOnly = write.httpOnly;
  // sameSite 缺省 unspecified：不写该属性（金标准 byte 级一致）
  if (write.sameSite && write.sameSite !== "unspecified") {
    details.sameSite = write.sameSite as chrome.cookies.SameSiteStatus;
  }
  const expirationDate = resolveExpiration(ctx, write);
  if (expirationDate !== undefined) details.expirationDate = expirationDate;
  await chrome.cookies.set(details);
}

/** 写 storage 条目（目标 origin 文档内）。 */
async function writeStorage(
  tabId: number,
  area: "local" | "session",
  entries: StorageWrite[],
  state: AuthWriteState,
): Promise<void> {
  if (entries.length === 0) return;
  const data: Record<string, string> = {};
  for (const entry of entries) data[entry.key] = resolveWriteValue(state, entry.value);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (areaName: string, items: Record<string, string>) => {
      const store = areaName === "local" ? localStorage : sessionStorage;
      for (const [key, value] of Object.entries(items)) store.setItem(key, value);
    },
    args: [area, data],
  });
}

/**
 * 执行 `auth.write`：按 `AuthSpec` 写入 cookie 与 storage。
 *
 * - `mode: "page"` 是空操作（页面自管会话，引擎不写——D7）
 * - cookie 写入不需要目标 origin 校验（cookie 由 domain 决定归属）
 * - storage 写入必须在目标 origin 文档内；origin 不符报 `INJECT_AUTH_FAILED`
 */
export async function runAuthWrite(
  tabId: number,
  origin: string,
  auth: AuthSpec,
  state: AuthWriteState,
): Promise<void> {
  if (auth.mode === "page") return;

  const cookies = auth.cookiesWrite ?? [];
  for (const write of cookies) {
    await writeCookie(state, write, origin);
  }

  const local = auth.localStorageWrite ?? [];
  const session = auth.sessionStorageWrite ?? [];
  if (local.length > 0 || session.length > 0) {
    // storage 写入前校验 tab 位于目标 origin（不静默写错）
    await assertTabOnOrigin(tabId, origin);
  }
  if (local.length > 0) await writeStorage(tabId, "local", local, state);
  if (session.length > 0) await writeStorage(tabId, "session", session, state);
}