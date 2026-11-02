/**
 * 环境检测与域名匹配辅助函数
 */

/**
 * 将配置的 domain 归一化为 origin 形式：去除首尾空白、末尾斜杠和路径。
 * 不含协议时（如 *.example.com 通配符写法）返回去斜杠后的原值。
 *
 * 注意：不能用 new URL().origin（77ae1ec 引入的回归）——
 * 1. Chromium 会把 host 里的 * 编码为 %2A，导致 includes('*') 为 false，
 *    所有带协议的通配符环境全部匹配失败（Node 不编码，vitest 测不出来）；
 * 2. new URL().origin 会丢弃显式写的默认端口（:80/:443）。
 * 这里手动截取 协议://host:port，仅做小写归一（origin 部分大小写不敏感）。
 *
 * 环境以 origin 为身份，路径 / 查询 / hash 一律不参与识别；保存环境时
 * 也用本函数把用户填写的完整页面地址收敛成环境 key。
 */
export function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, '');
  const match = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/);
  return match ? match[0].toLowerCase() : trimmed;
}

/**
 * 判断当前页面的 origin 是否与配置的 domain 匹配（支持通配符）。
 *
 * 两侧都按 normalizeDomain 归一：入参不一定是干净 origin——存量环境 key
 * 可能带路径/hash（如 `http://host:8880/management/#/login`），按环境 key
 * 反查环境时会把它原样再传回来，只归一一侧会导致必然失配（ENV_NOT_MATCHED）。
 */
export function matchDomain(domain: string, origin: string): boolean {
  const normalized = normalizeDomain(domain);
  const actual = normalizeDomain(origin);
  if (normalized === actual) return true;
  if (!normalized.includes('*')) return false;

  // Escape regex metacharacters, then convert escaped '*' to wildcard pattern
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\\\*/g, '[^.]*');
  const regex = new RegExp(`^${pattern}$`, 'i');

  return regex.test(actual);
}

/**
 * 归一化 origin，保留通配符 `*`。
 *
 * 不能用 new URL().origin：Chromium 会把 host 中的 `*` 编码为 `%2A`，
 * 使 `https://*.example.com` 永远无法与具体子域比较/匹配。
 */
export function normalizedOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes('*')) {
    try {
      return new URL(trimmed).origin;
    } catch {
      return '';
    }
  }
  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)/);
  if (!match) return '';
  const scheme = match[1].toLowerCase();
  let host = match[2].toLowerCase();
  const defaultPort = scheme === 'http' ? ':80' : scheme === 'https' ? ':443' : '';
  if (defaultPort && host.endsWith(defaultPort)) {
    host = host.slice(0, -defaultPort.length);
  }
  return `${scheme}://${host}`;
}

/** 实际 origin 是否命中期望 origin（支持 `*` 通配符子域）。 */
export function originMatches(expected: string, actual: string): boolean {
  const normalizedExpected = normalizedOrigin(expected);
  const normalizedActual = normalizedOrigin(actual);
  if (!normalizedExpected || !normalizedActual) return false;
  if (normalizedExpected === normalizedActual) return true;
  return normalizedExpected.includes('*') &&
    matchDomain(normalizedExpected, normalizedActual);
}

// ============================================================
// 环境作用域匹配（origin + 路径）
// ============================================================

/**
 * 页面位置：环境匹配除了 origin 还要看 pathname。
 * `https://*.example.com` 这类通配符只能回答「哪些 host 算这个环境」，
 * 同一 host 下的多个子系统（如 `/management` 与 `/ebidding`）必须靠路径区分。
 */
export interface PageLocation {
  origin: string;
  pathname: string;
}

/** 归一化 pathname：确保前导 `/`、去末尾 `/`；根路径保留 `/`。 */
function normalizePathname(raw: string): string {
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  const stripped = withLeading.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * 归一化环境路径作用域：空值或 `/` 表示不限定路径。
 * 返回值形如 `/management`（无尾斜杠），作为前缀按路径段边界匹配。
 */
export function normalizeMatchPath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const path = normalizePathname(trimmed);
  return path === '/' ? '' : path;
}

/**
 * 从 URL / origin / 环境 key 提取匹配所需的 origin + pathname。
 * 不用 new URL：通配符 key 在 Chromium 下会被编码，且这里容忍非法 URL。
 */
export function toPageLocation(value: string): PageLocation | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  const origin = normalizeDomain(trimmed);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(origin)) return null;
  const pathMatch = trimmed.match(
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/,
  );
  return { origin, pathname: normalizePathname(pathMatch?.[1] ?? '/') };
}

/** 页面 pathname 是否落在环境声明的路径作用域内（按路径段边界的前缀匹配）。 */
export function matchPathScope(
  scope: string | undefined,
  pathname: string,
): boolean {
  const normalized = normalizeMatchPath(scope);
  if (!normalized) return true;
  const actual = normalizePathname(pathname);
  return actual === normalized || actual.startsWith(`${normalized}/`);
}

/**
 * 环境 key = origin + 路径作用域。
 *
 * 两个同 origin 的子系统必须落在 `domains` 的不同 key 上，否则后者会覆盖
 * 前者；key 的路径部分只是身份，匹配始终以 `env.matchPath` 为准——存量 key
 * 即使带路径，没有 `matchPath` 时仍按 origin 匹配（见 normalizeDomain）。
 */
export function environmentKeyFor(url: string, matchPath?: string): string {
  return `${normalizeDomain(url)}${normalizeMatchPath(matchPath)}`;
}

/** 判断页面位置是否命中某环境（origin 通配符 + 路径作用域）。 */
export function matchEnvironment(
  environmentKey: string,
  env: { matchPath?: string },
  target: string | PageLocation,
): boolean {
  const location = typeof target === 'string' ? toPageLocation(target) : target;
  if (!location) return false;
  if (!matchDomain(environmentKey, location.origin)) return false;
  return matchPathScope(env.matchPath, location.pathname);
}

/**
 * 环境特异性评分（越大越具体）：
 * [0] 具体 origin(1) 优先于通配符(0)；
 * [1] 路径作用域越长越具体。
 */
export function environmentRank(
  environmentKey: string,
  env: { matchPath?: string },
): [number, number] {
  const exactOrigin = normalizeDomain(environmentKey).includes('*') ? 0 : 1;
  return [exactOrigin, normalizeMatchPath(env.matchPath).length];
}

/**
 * 在候选环境中取最具体的一个；同分按插入顺序（先出现者胜）。
 * 精确子域永远压过通配符，避免「通配符先配置 → 具体环境永远不生效」。
 */
export function pickEnvironment<T extends { matchPath?: string }>(
  target: string | PageLocation,
  domains: Record<string, T> | undefined,
): { domain: string; env: T } | undefined {
  if (!domains) return undefined;
  let best: { domain: string; env: T; rank: [number, number] } | undefined;
  for (const [domain, env] of Object.entries(domains)) {
    if (!matchEnvironment(domain, env, target)) continue;
    const rank = environmentRank(domain, env);
    if (
      !best ||
      rank[0] > best.rank[0] ||
      (rank[0] === best.rank[0] && rank[1] > best.rank[1])
    ) {
      best = { domain, env, rank };
    }
  }
  return best ? { domain: best.domain, env: best.env } : undefined;
}

/** 获取当前页面的完整地址（扩展页取当前活动标签页） */
export async function getCurrentUrl(): Promise<string> {
  if (window.location.protocol === 'chrome-extension:') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url ?? '';
  }
  return window.location.href;
}

/** 获取当前页面的 origin */
export async function getCurrentOrigin(): Promise<string> {
  if (window.location.protocol === 'chrome-extension:') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      try {
        return new URL(tabs[0].url).origin;
      } catch {
        return '';
      }
    }
    return '';
  }
  return window.location.origin;
}

/** 关闭当前视图（popup 用 window.close，content script 用 DOM 移除） */
export function closePanel(): void {
  if (window.location.protocol === 'chrome-extension:') {
    window.close();
  } else {
    document.getElementById('devtools-panel')?.remove();
  }
}

/** 是否在 popup 环境 */
export function isPopupEnv(): boolean {
  return window.location.protocol === 'chrome-extension:';
}
