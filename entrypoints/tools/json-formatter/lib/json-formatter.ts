/**
 * JSON 格式化核心模块
 * 从 FeHelper format-lib.js 改写为 TypeScript，去除 jQuery 依赖
 *
 * 核心功能：将解析后的 JSON 对象渲染为可折叠/展开的 HTML 树结构
 */

import { getBigNumberDisplayString } from './bigint-helper';
import { getType, htmlspecialchars, isUrl } from './json-utils';

let itemIdCounter = 0;

function nextItemId(): string {
  return `fh-item-${++itemIdCounter}`;
}

/**
 * 创建递归节点对象
 */
function createNode(
  value: unknown,
  escapeEnabled: boolean,
  path = '$',
): NodeObject {
  const type = getType(value);

  const node: NodeObject = {
    type,
    value,
    path,
    children: [],

    getHTML() {
      switch (this.type) {
        case 'string': {
          const str = this.value as string;
          if (isUrl(str)) {
            return (
              `<div class="item item-line" data-path="${htmlspecialchars(path)}" data-item-id="${nextItemId()}"><span class="string"><a href="${htmlspecialchars(str)}" target="_blank" rel="noopener noreferrer" data-is-link="1" data-link-url="${htmlspecialchars(str)}">` +
              `${htmlspecialchars(JSON.stringify(str))}</a></span></div>`
            );
          }

          // 转义模式：检测字符串是否为嵌套 JSON
          if (escapeEnabled) {
            const trimmed = str.trim();
            if (
              (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
              (trimmed.startsWith('{') && trimmed.endsWith('}'))
            ) {
              try {
                const parsed = JSON.parse(str);
                if (typeof parsed === 'object' && parsed !== null) {
                  const nestedNode = createNode(parsed, escapeEnabled, path);
                  let nestedHTML = nestedNode.getHTML();
                  // 移除外层 item 容器
                  nestedHTML = nestedHTML
                    .replace(/^<div[^>]*>/, '')
                    .replace(/<\/div>$/, '');
                  return (
                    `<div class="item item-line" data-path="${htmlspecialchars(path)}" data-item-id="${nextItemId()}"><span class="string">` +
                    `<span class="quote">"</span>` +
                    `<div class="string-json-nested" style="display:block;margin-left:0;padding-left:0;">` +
                    nestedHTML +
                    `</div>` +
                    `<span class="quote">"</span>` +
                    `</span></div>`
                  );
                }
              } catch {
                // 解析失败，按普通字符串处理
              }
            }
          }

          // 使用 JSON.stringify 保留转义字符的可见表示，与 FeHelper 一致
          return `<div class="item item-line" data-path="${htmlspecialchars(path)}" data-item-id="${nextItemId()}"><span class="string">${formatStringValue(JSON.stringify(str))}</span></div>`;
        }
        case 'number': {
          const numVal = this.value as number;
          const numStr =
            typeof numVal === 'number' && numVal.toString().includes('e')
              ? numVal.toLocaleString('fullwide', { useGrouping: false })
              : this.value;
          return `<div class="item item-line" data-path="${htmlspecialchars(path)}" data-item-id="${nextItemId()}"><span class="number">${numStr}</span></div>`;
        }
        case 'bigint':
          return `<div class="item item-line" data-path="${htmlspecialchars(path)}" data-item-id="${nextItemId()}"><span class="number">${getBigNumberDisplayString(this.value)}</span></div>`;
        case 'boolean':
          return `<div class="item item-line" data-path="${htmlspecialchars(path)}" data-item-id="${nextItemId()}"><span class="bool">${this.value}</span></div>`;
        case 'null':
          return `<div class="item item-line" data-path="${htmlspecialchars(path)}" data-item-id="${nextItemId()}"><span class="null">null</span></div>`;
        case 'object':
          return this.getObjectHTML();
        case 'array':
          return this.getArrayHTML();
        default:
          return '';
      }
    },

    getObjectHTML() {
      const obj = this.value as Record<string, unknown>;
      const id = nextItemId();
      if (!obj || Object.keys(obj).length === 0) {
        return `<div class="item item-object" data-path="${htmlspecialchars(path)}" data-item-id="${id}"><span class="brace">{</span><span class="brace">}</span></div>`;
      }

      const keys = Object.keys(obj);
      let html =
        `<div class="item item-object" data-path="${htmlspecialchars(path)}" data-items="${keys.length}" data-item-id="${id}">` +
        '<span class="expand"></span>' +
        '<span class="brace">{</span>' +
        '<span class="ellipsis">...</span>' +
        '<div class="kv-list">';

      keys.forEach((key, index) => {
        const prop = obj[key];
        const childPath = `${path}.${key}`;
        const childNode = createNode(prop, escapeEnabled, childPath);
        const itemClass =
          childNode.type === 'object' || childNode.type === 'array'
            ? 'item item-block'
            : 'item';

        html += `<div class="${itemClass}" data-path="${htmlspecialchars(childPath)}" data-item-id="${nextItemId()}">`;

        if (childNode.type === 'object' || childNode.type === 'array') {
          html += '<span class="expand"></span>';
        }

        html +=
          '<span class="quote">"</span>' +
          `<span class="key">${htmlspecialchars(key)}</span>` +
          '<span class="quote">"</span>' +
          '<span class="colon">: </span>';

        if (childNode.type === 'object' || childNode.type === 'array') {
          html += childNode.getInlineHTMLWithoutExpand();
        } else {
          html += childNode
            .getHTML()
            .replace(/^<div[^>]*>/, '')
            .replace(/<\/div>$/, '');
        }

        if (index < keys.length - 1) {
          html += '<span class="comma">,</span>';
        }
        html += '</div>';
      });

      html += '</div><span class="brace">}</span></div>';
      return html;
    },

    getArrayHTML() {
      const arr = this.value as unknown[];
      const id = nextItemId();
      if (!arr || arr.length === 0) {
        return `<div class="item item-array" data-path="${htmlspecialchars(path)}" data-item-id="${id}"><span class="brace">[</span><span class="brace">]</span></div>`;
      }

      let html =
        `<div class="item item-array" data-path="${htmlspecialchars(path)}" data-items="${arr.length}" data-item-id="${id}">` +
        '<span class="expand"></span>' +
        '<span class="brace">[</span>' +
        '<span class="ellipsis">...</span>' +
        '<div class="kv-list item-array-container">';

      arr.forEach((item, index) => {
        const childPath = `${path}[${index}]`;
        const childNode = createNode(item, escapeEnabled, childPath);

        html += `<div class="item item-block item-array-element" data-path="${htmlspecialchars(childPath)}" data-array-index="${index}" data-item-id="${nextItemId()}">`;

        if (childNode.type === 'object' || childNode.type === 'array') {
          html += '<span class="expand"></span>';
          html += childNode.getInlineHTMLWithoutExpand();
        } else {
          html += childNode
            .getHTML()
            .replace(/^<div[^>]*>/, '')
            .replace(/<\/div>$/, '');
        }

        if (index < arr.length - 1) {
          html += '<span class="comma">,</span>';
        }
        html += '</div>';
      });

      html += '</div><span class="brace">]</span></div>';
      return html;
    },

    getInlineHTMLWithoutExpand() {
      switch (this.type) {
        case 'object':
          return this.getInlineObjectHTMLWithoutExpand();
        case 'array':
          return this.getInlineArrayHTMLWithoutExpand();
        default:
          return this.getHTML();
      }
    },

    getInlineObjectHTMLWithoutExpand() {
      const obj = this.value as Record<string, unknown>;
      if (!obj || Object.keys(obj).length === 0) {
        return '<span class="brace">{</span><span class="brace">}</span>';
      }

      const keys = Object.keys(obj);
      let html =
        '<span class="brace">{</span>' +
        '<span class="ellipsis">...</span>' +
        '<div class="kv-list">';

      keys.forEach((key, index) => {
        const prop = obj[key];
        const childPath = `${path}.${key}`;
        const childNode = createNode(prop, escapeEnabled, childPath);
        const itemClass =
          childNode.type === 'object' || childNode.type === 'array'
            ? 'item item-block'
            : 'item';

        html += `<div class="${itemClass}" data-path="${htmlspecialchars(childPath)}" data-item-id="${nextItemId()}">`;

        if (childNode.type === 'object' || childNode.type === 'array') {
          html += '<span class="expand"></span>';
        }

        html +=
          '<span class="quote">"</span>' +
          `<span class="key">${htmlspecialchars(key)}</span>` +
          '<span class="quote">"</span>' +
          '<span class="colon">: </span>';

        if (childNode.type === 'object' || childNode.type === 'array') {
          html += childNode.getInlineHTMLWithoutExpand();
        } else {
          html += childNode
            .getHTML()
            .replace(/^<div[^>]*>/, '')
            .replace(/<\/div>$/, '');
        }

        if (index < keys.length - 1) {
          html += '<span class="comma">,</span>';
        }
        html += '</div>';
      });

      html += '</div><span class="brace">}</span>';
      return html;
    },

    getInlineArrayHTMLWithoutExpand() {
      const arr = this.value as unknown[];
      if (!arr || arr.length === 0) {
        return '<span class="brace">[</span><span class="brace">]</span>';
      }

      let html =
        '<span class="brace">[</span>' +
        '<span class="ellipsis">...</span>' +
        '<div class="kv-list item-array-container">';

      arr.forEach((item, index) => {
        const childPath = `${path}[${index}]`;
        const childNode = createNode(item, escapeEnabled, childPath);

        html += `<div class="item item-block item-array-element" data-path="${htmlspecialchars(childPath)}" data-array-index="${index}" data-item-id="${nextItemId()}">`;

        if (childNode.type === 'object' || childNode.type === 'array') {
          html += '<span class="expand"></span>';
          html += childNode.getInlineHTMLWithoutExpand();
        } else {
          html += childNode
            .getHTML()
            .replace(/^<div[^>]*>/, '')
            .replace(/<\/div>$/, '');
        }

        if (index < arr.length - 1) {
          html += '<span class="comma">,</span>';
        }
        html += '</div>';
      });

      html += '</div><span class="brace">]</span>';
      return html;
    },
  };

  return node;
}

interface NodeObject {
  type: string;
  value: unknown;
  path: string;
  children: NodeObject[];
  getHTML(): string;
  getObjectHTML(): string;
  getArrayHTML(): string;
  getInlineHTMLWithoutExpand(): string;
  getInlineObjectHTMLWithoutExpand(): string;
  getInlineArrayHTMLWithoutExpand(): string;
}

/**
 * 格式化字符串值，URL 转换为链接
 */
function formatStringValue(str: string): string {
  const urlRegex = /^(https?:\/\/|ftp:\/\/)[^\s<>"'\\]+$/i;

  if (urlRegex.test(str)) {
    const escaped = htmlspecialchars(str);
    return (
      `<a href="${escaped}" target="_blank" rel="noopener noreferrer" data-is-link="1" data-link-url="${escaped}">` +
      `${htmlspecialchars(str)}</a>`
    );
  }

  // 直接显示解析后的字符串内容
  return htmlspecialchars(str);
}

/**
 * 将解析后的 JSON 对象渲染为 HTML 树结构
 * @param json 解析后的 JSON 对象
 * @param escapeEnabled 是否开启嵌套转义解析
 * @returns HTML 字符串
 */
export function formatJsonToHtml(json: unknown, escapeEnabled = false): string {
  itemIdCounter = 0; // reset counter for each format
  const node = createNode(json, escapeEnabled);
  return `<div id="formattedJson">${node.getHTML()}</div>`;
}

/**
 * JSONPath 查询实现（简化版）
 * 支持：$、.property、[index]、[*]
 */
export interface JsonPathResult {
  path: string;
  value: unknown;
}

export function jsonPathQuery(
  json: unknown,
  expression: string,
): JsonPathResult[] {
  const results: JsonPathResult[] = [];

  if (!expression.startsWith('$')) {
    return results;
  }

  // 解析路径表达式
  const tokens: PathToken[] = [];
  let remaining = expression.slice(1); // 去掉 $

  while (remaining.length > 0) {
    if (remaining.startsWith('.')) {
      // .property
      const match = remaining.match(/^\.([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (match) {
        tokens.push({ type: 'property', name: match[1] });
        remaining = remaining.slice(match[0].length);
      } else {
        break;
      }
    } else if (remaining.startsWith('[')) {
      // [index] 或 [*] 或 ["key"]
      const bracketMatch = remaining.match(/^\[([^\]]*)\]/);
      if (bracketMatch) {
        const inner = bracketMatch[1].trim();
        if (inner === '*') {
          tokens.push({ type: 'wildcard' });
        } else if (/^\d+$/.test(inner)) {
          tokens.push({ type: 'index', index: parseInt(inner, 10) });
        } else {
          // ["key"] 或 ['key']
          const keyMatch = inner.match(/^["'](.+?)["']$/);
          if (keyMatch) {
            tokens.push({ type: 'property', name: keyMatch[1] });
          }
        }
        remaining = remaining.slice(bracketMatch[0].length);
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // 执行查询
  function traverse(current: unknown, tokenIndex: number, currentPath: string) {
    if (tokenIndex >= tokens.length) {
      results.push({ path: currentPath || '$', value: current });
      return;
    }

    const token = tokens[tokenIndex];

    if (current === null || current === undefined) return;

    if (token.type === 'property') {
      const name = token.name!;
      if (typeof current === 'object' && !Array.isArray(current)) {
        const obj = current as Record<string, unknown>;
        if (name in obj) {
          const newPath = currentPath ? `${currentPath}.${name}` : name;
          traverse(obj[name], tokenIndex + 1, newPath);
        }
      }
    } else if (token.type === 'index') {
      const idx = token.index!;
      if (Array.isArray(current) && idx < current.length) {
        traverse(current[idx], tokenIndex + 1, `${currentPath}[${idx}]`);
      }
    } else if (token.type === 'wildcard') {
      if (Array.isArray(current)) {
        current.forEach((item, i) => {
          traverse(item, tokenIndex + 1, `${currentPath}[${i}]`);
        });
      } else if (typeof current === 'object') {
        const obj = current as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
          traverse(obj[key], tokenIndex + 1, `${currentPath}["${key}"]`);
        }
      }
    }
  }

  traverse(json, 0, '');
  return results;
}

interface PathToken {
  type: 'property' | 'index' | 'wildcard';
  name?: string;
  index?: number;
}
