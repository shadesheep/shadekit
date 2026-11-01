import { describe, expect, it } from "vitest";
import { sanitizeFields } from "../entrypoints/tools/mock-data/lib/generators";
import { enabledFields } from "../entrypoints/mock-data/lib/field-shelf";
import type { MockField } from "../entrypoints/tools/mock-data/lib/types";

const base: MockField = {
  id: "1", key: "name", type: "name", params: {},
};

describe("enabled 透传", () => {
  it("enabled 缺省视为启用，false 被过滤", () => {
    const fields = sanitizeFields([base, { ...base, id: "2", key: "age", enabled: false }]);
    expect(enabledFields(fields).map((f) => f.key)).toEqual(["name"]);
  });
  it("sanitizeFields 透传 enabled，不丢失", () => {
    const [f] = sanitizeFields([{ ...base, key: "age", enabled: false }]);
    expect(f).toMatchObject({ key: "age", enabled: false });
  });
  it("enabled true 保留在 results", () => {
    const fields = sanitizeFields([base, { ...base, id: "2", key: "age", enabled: true }]);
    expect(enabledFields(fields)).toHaveLength(2);
  });
});