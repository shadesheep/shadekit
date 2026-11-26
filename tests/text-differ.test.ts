import { describe, expect, it } from "vitest";
import { buildDiffPositions } from "../entrypoints/tools/json-diff/lib/diff-nav";
import { compareText } from "../entrypoints/tools/json-diff/lib/text-differ";

describe("文本对比", () => {
  it.each(["", "hello", "中文 😀\n\nend"])(
    "recognizes identical text %s",
    (text) => {
      expect(compareText(text, text)).toMatchObject({
        differenceCount: 0,
        isDifferent: false,
        markers: [],
      });
    },
  );
  it.each([
    ["", "hello", "add"],
    ["hello", "", "remove"],
  ])("accepts empty side", (left, right, op) => {
    const result = compareText(left, right);
    expect(result.diffs[0].op).toBe(op);
    expect(buildDiffPositions(result.markers)).toHaveLength(
      result.differenceCount,
    );
  });
  it("keeps whitespace changes and trailing newline visible", () => {
    for (const [left, right] of [
      ["a b", "a  b"],
      ["a", "a\n"],
      ["", "\n"],
      ["a\n", "a\n\n"],
    ]) {
      const result = compareText(left, right);
      expect(result.isDifferent).toBe(true);
      expect(result.markers.length).toBeGreaterThan(0);
      expect(buildDiffPositions(result.markers)).toHaveLength(
        result.differenceCount,
      );
    }
  });
  it("compares line endings consistently with CodeMirror", () => {
    expect(compareText("a\r\nb", "a\nb").isDifferent).toBe(false);
  });
  it("keeps separate changes navigable", () => {
    const middle = Array.from(
      { length: 20 },
      (_, i) => `unchanged line ${i}`,
    ).join("\n");
    const result = compareText(`old\n${middle}\nold`, `new\n${middle}\nnew`);
    expect(result.differenceCount).toBe(2);
    expect(buildDiffPositions(result.markers)).toHaveLength(2);
  });
});
