import { resolveEnvironment } from '../account-view';
import type { DomainConfig } from '../types';
import { parseLoginText, type ParsedLogin } from './parse-text';

export type QuickLoginSelection = ParsedLogin & {
  targetSource: 'explicit' | 'current-page' | 'default';
};

/**
 * 快捷键/右键菜单快捷登录的目标优先级：显式 URL > 当前页面命中环境 > 默认环境。
 * 当前页面只有在 http(s) 且命中已配置环境时才可作为登录目标。
 */
export function parseQuickLoginSelection(
  selectedText: string,
  pageUrl: string,
  defaultDomain: string,
  domains: Record<string, DomainConfig> | undefined,
): QuickLoginSelection | null {
  let fallback = defaultDomain;
  let fallbackSource: 'current-page' | 'default' = 'default';
  try {
    const current = new URL(pageUrl);
    if (
      (current.protocol === 'http:' || current.protocol === 'https:') &&
      resolveEnvironment(current.origin, domains ?? {})
    ) {
      fallback = current.href;
      fallbackSource = 'current-page';
    }
  } catch {
    // 无效或受限页面地址不参与目标选择，继续使用默认环境。
  }
  const parsed = parseLoginText(selectedText, fallback);
  if (!parsed) return null;
  return {
    ...parsed,
    targetSource: parsed.hasUrl ? 'explicit' : fallbackSource,
  };
}

/** 通配符只用于环境匹配，不能作为实际导航地址。 */
export function hasWildcardHostname(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname.includes('*') || hostname.includes('%2a');
  } catch {
    return false;
  }
}
