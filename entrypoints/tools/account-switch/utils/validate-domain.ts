import type { DomainConfig } from '../types';
import { environmentKeyFor, matchEnvironment, normalizeDomain, normalizeMatchPath } from './env';

/**
 * 环境域名 / 路径作用域 / 入口地址校验
 *
 * 在 DomainsPanel 新增/编辑环境时行内校验：
 * 1. 必须是合法的 http/https URL，或无协议的通配符写法（matchDomain 支持，
 *    见 utils/env.ts 的 normalizeDomain，如 *.example.com）；
 * 2. 同环境配置内不允许重复的 `(origin, matchPath)`；
 * 3. 入口地址必须是具体地址（无 `*`），且落在该环境作用域内。
 */

const FORMAT_ERROR = 'URL 格式不正确，例: http://localhost:8888';

/** 尝试按 URL 解析（通配符 * 替换为合法占位字符；Chromium 会把 host 中的 * 编码为 %2A） */
function parseable(url: string): boolean {
  try {
    new URL(url.replace(/\*/g, 'wildcard'));
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验域名 URL 格式，返回错误文案；合法时返回 null。
 */
export function validateDomainUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return '请输入域名 URL';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    // 无协议写法仅放行通配符（既有合法配置形式，如 *.example.com）
    if (url.includes('*')) {
      return parseable('https://' + url) ? null : FORMAT_ERROR;
    }
    return 'URL 需以 http:// 或 https:// 开头';
  }
  if (!/^https?:\/\//i.test(url)) return '仅支持 http/https 协议';
  return parseable(url) ? null : FORMAT_ERROR;
}

/**
 * 校验路径作用域格式：空值合法（匹配整个 origin）；否则必须以 `/` 开头，
 * 且不含 query / hash / 空白。匹配语义见 `matchPathScope`。
 */
export function validateMatchPath(raw: string): string | null {
  const path = raw.trim();
  if (!path) return null;
  if (!path.startsWith('/')) return '页面路径要以 / 开头，例: /management';
  if (path.startsWith('//')) return '页面路径不能以 // 开头';
  if (/[?#\s]/.test(path)) return '页面路径里不能有 ?、# 或空格';
  return null;
}

/** 校验入口地址：空值合法；必须是具体 http/https 地址并落在环境作用域内。 */
export function validateEntryUrl(
  key: string,
  matchPath: string,
  entryUrl: string,
): string | null {
  const raw = entryUrl.trim();
  if (!raw) return null;
  if (!key.trim()) return '请先填写域名 / URL';
  const formatError = validateDomainUrl(raw);
  if (formatError) return formatError;
  if (/[a-z][a-z0-9+.-]*:\/\/[^/?#]*\*/i.test(raw) || /%2a/i.test(raw)) {
    return '入口地址要填具体地址，不能用 * 通配符';
  }
  if (!matchEnvironment(key, { matchPath: normalizeMatchPath(matchPath) }, raw)) {
    return '入口地址不在这个环境的页面路径内';
  }
  return null;
}

/**
 * 重复检测：`(origin, 路径作用域)` 都相同才算重复。
 * 编辑场景传入 editingUrl（编辑前的 key）以排除自身。
 *
 * 只比原始字符串会漏掉「同一 host 的两种写法」（如存量 key 带 #/login、
 * 新填的只到 host:port），保存后两个环境争抢同一页面，按插入顺序误选。
 */
export function isDuplicateDomain(
  domains: Record<string, DomainConfig>,
  url: string,
  matchPath: string,
  editingUrl: string | null,
): boolean {
  const origin = normalizeDomain(url);
  if (!origin) return false;
  const path = normalizeMatchPath(matchPath);
  const key = environmentKeyFor(origin, path);
  return Object.keys(domains).some(
    (existing) =>
      existing !== editingUrl &&
      (existing.trim() === key ||
        (normalizeDomain(existing) === origin &&
          normalizeMatchPath(domains[existing]?.matchPath) === path)),
  );
}
