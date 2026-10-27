/**
 * 自动登录前的认证存储候选扫描。
 *
 * 页面内只枚举键名；认证键筛选在扩展侧完成，任何存储值都不会离开页面。
 */
export interface AuthStorageSelection {
  local: string[];
  session: string[];
}

const TOKEN_KEY_NAMES = [
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "authToken",
  "auth_token",
  "sessionToken",
  "jwt",
  "Authorization",
] as const;

const RELATED_KEY_NAMES = [
  "expireAt",
  "expiresAt",
  "expireTime",
  "expiration",
  "expiresIn",
  "userInfo",
  "user_info",
  "tokenType",
] as const;

function normalizeAuthStorageKey(key: string): string {
  return key.replace(/[_\-.]/g, "").toLowerCase();
}

const TOKEN_KEYS = Object.fromEntries(
  TOKEN_KEY_NAMES.map((key) => [normalizeAuthStorageKey(key), true]),
) as Record<string, true>;

// 这些键只有与同一 Storage 中的 token 核心键同时出现时才属于认证状态。
const RELATED_KEYS = Object.fromEntries(
  RELATED_KEY_NAMES.map((key) => [normalizeAuthStorageKey(key), true]),
) as Record<string, true>;

/** 未登录配置时的默认可取消候选；只清理明确命名的认证键，不使用 all。 */
export const DEFAULT_AUTH_STORAGE_SELECTION: AuthStorageSelection = {
  local: [...TOKEN_KEY_NAMES, ...RELATED_KEY_NAMES],
  session: [...TOKEN_KEY_NAMES],
};

/** 精确筛选高置信度认证键，不使用 user/profile 等宽泛片段匹配。 */
export function filterAuthStorageKeys(keys: string[]): string[] {
  const normalized = keys.map(normalizeAuthStorageKey);
  const hasToken = normalized.some((key) => TOKEN_KEYS[key] === true);
  return keys.filter((_, index) => {
    const key = normalized[index];
    return TOKEN_KEYS[key] === true || (hasToken && RELATED_KEYS[key] === true);
  });
}

/** 注入 MAIN world 的自包含函数：只调用 Object.keys，绝不读取存储值。 */
export function readAuthStorageKeysInPage(): AuthStorageSelection {
  return {
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  };
}

/**
 * 扫描当前标签页主 frame 的 localStorage / sessionStorage。
 * 未登录、存储不可访问或注入失败时仍返回可取消的默认认证键。
 */
export async function scanAuthStorage(
  tabId: number,
): Promise<AuthStorageSelection> {
  const fallback: AuthStorageSelection = {
    local: [...DEFAULT_AUTH_STORAGE_SELECTION.local],
    session: [...DEFAULT_AUTH_STORAGE_SELECTION.session],
  };
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readAuthStorageKeysInPage,
    });
    const keys = frames[0]?.result;
    if (!keys) return fallback;
    return {
      local: [...new Set([...fallback.local, ...filterAuthStorageKeys(keys.local)])],
      session: [...new Set([...fallback.session, ...filterAuthStorageKeys(keys.session)])],
    };
  } catch {
    return fallback;
  }
}
