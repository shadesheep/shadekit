/**
 * generic-runner — 插值工具（ADR-0012 D1）
 *
 * 算子编排、轨迹、错误码由 spec 引擎统一承担（覆盖见
 * `tests/login-spec-run.test.ts`）。本模块只保留：
 * - `interpolateTemplate`：旧 recipe 单步试跑（generic-dry-run）与存量环境复用
 * - `buildRecipeVariables`：基础变量表（key 收窄到 `RecipeVariableName`）
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildRecipeVariables,
  interpolateTemplate,
} from "../entrypoints/tools/account-switch/strategies/generic-runner";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";

function buildCtx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tabId: 5,
    origin: "https://example.com",
    domainConfig: {
      name: "env",
      tags: [],
      debugRedirect: "http://localhost:8888",
    },
    credentials: { username: "alice", password: "p@ss" },
    tokenData: null,
    ...overrides,
  };
}

describe("interpolateTemplate", () => {
  it("账号 / origin 等基础变量", () => {
    expect(
      interpolateTemplate("{origin}/login?u={username}", {
        origin: "https://example.com",
        username: "alice",
      }),
    ).toBe("https://example.com/login?u=alice");
  });

  it("引用前序步骤输出 {step.<as>.<field>}", () => {
    expect(
      interpolateTemplate("Bearer {step.login.token}", {
        step: { login: { token: "t-1" } },
      }),
    ).toBe("Bearer t-1");
  });

  it("未知占位符原样保留", () => {
    expect(interpolateTemplate("{missing}", {})).toBe("{missing}");
  });

  it("null / undefined 命中值渲染为空串（不出现 'null'）", () => {
    expect(interpolateTemplate("[{a}][{b}]", { a: null, b: undefined })).toBe(
      "[][]",
    );
  });

  it("路径中间节点缺失时原样保留整个占位符", () => {
    expect(interpolateTemplate("{step.nope.token}", { step: {} })).toBe(
      "{step.nope.token}",
    );
  });
});

describe("buildRecipeVariables", () => {
  it("暴露 origin / 账号 / tabId 等基础变量", () => {
    const vars = buildRecipeVariables(buildCtx());
    expect(vars).toMatchObject({
      origin: "https://example.com",
      username: "alice",
      password: "p@ss",
      debugRedirect: "http://localhost:8888",
      tabId: "5",
    });
  });

  it("未配置 debugRedirect 时为空串（不是 undefined）", () => {
    const vars = buildRecipeVariables(
      buildCtx({
        domainConfig: { name: "env", tags: [] },
      }),
    );
    expect(vars.debugRedirect).toBe("");
  });

  it("变量表可直接用于插值（密码只在本进程内存中）", () => {
    vi.stubGlobal("chrome", {});
    const vars = buildRecipeVariables(buildCtx());
    expect(interpolateTemplate("{username}:{password}", vars)).toBe(
      "alice:p@ss",
    );
  });
});
