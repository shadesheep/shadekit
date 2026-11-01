import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLoginPermissions,
  assertRuntimeTarget,
  getMissingPermissions,
  registerEnvironmentPlan,
  requestEnvironmentPermissions,
} from "../entrypoints/tools/account-switch/permissions/permission-gateway";
import type { PermissionPlan } from "../entrypoints/tools/account-switch/permissions/permission-planner";

const contains = vi.fn(async (_details: { origins: string[] }) => true);
const request = vi.fn(async (_details: { origins: string[] }) => true);

vi.stubGlobal("chrome", { permissions: { contains, request } });

const plan: PermissionPlan = {
  patterns: ["https://app.test/*", "https://api.test/*"],
  displayOrigins: ["https://app.test", "https://api.test"],
  dynamicTargets: [],
  warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  contains.mockResolvedValue(true);
  request.mockResolvedValue(true);
});

describe("登录权限网关", () => {
  it("只返回缺失 origins，授权满足时无副作用", async () => {
    contains.mockImplementation(async ({ origins }: { origins: string[] }) => origins[0] === "https://app.test/*");
    await expect(getMissingPermissions(plan)).resolves.toEqual(["https://api.test"]);
    await expect(assertLoginPermissions(plan)).rejects.toMatchObject({
      code: "HOST_PERMISSION_REQUIRED", missingOrigins: ["https://api.test"],
    });
  });

  it("运行时新 origin 在宿主副作用前拒绝", async () => {
    contains.mockResolvedValue(false);
    await expect(assertRuntimeTarget("https://new-api.test/login?secret=hidden")).rejects.toMatchObject({
      code: "HOST_PERMISSION_REQUIRED", missingOrigins: ["https://new-api.test"],
    });
  });

  it("已授权时直接成功，缺失时才显式申请完整环境权限", async () => {
    registerEnvironmentPlan("https://app.test", plan);
    await expect(requestEnvironmentPermissions("https://app.test")).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();

    contains.mockResolvedValue(false);
    await expect(requestEnvironmentPermissions("https://app.test")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: plan.patterns });

    request.mockResolvedValue(false);
    await expect(requestEnvironmentPermissions("https://app.test")).rejects.toMatchObject({ code: "HOST_PERMISSION_DENIED" });
  });
});
