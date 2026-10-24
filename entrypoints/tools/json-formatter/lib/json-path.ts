/**
 * json-path（ADR-0004 D3）
 * 把 '$' 开头的 JSON 路径翻译成各语言的访问表达式。
 * 纯函数；语言列表与翻译分支同源（PATH_LANGUAGES）。
 */

import { splitPath } from './json-tree';

export interface PathLanguage {
  value: string;
  label: string;
}

/** 路径复制下拉框的语言选项（value 与 pathToLanguage 分支一一对应） */
export const PATH_LANGUAGES: PathLanguage[] = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'php', label: 'PHP' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'swift', label: 'Swift' },
];

/** 各语言的根标识符 */
const ROOT_IDENTIFIERS: Record<string, string> = {
  javascript: '$',
  php: '$data',
  python: 'data',
  java: 'jsonObject',
  csharp: 'jsonObject',
  go: 'data',
  ruby: 'data',
  swift: 'jsonObject',
};

type Accessor = { key: string } | { index: number };

/** 统一解析为访问器序列，兼容根节点为数组（首段为 [index]）的情况 */
function toAccessors(jsonPath: string): Accessor[] {
  return splitPath(jsonPath).map((p) =>
    p.startsWith('[')
      ? { index: parseInt(p.slice(1, -1), 10) }
      : { key: p.startsWith('.') ? p.slice(1) : p },
  );
}

/** 将 JSON 路径翻译为指定语言的访问表达式；未知语言回退原路径 */
export function pathToLanguage(jsonPath: string, lang: string): string {
  const root = ROOT_IDENTIFIERS[lang];
  if (!root) return jsonPath;
  if (jsonPath === '$') return root;

  const accessors = toAccessors(jsonPath);
  if (accessors.length === 0) return '$';

  let result = root;
  for (const a of accessors) {
    if ('key' in a) {
      switch (lang) {
        case 'javascript':
          result += `.${a.key}`;
          break;
        case 'java':
          result += `.get("${a.key}")`;
          break;
        case 'ruby':
          result += `[:"${a.key}"]`;
          break;
        default:
          // php / python / csharp / go / swift：统一 ["key"] 形式
          result += `["${a.key}"]`;
          break;
      }
    } else {
      result += lang === 'java' ? `.get(${a.index})` : `[${a.index}]`;
    }
  }
  return result;
}
