/**
 * JSON 核心纯函数模块
 * 从 FeHelper json-utils.js 改写为 TypeScript
 */

// ─── HTML 转义 ──────────────────────────────────────────────
export function htmlspecialchars(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── URL 检测 ───────────────────────────────────────────────
export function isUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^(https?:\/\/|ftp:\/\/)[^\s<>"'\\]+$/i.test(value);
}

// ─── BigNumber duck-typing ──────────────────────────────────
export function isBigNumberLike(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    typeof (value as any).s === 'number' &&
    typeof (value as any).e === 'number' &&
    Array.isArray((value as any).c)
  );
}

// ─── 类型判断 ───────────────────────────────────────────────
export function getType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'object') {
    if (isBigNumberLike(value)) return 'bigint';
    if (Array.isArray(value)) return 'array';
    return 'object';
  }
  return typeof value;
}

// ─── BigInt 安全解析 ────────────────────────────────────────
export function parseWithBigInt(text: string): unknown {
  text = String(text).trim();

  // 0) 先尝试直接 JSON.parse，成功则直接返回，避免正则误伤字符串内容
  try {
    return JSON.parse(text);
  } catch {
    // 直接解析失败，继续下面的宽松修正
  }

  // 1) 支持被字符串包裹的 JSON（先剥一层）
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    try {
      const unwrapped = JSON.parse(text);
      if (typeof unwrapped === 'string') {
        return parseWithBigInt(unwrapped);
      }
    } catch {
      /* fall through */
    }
  }

  // 2) 单引号 key → 双引号 key
  let fixed = text.replace(/([{,]\s*)'([^'\\]*?)'(\s*:)/g, '$1"$2"$3');
  // 3) 未加引号 key 补双引号
  fixed = fixed.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  // 4) 单引号值 → 双引号值
  fixed = fixed.replace(/(:\s*)'([^'\\]*?)'/g, '$1"$2"');

  // 5) 标记 16 位及以上的整数
  const marked = fixed.replace(
    /([:,[]\s*)(-?\d{16,})(\s*)(?=[,\]}])/g,
    (_match, prefix, number, spaces, offset) => {
      let inStr = false;
      let esc = false;
      for (let i = 0; i < offset; i++) {
        if (esc) {
          esc = false;
          continue;
        }
        if (fixed[i] === '\\') {
          esc = true;
          continue;
        }
        if (fixed[i] === '"') inStr = !inStr;
      }
      if (inStr) return _match;
      return prefix + '"__BigInt__' + number + '"' + spaces;
    },
  );

  try {
    return JSON.parse(marked, (_key, value) => {
      if (typeof value === 'string' && value.startsWith('__BigInt__')) {
        try {
          return BigInt(value.slice(10));
        } catch {
          return value.slice(10);
        }
      }
      return value;
    });
  } catch {
    // 兜底: new Function 解析
    try {
      return new Function('return ' + text)();
    } catch {
      throw new Error('无法解析 JSON，请检查语法');
    }
  }
}

// ─── 深度解包嵌套 JSON 字符串 ──────────────────────────────
export function deepParseJSONStrings(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      if (typeof item === 'string' && item.trim()) {
        try {
          const parsed = JSON.parse(item);
          if (_isDeepParsable(parsed)) {
            return deepParseJSONStrings(parsed);
          }
        } catch {
          /* ignore */
        }
      }
      return deepParseJSONStrings(item);
    });
  }
  if (typeof obj === 'object' && obj !== null) {
    const newObj: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const val = (obj as Record<string, unknown>)[key];
      if (typeof val === 'string' && val.trim()) {
        // 快速跳过明显的 HTML/富文本字符串
        if (_looksLikeHtml(val)) {
          newObj[key] = deepParseJSONStrings(val);
          continue;
        }
        try {
          const parsed = JSON.parse(val);
          if (_isDeepParsable(parsed)) {
            newObj[key] = deepParseJSONStrings(parsed);
            continue;
          }
        } catch {
          /* ignore */
        }
      }
      newObj[key] = deepParseJSONStrings(val);
    }
    return newObj;
  }
  return obj;
}

function _looksLikeHtml(str: string): boolean {
  const trimmed = str.trim();
  if (trimmed.length < 20) return false;
  // 检测 HTML 标签特征：以 < 开头且包含常见的 HTML 标签
  return /<[a-z][\s\S]*>[\s\S]*<\/[a-z]>/i.test(trimmed);
}

function _isDeepParsable(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  if (
    !Array.isArray(parsed) &&
    Object.prototype.toString.call(parsed) !== '[object Object]'
  )
    return false;
  // 排除 BigNumber duck-type {s, e, c}
  if (isBigNumberLike(parsed) && Object.keys(parsed as object).length === 3)
    return false;
  return true;
}

// ─── 安全的 safeStringify（保留 BigInt 精度）──────────────
export function safeStringify(obj: unknown, space?: number): string {
  const tagged = JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === 'bigint') {
        return `__FH_BIGINT__${value.toString()}`;
      }
      if (typeof value === 'number' && value.toString().includes('e')) {
        return `__FH_NUMSTR__${value.toLocaleString('fullwide', { useGrouping: false })}`;
      }
      return value;
    },
    space,
  );
  return tagged
    .replace(/"__FH_BIGINT__(-?\d+)"/g, '$1')
    .replace(/"__FH_NUMSTR__(-?\d+)"/g, '$1');
}

// ─── Unicode 编解码 ─────────────────────────────────────────
export function uniEncode(str: string): string {
  return escape(str)
    .replace(/%u/gi, '\\u')
    .replace(/%7b/gi, '{')
    .replace(/%7d/gi, '}')
    .replace(/%3a/gi, ':')
    .replace(/%2c/gi, ',')
    .replace(/%27/gi, "'")
    .replace(/%22/gi, '"')
    .replace(/%5b/gi, '[')
    .replace(/%5d/gi, ']')
    .replace(/%3D/gi, '=')
    .replace(/%08/gi, '\b')
    .replace(/%0D/gi, '\r')
    .replace(/%0C/gi, '\f')
    .replace(/%09/gi, '\t')
    .replace(/%20/gi, ' ')
    .replace(/%0A/gi, '\n')
    .replace(/%3E/gi, '>')
    .replace(/%3C/gi, '<')
    .replace(/%3F/gi, '?');
}

export function uniDecode(text: string): string {
  text = text.replace(/(\\)?\\u/gi, '%u').replace('%u0025', '%25');
  text = unescape(text.toString().replace(/%2B/g, '+'));
  const matches = text.match(/(%u00([0-9A-F]{2}))/gi);
  if (matches) {
    for (const m of matches) {
      const code = m.substring(1, 3);
      const x = Number('0x' + code);
      if (x >= 128) text = text.replace(m, code);
    }
  }
  return unescape(text.toString().replace(/%2B/g, '+'));
}

export function urlDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}
