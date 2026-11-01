import { describe, expect, it } from "vitest";
import invalid from "../docs/contracts/examples/v2-invalid.json";
import valid from "../docs/contracts/examples/v2-valid.json";
import {
  LOGIN_SPEC_VERSION,
  SPEC_OP_NAMES,
} from "../entrypoints/tools/account-switch/spec/types";
import { validateLoginSpec } from "../entrypoints/tools/account-switch/spec/validate";

describe("LoginSpec v2 public contract examples", () => {
  it("covers all 17 v2 operators with valid and invalid public examples", () => {
    expect(LOGIN_SPEC_VERSION).toBe(2);
    expect(
      new Set(valid.flatMap((entry) => entry.spec.ops.map((op) => op.op))),
    ).toEqual(new Set(SPEC_OP_NAMES));
    expect(SPEC_OP_NAMES).toHaveLength(17);
    for (const entry of valid) {
      expect(validateLoginSpec(entry.spec), entry.name).toEqual([]);
    }
    for (const entry of invalid) {
      expect(validateLoginSpec(entry.spec)[0]?.message, entry.name).toContain(
        entry.message,
      );
    }
  });
});
