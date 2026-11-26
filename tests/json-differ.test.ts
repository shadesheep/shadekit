import { applyPatch } from "fast-json-patch";
import { parse, stringify } from "lossless-json";
import { describe, expect, it } from "vitest";
import {
  compareJson,
  type DiffEntry,
  getDiffMarkers,
} from "../entrypoints/tools/json-diff/lib/json-differ";

describe("compareJson", () => {
  it("returns no diff for identical JSON", () => {
    const result = compareJson('{"a": 1}', '{"a": 1}');
    expect(result.isDifferent).toBe(false);
    expect(result.differenceCount).toBe(0);
    expect(result.error).toBeNull();
  });

  it("detects added keys", () => {
    const result = compareJson('{"a": 1}', '{"a": 1, "b": 2}');
    expect(result.isDifferent).toBe(true);
    expect(result.differenceCount).toBe(1);
    expect(result.diffs[0].op).toBe("add");
  });

  it("detects removed keys", () => {
    const result = compareJson('{"a": 1, "b": 2}', '{"a": 1}');
    expect(result.isDifferent).toBe(true);
    expect(result.differenceCount).toBe(1);
    expect(result.diffs[0].op).toBe("remove");
  });

  it("detects replaced values", () => {
    const result = compareJson('{"a": 1}', '{"a": 2}');
    expect(result.isDifferent).toBe(true);
    expect(result.differenceCount).toBe(1);
    expect(result.diffs[0].op).toBe("replace");
  });

  it("returns error for invalid left JSON", () => {
    const result = compareJson("{invalid}", '{"a": 1}');
    expect(result.error).toContain("左侧 JSON");
  });

  it("returns error for invalid right JSON", () => {
    const result = compareJson('{"a": 1}', "{invalid}");
    expect(result.error).toContain("右侧 JSON");
  });

  it("returns empty diff for both empty inputs", () => {
    const result = compareJson("", "");
    expect(result.isDifferent).toBe(false);
    expect(result.differenceCount).toBe(0);
  });

  it("returns error when left is empty and right is not", () => {
    const result = compareJson("", '{"a": 1}');
    expect(result.error).toContain("左侧");
  });

  it("returns error when right is empty and left is not", () => {
    const result = compareJson('{"a": 1}', "");
    expect(result.error).toContain("右侧");
  });

  it("handles nested objects", () => {
    const result = compareJson('{"a": {"b": 1}}', '{"a": {"b": 1, "c": 2}}');
    expect(result.isDifferent).toBe(true);
    const diff = result.diffs[0] as DiffEntry;
    expect(diff.path).toBe("/a/c");
    expect(diff.op).toBe("add");
  });

  it("handles arrays", () => {
    const result = compareJson("[1, 2]", "[1, 2, 3]");
    expect(result.isDifferent).toBe(true);
    expect(result.diffs.some((d) => d.op === "add")).toBe(true);
  });

  it("trims whitespace before parsing", () => {
    const result = compareJson('  {"a": 1}  ', '  {"a": 1}  ');
    expect(result.isDifferent).toBe(false);
  });

  it.each([
    ["false", "0"],
    ["null", "{}"],
    ["1", "2"],
    ['"hello"', '"world"'],
    ["[]", "{}"],
    ["{}", "[]"],
    ["null", "false"],
    ['""', "null"],
  ])("compares root values %s and %s as one replacement", (left, right) => {
    const result = compareJson(left, right);
    expect(result.error).toBeNull();
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({ op: "replace", path: "" });
    expect(getDiffMarkers(result.diffs, left, right)).toHaveLength(2);
  });

  it.each(["false", "0", "null", '""', "1", "[]", "{}"])(
    "accepts identical root %s",
    (text) => {
      expect(compareJson(text, text)).toMatchObject({
        error: null,
        isDifferent: false,
      });
    },
  );

  it.each([
    ["9007199254740992", "9007199254740993"],
    ["-9007199254740992", "-9007199254740993"],
    ["0.12345678901234567890", "0.12345678901234567891"],
    ["1e400", "2e400"],
  ])("preserves numeric differences between %s and %s", (left, right) => {
    const result = compareJson(`{"id":${left}}`, `{"id":${right}}`);
    expect(result.error).toBeNull();
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0].path).toBe("/id");
  });

  it.each([
    ["1", "1.0"],
    ["1000", "1e3"],
    ["-0", "0"],
    ["9007199254740993", "9.007199254740993e15"],
  ])("compares equivalent number spellings %s and %s", (left, right) => {
    expect(compareJson(left, right)).toMatchObject({
      error: null,
      isDifferent: false,
    });
  });

  it("keeps numeric values distinct from strings and objects", () => {
    expect(compareJson("1", '"1"').isDifferent).toBe(true);
    expect(
      compareJson("1", '{"value":"1","isLosslessNumber":true}').isDifferent,
    ).toBe(true);
  });

  it("preserves own prototype-named keys and JSON Pointer escaping", () => {
    const result = compareJson(
      '{"__proto__":{"x":1},"a/b~":1}',
      '{"__proto__":{"x":2},"a/b~":2}',
    );
    expect(result.diffs.map((d) => d.path).sort()).toEqual([
      "/__proto__/x",
      "/a~1b~0",
    ]);
    expect(
      getDiffMarkers(
        result.diffs,
        '{"__proto__":{"x":1},"a/b~":1}',
        '{"__proto__":{"x":2},"a/b~":2}',
      ),
    ).toHaveLength(4);
  });

  it("marks deleted array values and retains their navigation index", () => {
    const left = "[\n  1,\n  2,\n  3\n]";
    const right = "[\n  1,\n  2\n]";
    const result = compareJson(left, right);
    expect(getDiffMarkers(result.diffs, left, right)).toEqual([
      expect.objectContaining({
        editor: "left",
        startLine: 3,
        startCh: 2,
        endCh: 3,
        diffIndex: 0,
      }),
    ]);
  });

  it("uses character columns for tab-indented JSON", () => {
    const left = '{\n\t"a": 1\n}';
    const right = '{\n\t"a": 2\n}';
    const result = compareJson(left, right);
    expect(getDiffMarkers(result.diffs, left, right)).toEqual([
      expect.objectContaining({
        editor: "left",
        startLine: 1,
        startCh: 6,
        endCh: 7,
      }),
      expect.objectContaining({
        editor: "right",
        startLine: 1,
        startCh: 6,
        endCh: 7,
      }),
    ]);
  });
});

describe("JSON Patch 导出兼容性", () => {
  it.each([
    ["[1,2,3,4]", "[5]"],
    ["[]", "[1,2,3]"],
    ['{"a":{"b":1},"deleted":true}', '{"a":[1,2],"new":false}'],
    ["null", "[1,2]"],
  ])("applies operations from %s to %s in order", (left, right) => {
    const result = compareJson(left, right);
    const patch = result.diffs.map(({ op, path, value }) =>
      op === "remove" ? { op, path } : { op, path, value },
    );
    expect(applyPatch(JSON.parse(left), patch).newDocument).toEqual(
      JSON.parse(right),
    );
  });

  it("serializes unsafe numbers in patches without rounding", () => {
    const result = compareJson('{"id":1}', '{"id":9007199254740993}');
    const serialized = stringify(
      result.diffs.map(({ op, path, value }) => ({ op, path, value })),
    )!;
    expect(serialized).toContain("9007199254740993");
    expect(stringify(parse(serialized))).toBe(serialized);
  });
});
