import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, migrateConfig } from "../entrypoints/shared/tool-config";

describe("完整备份配置版本", () => {
  it("v3 保留 v2 公共配置，秘密引用由受控导入事务处理", () => {
    expect(CONFIG_VERSION).toBe(3);
    const account = { accounts: [], domains: {}, envBadge: { enabled: false } };
    expect(migrateConfig({ __version: 2, "account-switch": account })).toEqual({
      __version: 3,
      "account-switch": account,
    });
  });
});
