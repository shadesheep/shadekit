/**
 * 解析快捷登录文本，提取 URL、账号和密码。
 * 供 background 快捷键、SwitcherPanel、Popup 三处复用。
 *
 * 支持的格式：
 * - URL 换行 账号/密码
 * - URL 账号:密码（单行，空白分隔）
 * - URL 账号/密码（单行，空白分隔）
 * - 纯 账号/密码（无 URL，使用 defaultDomain）
 * - 账号 密码（单空格分隔）
 * - 密码中包含空格
 * - 无协议 URL（localhost:8080、192.168.1.100、example.com/path）
 * - 三行格式：URL \n 账号 \n 密码
 * - 账号/密码 URL（凭证在前，URL 在后）
 * - 带标签格式：账号:xxx / 密码:xxx（支持全角冒号）
 */

export interface ParsedLogin {
  url: string;
  username: string;
  password?: string;
  hasUrl: boolean;
}

/** 尝试从文本末尾提取 URL（凭证在前、URL 在后的场景） */
function tryExtractUrlFromEnd(text: string): { url: string; rest: string } | null {
  // 带协议的 URL 在末尾
  const withProto = text.match(/(https?:\/\/\S+)$/);
  if (withProto) {
    const url = withProto[1];
    const rest = text.slice(0, text.length - withProto[1].length).trim();
    return { url, rest };
  }

  // localhost[:port][/path] 在末尾
  const localhost = text.match(/(localhost(?::\d+)?(?:\/\S*)?)$/);
  if (localhost) {
    const url = localhost[1];
    const rest = text.slice(0, text.length - url.length).trim();
    return { url: `http://${url}`, rest };
  }

  // IP[:port][/path] 在末尾
  const ipAddr = text.match(/(\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?)$/);
  if (ipAddr) {
    const url = ipAddr[1];
    const rest = text.slice(0, text.length - url.length).trim();
    return { url: `http://${url}`, rest };
  }

  // domain.com[:port][/path] 在末尾 — 需要前面有其他内容
  const domain = text.match(/([a-zA-Z0-9](?:[a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/\S*)?)$/);
  if (domain) {
    const url = domain[1];
    const rest = text.slice(0, text.length - url.length).trim();
    if (rest) {
      return { url: `https://${url}`, rest };
    }
  }

  return null;
}

/** 尝试从文本开头提取 URL（含协议或无协议） */
function tryExtractUrl(text: string): { url: string; rest: string } | null {
  // 1. 带协议的 URL（最优先）
  const withProto = text.match(/^(https?:\/\/\S+)/);
  if (withProto) {
    return { url: withProto[1], rest: text.slice(withProto[1].length).trim() };
  }

  // 2. localhost[:port][/path]
  const localhost = text.match(/^(localhost(?::\d+)?(?:\/\S*)?)/);
  if (localhost) {
    const url = localhost[1];
    return { url: `http://${url}`, rest: text.slice(url.length).trim() };
  }

  // 3. IP[:port][/path]
  const ipAddr = text.match(
    /^(\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?)/,
  );
  if (ipAddr) {
    const url = ipAddr[1];
    return { url: `http://${url}`, rest: text.slice(url.length).trim() };
  }

  // 4. domain.com[:port][/path] — 仅在单行且后面有其他内容时匹配
  // 避免把 `admin/pass` 误识别为 URL
  const domain = text.match(/^([a-zA-Z0-9](?:[a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}(?::\d+)?(?:\/\S*)?)/);
  if (domain) {
    const url = domain[1];
    const rest = text.slice(url.length).trim();
    // 只有当后面还有内容（凭证）时才认为是 URL，否则视为无 URL
    if (rest) {
      return { url: `https://${url}`, rest };
    }
  }

  return null;
}

/** 从凭证字符串中提取账号和密码 */
function parseCredentials(cred: string): { username: string; password: string | undefined } | null {
  if (!cred) return null;

  // 先按换行分割，处理多行凭证；stripLabel 去除「账号:」「密码:」前缀
  const lines = cred
    .split(/\n/)
    .map((l) => stripLabel(l.trim()))
    .filter(Boolean);

  if (lines.length >= 3) {
    // 三行及以上：最后一行是密码，倒数第二行是账号
    return { username: lines[lines.length - 2], password: lines[lines.length - 1] };
  }

  if (lines.length === 2) {
    // 两行：每行一个
    const result = trySplitCredential(lines[0]);
    if (result) return result;
    // 第一行是账号，第二行是密码
    return { username: lines[0], password: lines[1] };
  }

  // 单行：尝试用分隔符拆分，若无分隔符则视为纯用户名
  const credResult = trySplitCredential(lines[0] || cred);
  if (credResult) return credResult;
  // 无分隔符 — 仅用户名，密码由调用方填充
  return { username: lines[0] || cred, password: undefined };
}

/** 去除「账号:」「密码:」等标签前缀（支持半角/全角冒号） */
function stripLabel(line: string): string {
  return line.replace(/^(?:账号|用户名|密码)\s*[:：]\s*/, '');
}

/** 尝试用 / 或 : 分隔凭证 */
function trySplitCredential(cred: string): { username: string; password: string } | null {
  if (!cred) return null;

  // 用 / 分隔（取第一个 / 作为分隔符）
  const slashIdx = cred.indexOf('/');
  if (slashIdx > 0 && slashIdx < cred.length - 1) {
    return { username: cred.slice(0, slashIdx).trim(), password: cred.slice(slashIdx + 1).trim() };
  }

  // 用 : 分隔（取最后一个 : ，避免与端口号冲突 — 但此处 URL 已被提取，
  // 剩余的 : 更可能是凭证分隔符）
  const colonIdx = cred.indexOf(':');
  if (colonIdx > 0 && colonIdx < cred.length - 1) {
    return { username: cred.slice(0, colonIdx).trim(), password: cred.slice(colonIdx + 1).trim() };
  }

  // 纯空白分隔（至少 1 个空格）：取第一个空白段作为分界
  const spaceMatch = cred.match(/^(\S+)\s+(.+)$/);
  if (spaceMatch) {
    return { username: spaceMatch[1], password: spaceMatch[2] };
  }

  return null;
}

export function parseLoginText(
  text: string,
  defaultDomain: string = '',
): ParsedLogin | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 先尝试从开头提取 URL
  let urlResult = tryExtractUrl(trimmed);
  if (!urlResult) {
    // 尝试从末尾提取 URL（凭证在前、URL 在后）
    urlResult = tryExtractUrlFromEnd(trimmed);
  }

  let urlPart: string;
  let credPart: string;
  let hasUrl: boolean;

  if (urlResult) {
    hasUrl = true;
    urlPart = urlResult.url;
    credPart = urlResult.rest;
  } else {
    hasUrl = false;
    urlPart = defaultDomain;
    credPart = trimmed;
  }

  if (!urlPart) return null;

  // 解析凭证
  const credResult = parseCredentials(credPart);
  if (credResult) {
    return {
      url: urlPart,
      username: credResult.username,
      password: credResult.password,
      hasUrl,
    };
  }

  return null;
}
