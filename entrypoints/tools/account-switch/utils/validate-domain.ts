import type { DomainConfig } from '../types';

/**
 * 环境域名 URL 校验
 *
 * 在 DomainsPanel 新增/编辑环境时行内校验：
 * 1. 必须是合法的 http/https URL，或无协议的通配符写法（matchDomain 支持，
 *    见 utils/env.ts 的 normalizeDomain，如 *.example.com）；
 * 2. 同环境配置内不允许重复域名（domains 以 URL 为 key，重复会静默覆盖）。
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
 * 重复检测：trim 后与既有 domains 的 key 精确比对（key 即原始 URL 字符串）。
 * 编辑场景传入 editingUrl（编辑前的 key）以排除自身。
 */
export function isDuplicateDomain(
  domains: Record<string, DomainConfig>,
  url: string,
  editingUrl: string | null,
): boolean {
  const key = url.trim();
  if (!key) return false;
  return key !== editingUrl && Object.hasOwn(domains, key);
}
