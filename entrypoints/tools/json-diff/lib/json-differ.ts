/** JSON 语义比较与源码定位，差异路径使用 RFC 6901 JSON Pointer。 */
import { parse as parseSourceMap } from "json-source-map";
import {
  compareNumber,
  isSafeNumber,
  LosslessNumber,
  parse,
  stringify,
} from "lossless-json";
import { parseJsonError } from "../../../shared/json-error-parser";

export interface DiffEntry {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
  oldValue?: unknown;
}

export interface DiffResult {
  diffs: DiffEntry[];
  error?: string | null;
  differenceCount: number;
  isDifferent: boolean;
}

export interface DiffMarker {
  editor: "left" | "right";
  startLine: number;
  startCh: number;
  endLine: number;
  endCh: number;
  color: string;
  className: string;
  diffIndex: number;
  /** 空行或换行符差异使用整行标记。 */
  wholeLine?: boolean;
}

function parseDocument(text: string): unknown {
  return parse(text, undefined, {
    parseNumber: (value) =>
      isSafeNumber(value) ? Number(value) : new LosslessNumber(value),
    // 与原有 JSON.parse 行为一致，重复键取最后一个值。
    onDuplicateKey: ({ newValue }) => newValue,
  });
}

export function formatJson(text: string): string {
  return stringify(parseDocument(text), undefined, 2) ?? "";
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof LosslessNumber)
  );
}

function compareValues(
  left: unknown,
  right: unknown,
  path: string,
  diffs: DiffEntry[],
) {
  if (left === right) return;
  const leftNumeric =
    typeof left === "number" || left instanceof LosslessNumber;
  const rightNumeric =
    typeof right === "number" || right instanceof LosslessNumber;
  if (
    leftNumeric &&
    rightNumeric &&
    compareNumber(String(left), String(right)) === 0
  )
    return;
  if (
    isContainer(left) &&
    isContainer(right) &&
    Array.isArray(left) === Array.isArray(right)
  ) {
    // 数组删除从末尾开始，导出的 JSON Patch 可按顺序应用。
    for (const key of Object.keys(left).reverse()) {
      const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (Object.hasOwn(right, key))
        compareValues(left[key], right[key], childPath, diffs);
      else diffs.push({ op: "remove", path: childPath, oldValue: left[key] });
    }
    for (const key of Object.keys(right)) {
      if (!Object.hasOwn(left, key)) {
        const childPath = `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        diffs.push({ op: "add", path: childPath, value: right[key] });
      }
    }
    return;
  }
  diffs.push({ op: "replace", path, value: right, oldValue: left });
}

export function compareJson(leftText: string, rightText: string): DiffResult {
  const empty: DiffResult = {
    diffs: [],
    error: null,
    differenceCount: 0,
    isDifferent: false,
  };
  if (!leftText.trim() && !rightText.trim()) return empty;
  let left: unknown;
  let right: unknown;
  for (const side of ["left", "right"] as const) {
    const text = side === "left" ? leftText : rightText;
    const label = side === "left" ? "左侧" : "右侧";
    if (!text.trim())
      return { ...empty, error: `请在${label}填入待比对的 JSON 内容` };
    try {
      const value = parseDocument(text);
      if (side === "left") left = value;
      else right = value;
    } catch (error) {
      const detail = parseJsonError(error, text);
      return {
        ...empty,
        error: `${label} JSON 不合法${detail ? ` (第 ${detail.line} 行，第 ${detail.column} 列)` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    const diffs: DiffEntry[] = [];
    compareValues(left, right, "", diffs);
    return {
      diffs,
      error: null,
      differenceCount: diffs.length,
      isDifferent: diffs.length > 0,
    };
  } catch (error) {
    return {
      ...empty,
      error: `对比失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function getDiffMarkers(
  diffs: DiffEntry[],
  leftText: string,
  rightText: string,
): DiffMarker[] {
  const markers: DiffMarker[] = [];
  if (!diffs.length) return markers;
  try {
    const maps = {
      left: parseSourceMap(leftText),
      right: parseSourceMap(rightText),
    };
    const texts = { left: leftText, right: rightText };
    const lineStarts = { left: [0], right: [0] };
    for (const side of ["left", "right"] as const) {
      for (const match of texts[side].matchAll(/\n/g))
        lineStarts[side].push(match.index + 1);
    }
    diffs.forEach((diff, diffIndex) => {
      const sides: Array<"left" | "right"> =
        diff.op === "replace"
          ? ["left", "right"]
          : [diff.op === "remove" ? "left" : "right"];
      for (const side of sides) {
        const pointer = maps[side].pointers[diff.path];
        const start =
          diff.op === "replace"
            ? pointer?.value
            : (pointer?.key ?? pointer?.value);
        const end = pointer?.valueEnd;
        if (!start || !end) continue;
        markers.push({
          editor: side,
          startLine: start.line,
          endLine: end.line,
          // json-source-map 的 column 将 tab 算作 4 列，CodeMirror 使用字符偏移。
          startCh: start.pos - lineStarts[side][start.line],
          endCh: end.pos - lineStarts[side][end.line],
          color:
            diff.op === "replace"
              ? "#E5E833"
              : side === "left"
                ? "#DD4444"
                : "#4ba2ff",
          className:
            diff.op === "replace" ? "diff-mark-replace" : `diff-mark-${side}`,
          diffIndex,
        });
      }
    });
  } catch {
    // 语法错误由 compareJson 报告，定位失败时保留差异明细。
  }
  return markers;
}
