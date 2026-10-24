/**
 * format-pipeline（ADR-0004 D3）
 * doFormat 的纯数据编排：lint 预检 → 解析（BigInt 安全）→ autoDecode /
 * 嵌套解包 / 排序 → HTML 树 + 缩进文本。
 *
 * lint 统一走 parseJsonError（lintJson 已删，它是 parseJsonError 的严格子集）。
 * 不触碰编辑器 / Toast / Vue 状态，结果由调用方（App.vue）呈现。
 */

import { parseLargeJson, formatLargeJson, type ChunkedProgress } from '../../../shared/lib/chunked-json';
import { parseJsonError } from '../../../shared/json-error-parser';
import { formatJsonToHtml } from './json-formatter';
import { sortObj } from './json-sorter';
import { deepParseJSONStrings, safeStringify, uniDecode } from './json-utils';

export interface FormatPipelineOptions {
  /** 缩进空格数 */
  indent: number;
  /** 解析后做一次 unicode 解码（\\uXXXX → 字符） */
  autoDecode: boolean;
  /** 深度解包嵌套 JSON 字符串 */
  nestedEscapeParse: boolean;
  /** key 排序：0 默认顺序，1 升序，-1 降序 */
  sortMode: number;
  /** 格式化前先做严格 JSON.parse 预检 */
  jsonLint: boolean;
}

export type FormatPipelineOutcome =
  | {
      ok: true;
      /** 转换链之后的解析结果（节点 CRUD 的数据源） */
      parsed: unknown;
      /** 树形视图 HTML */
      html: string;
      /** 缩进后的纯文本 */
      formatted: string;
    }
  | {
      ok: false;
      /** lint：预检失败；parse：主解析失败；format：转换/渲染阶段抛错 */
      stage: 'lint' | 'parse' | 'format';
      message: string;
      /** stage=format 时的原始异常，供调用方做 parseJsonError 定位 */
      cause?: unknown;
    };

export async function runFormatPipeline(
  raw: string,
  options: FormatPipelineOptions,
  onProgress?: (progress: ChunkedProgress) => void,
): Promise<FormatPipelineOutcome> {
  // 1) lint 预检（严格 JSON.parse；错误信息统一走 parseJsonError）
  if (options.jsonLint) {
    try {
      JSON.parse(raw);
    } catch (e) {
      const jsonError = parseJsonError(e, raw);
      return {
        ok: false,
        stage: 'lint',
        message: jsonError?.message ?? String(e),
      };
    }
  }

  // 2) 主解析（分块，BigInt 安全）
  const { data: parsedData, error } = await parseLargeJson(raw);
  if (error) {
    return { ok: false, stage: 'parse', message: error };
  }

  try {
    let parsed = parsedData;

    if (options.autoDecode) {
      parsed = JSON.parse(uniDecode(safeStringify(parsed)));
    }

    if (options.nestedEscapeParse) {
      parsed = deepParseJSONStrings(parsed);
    }

    if (options.sortMode !== 0) {
      parsed = sortObj(parsed, options.sortMode, true);
    }

    const html = formatJsonToHtml(parsed, options.nestedEscapeParse);
    const formatted = await formatLargeJson(parsed, options.indent, onProgress);

    return { ok: true, parsed, html, formatted };
  } catch (e) {
    return {
      ok: false,
      stage: 'format',
      message: e instanceof Error ? e.message : String(e),
      cause: e,
    };
  }
}
