import { describe, expect, it } from "vitest";
import { guardConfigSavePatch } from "../entrypoints/tools/account-switch/config-save-guard";

/**
 * 配置加载失败时表单停在空集合上，保存入口必须被阻断，
 * 否则空 accounts/domains 会被写回，造成静默数据丢失。
 */
describe("加载失败时阻止保存补丁", () => {
  it("失败状态拒绝空集合补丁，不会提交空 accounts/domains", () => {
    expect(
      guardConfigSavePatch("配置读取失败", { accounts: [], domains: {} }),
    ).toBeNull();
    expect(
      guardConfigSavePatch("保险库不可用", { globalDefaultPassword: "new-secret" }),
    ).toBeNull();
  });

  it("成功加载后才放行补丁（包括合法的空集合保存）", () => {
    const patch = { accounts: [], domains: {} };
    expect(guardConfigSavePatch("", patch)).toBe(patch);
  });
});
