import { describe, expect, it } from "vitest";
import { sanitizeFields } from "../entrypoints/tools/mock-data/lib/generators";
import { generateTestCases } from "../entrypoints/tools/mock-data/lib/test-cases";

const OPTIONS = {
  seed: "inferred-seed",
  timeZone: "UTC",
  inferFromSampling: true,
};

describe("按取样推导测试用例", () => {
  it("数值字段用取样上下限生成两条通过用例", () => {
    const fields = sanitizeFields([
      { key: "age", type: "age", params: { min: 18, max: 60 } },
    ]);
    const set = generateTestCases(fields, OPTIONS);
    const numeric = set.cases.filter((item) => item.kind === "numeric");
    expect(
      numeric.map((item) => [item.value, item.expected, item.source]),
    ).toEqual([
      [18, "pass", "inferred"],
      [60, "pass", "inferred"],
    ]);
    expect(set.issues).toEqual([]);
  });

  it("字符串与数组按取样长度生成最小值/最大值用例", () => {
    const fields = sanitizeFields([
      { key: "text", type: "string", params: { length: "1,3,8-12" } },
      { key: "items", type: "array", params: { minItems: 0, maxItems: 4 } },
    ]);
    const set = generateTestCases(fields, OPTIONS);
    expect(
      set.cases
        .filter((item) => item.kind === "length" && item.fieldKey === "text")
        .map((item) => [item.value, item.expected]),
    ).toEqual([
      [1, "pass"],
      [12, "pass"],
    ]);
    expect(
      set.cases
        .filter((item) => item.kind === "length" && item.fieldKey === "items")
        .map((item) => [item.value, item.expected]),
    ).toEqual([
      [0, "pass"],
      [4, "pass"],
    ]);
  });

  it("按字段类型生成类型不符用例，不推导缺失或 null", () => {
    const fields = sanitizeFields([{ key: "name", type: "name" }]);
    const set = generateTestCases(fields, OPTIONS);
    const input = set.cases.filter((item) => item.kind === "input");
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      present: true,
      expected: "reject",
      source: "inferred",
      value: 123,
    });
    expect(input[0].rule).toEqual({ type: "string" });
  });

  it("时间戳日期按 number 推导类型", () => {
    const fields = sanitizeFields([
      { key: "createdAt", type: "date", params: { format: "timestamp" } },
    ]);
    const set = generateTestCases(fields, OPTIONS);
    const input = set.cases.filter((item) => item.kind === "input");
    expect(input).toHaveLength(1);
    expect(input[0].rule).toEqual({ type: "number" });
    expect(input[0].value).toBe("not-a-number");
  });

  it("显式规则优先于取样推导", () => {
    const fields = sanitizeFields([
      {
        key: "age",
        type: "age",
        params: { min: 18, max: 60 },
        numericRule: { min: 1, max: 10 },
      },
    ]);
    const set = generateTestCases(fields, OPTIONS);
    const numeric = set.cases.filter((item) => item.kind === "numeric");
    expect(numeric.map((item) => item.value)).toEqual([0, 1, 2, 9, 10, 11]);
    expect(numeric.every((item) => item.source === "rule")).toBe(true);
  });

  it("没有可推导字段时给出说明", () => {
    const fields = sanitizeFields([
      { key: "status", type: "enum", params: { values: "a,b" } },
    ]);
    const set = generateTestCases(fields, OPTIONS);
    expect(set.cases).toEqual([]);
    expect(set.issues).toHaveLength(1);
    expect(set.issues[0].message).toContain("没有可推导的测试用例");
  });
});
