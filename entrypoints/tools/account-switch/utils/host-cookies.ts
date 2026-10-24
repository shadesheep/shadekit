/**
 * 按 host 清理 cookie。
 *
 * - 默认只清**精确 host** 的 cookie（含 host-only 与 `domain=<host>` 两种写法）
 * - `includeParent: true` 时额外清除父域（如 `example.com`），会波及同域其他登录态，
 *   调用方必须在 UI 明示风险
 * - 不触碰无关 host
 */
import { ErrorCodes, LoginError } from "./error-codes";

/** 完整 Cookie 记录（含属性），供 auth-snapshot 精确恢复 */
export type CookieRecord = chrome.cookies.Cookie;

function getHostname(origin: string): string {
  return new URL(origin).hostname;
}

/** 获取父域名（如 www.example.com → example.com） */
export function getParentDomain(hostname: string): string {
  const parts = hostname.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
}

function buildCookieUrl(hostname: string, secure: boolean, path = "/"): string {
  return `http${secure ? "s" : ""}://${hostname}${path}`;
}

/** 判断 cookie 是否属于目标 host（精确匹配 host-only / domain 写法） */
export function cookieBelongsToHost(
  cookie: Pick<CookieRecord, "domain">,
  hostname: string,
): boolean {
  return (cookie.domain?.replace(/^\./, "") || "") === hostname;
}

/**
 * 枚举 host 上的**全部** cookie。
 *
 * ⚠️ 不能按 `{ url }` 查：Chrome 的 url 过滤只返回「对给定路径生效」的 cookie，
 * 传 origin 等于只看见 `path=/`。会话类 cookie 常挂在站点子路径上（如
 * `sid` / `keepLogin` 写在 `/app/www/`），漏掉它们就等于
 * 没清登录态——旧会话仍在，登录页会直接放行到首页，配方随后在首页上找不到
 * 用户名输入框，报 `ELEMENT_NOT_FOUND`。
 *
 * 因此取全量（`{}` 不受 path / domain 过滤影响），再按「是否对该 host 生效」
 * 过滤：精确同名域 + 命名域 cookie 对其子域生效。用 `{ domain }` 不行——它
 * 只匹配子域，会漏掉挂在祖先域（如 `.example.com`）上的 cookie。
 */
async function getAllForHost(hostname: string): Promise<CookieRecord[]> {
  const cookies = await chrome.cookies.getAll({});
  return cookies.filter((cookie) => {
    const raw = cookie.domain || "";
    const domain = raw.replace(/^\./, "");
    if (domain === hostname) return true;
    // domain cookie 对其子域生效（host-only 的 domain 必然等于 hostname）
    return (cookie.hostOnly === false || raw.startsWith(".")) &&
      hostname.endsWith(`.${domain}`);
  });
}

/**
 * 清除指定 origin 对应 host 的 cookie。
 *
 * @param origin 目标 origin（用于取 hostname）
 * @param options.includeParent 是否包含父域（默认 false，仅精确 host）
 * @param options.names 只清这些名称（白名单）；缺省表示全部
 * @returns 实际删除的 cookie 数量
 */
export async function clearHostCookies(
  origin: string,
  options: { includeParent?: boolean; names?: string[] } = {},
): Promise<number> {
  let hostname: string;
  try {
    hostname = getHostname(origin);
  } catch {
    throw new LoginError(ErrorCodes.INVALID_URL, `无法解析 origin: ${origin}`);
  }
  const allowed = new Set<string>([hostname]);
  if (options.includeParent) {
    allowed.add(getParentDomain(hostname));
  }
  const nameFilter = options.names ? new Set(options.names) : null;

  const cookies = await getAllForHost(hostname);
  let removed = 0;
  for (const cookie of cookies) {
    if (!cookieBelongsToHost(cookie, hostname) && !allowed.has(cookie.domain?.replace(/^\./, "") || "")) {
      continue;
    }
    if (nameFilter && !nameFilter.has(cookie.name)) continue;
    const cookieUrl = buildCookieUrl(
      cookie.domain?.replace(/^\./, "") || hostname,
      cookie.secure,
      cookie.path,
    );
    await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
    removed++;
  }
  return removed;
}

/**
 * 捕获指定 origin 的 cookie（供 auth-snapshot 使用）。
 * `names` 缺省表示全部；枚举口径与 `clearHostCookies` 相同（含子路径）。
 */
export async function captureHostCookies(
  origin: string,
  names?: string[],
): Promise<CookieRecord[]> {
  const hostname = getHostname(origin);
  const cookies = await getAllForHost(hostname);
  if (!names) return cookies;
  const filter = new Set(names);
  return cookies.filter((c) => filter.has(c.name));
}
