import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, migrateConfig } from "../entrypoints/shared/tool-config";

describe("完整备份配置版本", () => {
  it("v4 保留旧版公共配置，密码以明文存储", () => {
    expect(CONFIG_VERSION).toBe(4);
    const account = { accounts: [], domains: {}, envBadge: { enabled: false } };
    expect(migrateConfig({ __version: 3, "account-switch": account })).toEqual({
      __version: 4,
      "account-switch": account,
    });
  });
});
