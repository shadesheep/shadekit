import { js as js_beautify } from 'js-beautify';
import { css as css_beautify } from 'js-beautify';
import { html as html_beautify } from 'js-beautify';
import { beautifySql } from './sql-beautifier';
import { beautifyXml } from './xml-beautifier';

export type CodeType = 'javascript' | 'css' | 'html' | 'xml' | 'sql' | 'json';

export interface FormatOptions {
  indentSize?: number;
  indentChar?: string;
  showLineNumbers?: boolean;
}

export interface FormatResult {
  result: string;
  detectedType: CodeType;
}

/**
 * 自动检测代码类型
 */
export function detectCodeType(code: string): CodeType {
  const trimmed = code.trim();
  if (!trimmed) return 'javascript';

  // 1. Try JSON
  try {
    JSON.parse(trimmed);
    return 'json';
  } catch {
    // not JSON
  }

  // 2. Check for XML declaration first (<?xml ...>)
  if (/^\s*<\?xml/i.test(trimmed)) {
    return 'xml';
  }

  // 3. Check for HTML (has opening and closing tags)
  if (/<\s*[\w!?]/.test(trimmed)) {
    const hasClosingTag = /<\/\w+>/.test(trimmed) || /\/\s*>/.test(trimmed);
    const hasDoctypeOrComment = /<!DOCTYPE|<!--/.test(trimmed);
    if (hasClosingTag || hasDoctypeOrComment) {
      return 'html';
    }
  }

  // 3. Check for SQL keywords
  const sqlPattern =
    /\b(SELECT|FROM\s+[\w`"]|WHERE\s+|INSERT\s+INTO|UPDATE\s+[\w`"]|DELETE\s+FROM)\b/i;
  if (sqlPattern.test(trimmed)) {
    return 'sql';
  }

  // 4. Check for CSS (has property: value patterns inside braces)
  const cssPattern = /[\w-]+\s*:\s*[^;]+;?/;
  const hasBraces = /\{[^}]*\}/.test(trimmed);
  if (hasBraces && cssPattern.test(trimmed)) {
    // Make sure it's not JS by checking for JS-specific patterns
    const hasJsPattern =
      /\b(function|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|=>|import\s+|export\s+|return\s+)/.test(
        trimmed,
      );
    if (!hasJsPattern) {
      return 'css';
    }
  }

  // 4. Default to JavaScript
  return 'javascript';
}

/**
 * 格式化代码
 * @param code - 源代码
 * @param type - 代码类型，'auto' 时自动检测
 * @param options - 格式化选项
 * @returns 格式化结果
 */
export function formatCode(
  code: string,
  type: CodeType | 'auto' = 'auto',
  options: FormatOptions = {},
): FormatResult {
  const { indentSize = 4, indentChar = ' ' } = options;
  const trimmed = code.trim();

  if (!trimmed) {
    return { result: '', detectedType: 'javascript' };
  }

  const detectedType = type === 'auto' ? detectCodeType(trimmed) : type;

  const jsOpts = {
    indent_size: indentSize,
    indent_char: indentChar,
    brace_style: 'collapse' as const,
    break_chained_methods: false,
    indent_scripts: 'keep' as const,
    keep_array_indentation: true,
    preserve_newlines: true,
    space_after_anon_function: true,
    space_before_conditional: true,
    unescape_strings: false,
    wrap_line_length: 120,
    max_preserve_newlines: 5,
    jslint_happy: false,
    end_with_newline: false,
    indent_inner_html: false,
    comma_first: false,
    e4x: false,
  };

  try {
    switch (detectedType) {
      case 'javascript':
      case 'json': {
        const result = js_beautify(trimmed, jsOpts);
        return { result, detectedType };
      }
      case 'css': {
        const result = css_beautify(trimmed, {
          indent_size: indentSize,
          indent_char: indentChar,
        });
        return { result, detectedType };
      }
      case 'html': {
        const result = html_beautify(trimmed, {
          indent_size: indentSize,
          indent_char: indentChar,
          max_char: 250,
          indent_scripts: 'keep',
          unformatted: [
            'a',
            'span',
            'bdo',
            'em',
            'strong',
            'dfn',
            'code',
            'samp',
            'kbd',
            'var',
            'cite',
            'abbr',
            'acronym',
            'q',
            'sub',
            'sup',
            'tt',
            'i',
            'b',
            'big',
            'small',
            'u',
            's',
            'strike',
            'font',
            'ins',
            'del',
          ],
        } as Parameters<typeof html_beautify>[1]);
        return { result, detectedType };
      }
      case 'xml': {
        const result = beautifyXml(trimmed, indentSize);
        return { result, detectedType };
      }
      case 'sql': {
        const result = beautifySql(trimmed, indentSize);
        return { result, detectedType };
      }
      default: {
        const result = js_beautify(trimmed, jsOpts);
        return { result, detectedType: 'javascript' };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${getTypeLabel(detectedType)}格式化失败: ${message}`);
  }
}

function getTypeLabel(type: CodeType): string {
  const labels: Record<CodeType, string> = {
    javascript: 'JavaScript',
    css: 'CSS',
    html: 'HTML',
    xml: 'XML',
    sql: 'SQL',
    json: 'JSON',
  };
  return labels[type];
}

/**
 * 获取代码类型的显示名称
 */
export function getTypeDisplayName(type: CodeType): string {
  const names: Record<CodeType, string> = {
    javascript: 'JavaScript',
    css: 'CSS',
    html: 'HTML',
    xml: 'XML',
    sql: 'SQL',
    json: 'JSON',
  };
  return names[type];
}

/**
 * 所有支持的代码类型列表（不含 auto）
 */
export const CODE_TYPES: CodeType[] = [
  'javascript',
  'css',
  'html',
  'xml',
  'sql',
  'json',
];

/**
 * 每种语言对应的下载文件后缀与 MIME 类型
 */
export const CODE_TYPE_FILE_META: Record<CodeType, { ext: string; mime: string }> = {
  javascript: { ext: 'js', mime: 'text/javascript' },
  css: { ext: 'css', mime: 'text/css' },
  html: { ext: 'html', mime: 'text/html' },
  xml: { ext: 'xml', mime: 'application/xml' },
  sql: { ext: 'sql', mime: 'text/plain' },
  json: { ext: 'json', mime: 'application/json' },
};

const EXT_TO_TYPE: Record<string, CodeType> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  sql: 'sql',
  json: 'json',
};

/**
 * 根据文件名后缀推断代码类型；不支持的后缀返回 null
 */
export function detectTypeFromFileName(fileName: string): CodeType | null {
  const idx = fileName.lastIndexOf('.');
  // 无后缀、隐藏文件（.gitignore）均视为无有效后缀
  if (idx <= 0) return null;
  const ext = fileName.slice(idx + 1).toLowerCase();
  return EXT_TO_TYPE[ext] ?? null;
}

// ─── Syntax Highlighting (移植自 FeHelper content-script.js) ───

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, text: string) =>
  `<span class="hl-${cls}">${esc(text)}</span>`;

const JS_KW = new Set(
  'break,case,catch,continue,debugger,default,delete,do,else,finally,for,function,if,in,instanceof,new,return,switch,this,throw,try,typeof,var,void,while,with,class,const,enum,export,extends,import,super,implements,interface,let,package,private,protected,public,static,yield,of,async,await,from'.split(
    ',',
  ),
);
const CSS_PROPS = new Set(
  'color,background,background-color,background-image,background-size,background-position,background-repeat,border,border-radius,border-color,border-width,border-style,border-top,border-right,border-bottom,border-left,margin,margin-top,margin-right,margin-bottom,margin-left,padding,padding-top,padding-right,padding-bottom,padding-left,width,height,min-width,max-width,min-height,max-height,display,position,top,right,bottom,left,float,clear,overflow,overflow-x,overflow-y,z-index,font,font-size,font-weight,font-family,font-style,line-height,text-align,text-decoration,text-transform,text-indent,text-shadow,letter-spacing,word-spacing,white-space,vertical-align,cursor,opacity,visibility,box-shadow,box-sizing,transition,transform,animation,flex,flex-direction,flex-wrap,flex-grow,flex-shrink,flex-basis,justify-content,align-items,align-content,align-self,gap,grid,grid-template,grid-template-columns,grid-template-rows,content,list-style,outline,pointer-events,resize,user-select,fill,stroke'.split(
    ',',
  ),
);

/**
 * JavaScript 语法高亮
 */
export function highlightJS(code: string): string {
  let out = '';
  let i = 0;
  const len = code.length;
  while (i < len) {
    const c = code[i];
    // 单行注释
    if (c === '/' && code[i + 1] === '/') {
      let end = code.indexOf('\n', i);
      if (end === -1) end = len;
      out += span('comment', code.substring(i, end));
      i = end;
      // 多行注释
    } else if (c === '/' && code[i + 1] === '*') {
      let end = code.indexOf('*/', i + 2);
      end = end === -1 ? len : end + 2;
      out += span('comment', code.substring(i, end));
      i = end;
      // 字符串
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < len) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === q) {
          j++;
          break;
        }
        if (q !== '`' && code[j] === '\n') break;
        j++;
      }
      out += span('string', code.substring(i, j));
      i = j;
      // 正则
    } else if (c === '/' && /[=(,;:!&|?{}[\n+\-~^%]/.test(code[i - 1] || '(')) {
      let j = i + 1;
      while (j < len && code[j] !== '/' && code[j] !== '\n') {
        if (code[j] === '\\') j++;
        j++;
      }
      if (j < len && code[j] === '/') {
        j++;
        while (j < len && /[gimsuy]/.test(code[j])) j++;
        out += span('regex', code.substring(i, j));
        i = j;
      } else {
        out += esc(c);
        i++;
      }
      // 数字
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1]))) {
      let j = i;
      if (code[j] === '0' && (code[j + 1] === 'x' || code[j + 1] === 'X')) {
        j += 2;
        while (j < len && /[0-9a-fA-F_]/.test(code[j])) j++;
      } else if (
        code[j] === '0' &&
        (code[j + 1] === 'b' || code[j + 1] === 'B')
      ) {
        j += 2;
        while (j < len && /[01_]/.test(code[j])) j++;
      } else {
        while (j < len && /[0-9_]/.test(code[j])) j++;
        if (j < len && code[j] === '.') {
          j++;
          while (j < len && /[0-9_]/.test(code[j])) j++;
        }
        if (j < len && (code[j] === 'e' || code[j] === 'E')) {
          j++;
          if (code[j] === '+' || code[j] === '-') j++;
          while (j < len && /[0-9]/.test(code[j])) j++;
        }
      }
      if (j < len && code[j] === 'n') j++;
      out += span('number', code.substring(i, j));
      i = j;
      // 标识符/关键字
    } else if (/[a-zA-Z_$]/.test(c)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.substring(i, j);
      if (JS_KW.has(word)) out += span('keyword', word);
      else if (
        word === 'true' ||
        word === 'false' ||
        word === 'null' ||
        word === 'undefined' ||
        word === 'NaN' ||
        word === 'Infinity'
      )
        out += span('literal', word);
      else out += esc(word);
      i = j;
      // 换行/其他
    } else if (c === '\n') {
      out += '\n';
      i++;
    } else {
      out += esc(c);
      i++;
    }
  }
  return out;
}

/**
 * CSS 语法高亮
 */
export function highlightCSS(code: string): string {
  let out = '';
  let i = 0;
  const len = code.length;
  let inBlock = false;
  while (i < len) {
    const c = code[i];
    // 注释
    if (c === '/' && code[i + 1] === '*') {
      let end = code.indexOf('*/', i + 2);
      end = end === -1 ? len : end + 2;
      out += span('comment', code.substring(i, end));
      i = end;
      // 字符串
    } else if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < len && code[j] !== q) {
        if (code[j] === '\\') j++;
        j++;
      }
      if (j < len) j++;
      out += span('string', code.substring(i, j));
      i = j;
      // 块开始/结束
    } else if (c === '{') {
      inBlock = true;
      out += esc(c);
      i++;
    } else if (c === '}') {
      inBlock = false;
      out += esc(c);
      i++;
      // @ 规则
    } else if (c === '@') {
      let j = i + 1;
      while (j < len && /[a-zA-Z-]/.test(code[j])) j++;
      out += span('keyword', code.substring(i, j));
      i = j;
      // ID 选择器
    } else if (c === '#' && !inBlock) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_#-]/.test(code[j])) j++;
      out += span('selector-id', code.substring(i, j));
      i = j;
      // 类选择器
    } else if (c === '.' && !inBlock && /[a-zA-Z_-]/.test(code[i + 1] || '')) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_.-]/.test(code[j])) j++;
      out += span('selector-class', code.substring(i, j));
      i = j;
      // 伪类
    } else if (c === ':' && !inBlock) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_(-]/.test(code[j])) j++;
      out += span('selector-pseudo', code.substring(i, j));
      i = j;
      // 数字/单位
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1]))) {
      let j = i;
      while (j < len && /[0-9.]/.test(code[j])) j++;
      while (j < len && /[a-zA-Z%]/.test(code[j])) j++;
      out += span('number', code.substring(i, j));
      i = j;
      // 颜色值
    } else if (c === '#' && inBlock) {
      let j = i + 1;
      while (j < len && /[0-9a-fA-F]/.test(code[j])) j++;
      out += span('number', code.substring(i, j));
      i = j;
      // 属性名/选择器标签
    } else if (inBlock && /[a-zA-Z-]/.test(c)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9-]/.test(code[j])) j++;
      const word = code.substring(i, j);
      if (CSS_PROPS.has(word)) out += span('attribute', word);
      else out += esc(word);
      i = j;
    } else if (!inBlock && /[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_-]/.test(code[j])) j++;
      out += span('selector-tag', code.substring(i, j));
      i = j;
      // 换行/其他
    } else if (c === '\n') {
      out += '\n';
      i++;
    } else {
      out += esc(c);
      i++;
    }
  }
  return out;
}

const SQL_KW = new Set(
  'SELECT,FROM,WHERE,INSERT,INTO,VALUES,UPDATE,SET,DELETE,CREATE,TABLE,ALTER,DROP,INDEX,VIEW,JOIN,LEFT,RIGHT,INNER,OUTER,CROSS,ON,AND,OR,NOT,IN,EXISTS,BETWEEN,LIKE,ORDER,BY,GROUP,HAVING,AS,DISTINCT,UNION,ALL,CASE,WHEN,THEN,ELSE,END,ASC,DESC,NULL,TRUE,FALSE,PRIMARY,KEY,FOREIGN,REFERENCES,CONSTRAINT,DEFAULT,CHECK,TRIGGER,PROCEDURE,FUNCTION,RETURN,GRANT,REVOKE,COMMIT,ROLLBACK,TRANSACTION'.split(
    ',',
  ),
);

/**
 * HTML/XML 语法高亮
 */
export function highlightHTML(code: string): string {
  let out = '';
  let i = 0;
  const len = code.length;
  while (i < len) {
    const c = code[i];
    // 注释 <!--...-->
    if (c === '<' && code.substring(i, i + 4) === '<!--') {
      const end = code.indexOf('-->', i + 4);
      const close = end === -1 ? len : end + 3;
      out += span('comment', code.substring(i, close));
      i = close;
      // XML 声明 <?xml
    } else if (c === '<' && code.substring(i, i + 5) === '<?xml') {
      const end = code.indexOf('?>', i + 5);
      const close = end === -1 ? len : end + 2;
      out += span('keyword', code.substring(i, close));
      i = close;
      // DOCTYPE / 处理指令
    } else if (
      c === '<' &&
      code.substring(i, i + 9).toUpperCase() === '<!DOCTYPE'
    ) {
      const end = code.indexOf('>', i);
      const close = end === -1 ? len : end + 1;
      out += span('keyword', code.substring(i, close));
      i = close;
      // 标签
    } else if (c === '<') {
      let j = i + 1;
      // 跳过可能存在的 / （闭合标签）
      if (code[j] === '/') j++;
      // 收集标签名
      const nameStart = j;
      while (j < len && /[a-zA-Z0-9_:-]/.test(code[j])) j++;
      const tagName = code.substring(nameStart, j);

      // 如果不是有效标签名，把 < 当作普通文本处理，避免死循环
      if (!tagName) {
        out += esc(c);
        i++;
        continue;
      }

      if (code[i + 1] === '/') {
        // 闭合标签 </tag> — 只收集标签名
        const k = j;
        // 跳过标签名后的空白，找到 >
        let end = k;
        while (end < len && /\s/.test(code[end])) end++;
        if (end < len && code[end] === '>') end++;
        out += span('tag', `</${tagName}>`);
        i = end;
      } else if (tagName.startsWith('!') || tagName.startsWith('?')) {
        // <![CDATA[ 等
        const end = code.indexOf('>', i);
        const close = end === -1 ? len : end + 1;
        out += span('keyword', code.substring(i, close));
        i = close;
      } else {
        // 开标签 <tag attr="value"> — 先收集完整标签再高亮
        let end = j;
        while (end < len) {
          // 跳过引号内的内容，避免属性值中的 > 被误识别为标签结束
          if (code[end] === '"' || code[end] === "'") {
            const quote = code[end];
            end++;
            while (end < len && code[end] !== quote) end++;
            if (end < len) end++; // 跳过闭合引号
          } else if (code[end] === '/' && code[end + 1] === '>') {
            end += 2;
            break;
          } else if (code[end] === '>') {
            end++;
            break;
          } else {
            end++;
          }
        }
        out += highlightTagContent(code.substring(i, end));
        i = end;
      }
      // 普通文本中的特殊字符
    } else {
      // 批量处理普通文本，快速跳过到下一个 < 或 &
      const nextLt = code.indexOf('<', i);
      const nextAmp = code.indexOf('&', i);
      const end =
        nextLt === -1
          ? nextAmp === -1
            ? len
            : nextAmp
          : nextAmp === -1
            ? nextLt
            : Math.min(nextLt, nextAmp);
      out += esc(code.substring(i, end));
      i = end;
    }
  }
  return out;
}

/**
 * 对完整 HTML 标签字符串进行内部高亮
 * 输入例如: <div class="container"> 或 <br/>
 */
function highlightTagContent(tag: string): string {
  let out = '';
  let i = 0;
  const len = tag.length;

  // '<' 标签起始符
  if (tag[0] === '<') {
    out += span('punctuation', '<');
    // 收集标签名
    let j = 1;
    while (j < len && /[a-zA-Z0-9_:-]/.test(tag[j])) j++;
    out += span('tag', tag.substring(1, j));
    i = j;
  }

  // 解析属性和其余部分
  while (i < len) {
    const c = tag[i];
    if (/\s/.test(c)) {
      out += c;
      i++;
    } else if (/[a-zA-Z0-9_:-]/.test(c)) {
      // 属性名
      let j = i;
      while (j < len && /[a-zA-Z0-9_:-]/.test(tag[j])) j++;
      if (j < len && tag[j] === '=') {
        out += span('attribute', tag.substring(i, j));
        i = j;
      } else {
        // 不是属性（可能是其他文本），原样输出
        out += esc(tag.substring(i, j));
        i = j;
      }
    } else if (c === '=') {
      out += span('punctuation', '=');
      i++;
    } else if (c === '"' || c === "'") {
      // 属性值
      const quote = c;
      let j = i + 1;
      while (j < len && tag[j] !== quote) j++;
      if (j < len) j++;
      out += span('string', tag.substring(i, j));
      i = j;
    } else if (c === '/') {
      // 自闭合 / 或标签结束前的 /
      if (i + 1 < len && tag[i + 1] === '>') {
        out += span('punctuation', '/');
        i++;
      } else {
        out += esc(c);
        i++;
      }
    } else if (c === '>') {
      out += span('punctuation', '>');
      break;
    } else {
      out += esc(c);
      i++;
    }
  }

  return out;
}

/**
 * SQL 语法高亮
 */
export function highlightSQL(code: string): string {
  let out = '';
  let i = 0;
  const len = code.length;
  while (i < len) {
    const c = code[i];
    // 多行注释
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const close = end === -1 ? len : end + 2;
      out += span('comment', code.substring(i, close));
      i = close;
      // 单行注释
    } else if (c === '-' && code[i + 1] === '-') {
      let end = code.indexOf('\n', i);
      if (end === -1) end = len;
      out += span('comment', code.substring(i, end));
      i = end;
      // 字符串
    } else if (c === "'") {
      let j = i + 1;
      while (j < len) {
        if (code[j] === "'" && code[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (code[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      out += span('string', code.substring(i, j));
      i = j;
      // 数字
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < len && /[0-9.]/.test(code[j])) j++;
      out += span('number', code.substring(i, j));
      i = j;
      // 标识符/关键字
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_]/.test(code[j])) j++;
      const word = code.substring(i, j);
      if (SQL_KW.has(word.toUpperCase())) out += span('keyword', word);
      else out += esc(word);
      i = j;
      // 其他
    } else {
      out += esc(c);
      i++;
    }
  }
  return out;
}

/**
 * 为格式化结果生成语法高亮 HTML
 * @param code - 格式化后的代码
 * @param type - 代码类型
 * @param showLineNumbers - 是否显示行号，默认 true
 */
export function formatWithHighlight(
  code: string,
  type: CodeType,
  showLineNumbers = true,
): string {
  let highlighted: string;
  switch (type) {
    case 'javascript':
    case 'json':
      highlighted = highlightJS(code);
      break;
    case 'css':
      highlighted = highlightCSS(code);
      break;
    case 'html':
    case 'xml':
      highlighted = highlightHTML(code);
      break;
    case 'sql':
      highlighted = highlightSQL(code);
      break;
    default:
      highlighted = esc(code);
  }

  if (showLineNumbers) {
    const lines = highlighted.split('\n');
    const gutterSpans = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
    const codeContent = lines.join('\n');
    return `<div class="code-output"><div class="line-numbers-gutter">${gutterSpans}</div><pre class="code-content"><code>${codeContent}</code></pre></div>`;
  }

  return `<div class="code-output"><pre class="code-content no-line-numbers"><code>${highlighted}</code></pre></div>`;
}
