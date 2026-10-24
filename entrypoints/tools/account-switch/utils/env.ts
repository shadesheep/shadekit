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
 */
function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, '');
  const match = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/);
  return match ? match[0].toLowerCase() : trimmed;
}

/** 判断当前页面的 origin 是否与配置的 domain 匹配（支持通配符）。 */
export function matchDomain(domain: string, origin: string): boolean {
  const normalized = normalizeDomain(domain);
  if (normalized === origin) return true;
  if (!normalized.includes('*')) return false;

  // Escape regex metacharacters, then convert escaped '*' to wildcard pattern
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\\\*/g, '[^.]*');
  const regex = new RegExp(`^${pattern}$`, 'i');

  return regex.test(origin);
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
