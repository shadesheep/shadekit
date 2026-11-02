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
