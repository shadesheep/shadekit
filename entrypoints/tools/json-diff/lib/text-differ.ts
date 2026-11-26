import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import type { DiffEntry, DiffMarker, DiffResult } from "./json-differ";

/** 文本按差异块计数，块内保留字符级高亮。限制搜索开销以处理大段不同文本。 */
export function compareText(
  left: string,
  right: string,
): DiffResult & { markers: DiffMarker[]; precise: boolean } {
  const a = Text.of(left.split(/\r\n?|\n/));
  const b = Text.of(right.split(/\r\n?|\n/));
  const chunks = Chunk.build(a, b, { scanLimit: 1000, timeout: 100 });
  const diffs: DiffEntry[] = [];
  const markers: DiffMarker[] = [];
  chunks.forEach((chunk, diffIndex) => {
    const op = chunk.changes.every((c) => c.fromA === c.toA)
      ? "add"
      : chunk.changes.every((c) => c.fromB === c.toB)
        ? "remove"
        : "replace";
    diffs.push({
      op,
      path: `第 ${a.lineAt(Math.min(chunk.fromA, a.length)).number} / ${b.lineAt(Math.min(chunk.fromB, b.length)).number} 行`,
      oldValue: a.sliceString(chunk.fromA, chunk.endA),
      value: b.sliceString(chunk.fromB, chunk.endB),
    });
    for (const change of chunk.changes) {
      for (const side of ["left", "right"] as const) {
        const doc = side === "left" ? a : b;
        const offset = side === "left" ? chunk.fromA : chunk.fromB;
        const from = offset + (side === "left" ? change.fromA : change.fromB);
        const to = offset + (side === "left" ? change.toA : change.toB);
        if (from === to) continue;
        const start = doc.lineAt(from);
        const end = doc.lineAt(to);
        markers.push({
          editor: side,
          startLine: start.number - 1,
          startCh: from - start.from,
          endLine: end.number - 1,
          endCh: to - end.from,
          wholeLine: doc.sliceString(from, to).trim().length === 0,
          color: side === "left" ? "#DD4444" : "#4ba2ff",
          className: `diff-mark-${side}`,
          diffIndex,
        });
      }
    }
  });
  return {
    diffs,
    markers,
    error: null,
    differenceCount: chunks.length,
    isDifferent: chunks.length > 0,
    precise: chunks.every((c) => c.precise),
  };
}
