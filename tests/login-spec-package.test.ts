/**
 * login-spec/package — 配置包导入导出（ADR-0015 D9）
 *
 * 纯函数单测：零浏览器 API、零 chrome stub。
 * 覆盖：导出拒 `script`（指出下标）、拒 `secret` 变量、`requiredVars ⊆
 * spec.vars` 双向校验、导入版本过高拒绝、格式校验、不含账号绑定。
 */
import { describe, expect, it } from "vitest";
import type { DomainConfig } from "../entrypoints/tools/account-switch/types";
import type { LoginSpec, SpecOp } from "../entrypoints/tools/account-switch/spec/types";
import {
  buildConfigPackage,
  configPackageVersion,
  findScriptOps,
  validateConfigPackage,
} from "../entrypoints/tools/account-switch/spec/package";

const BASE_OPS: SpecOp[] = [
  {
    op: "http.execute",
    url: "{origin}/login",
    method: "POST",
    body: { json: { username: "{username}", password: "{password}" } },
    as: "resp",
  },
];

function spec(overrides: Partial<LoginSpec> = {}): LoginSpec {
  return {
    version: 2,
    ops: BASE_OPS,
    success: [{ response: { from: "resp", path: "ok" } }],
    auth: { mode: "engine" },
    ...overrides,
  };
}

function domain(overrides: Partial<DomainConfig> = {}): DomainConfig {
  const base: DomainConfig = {
    name: "dev",
    tags: [],
    loginMethod: "generic",
    strategyConfig: { spec: spec() },
  };
  return { ...base, ...overrides };
}

function _messages(issues: { message: string }[]): string[] {
  return issues.map((i) => i.message);
}

describe("configPackageVersion — format 解析", () => {
  it("dt-login-config/v1 → 1", () => {
    expect(configPackageVersion("dt-login-config/v1")).toBe(1);
  });
  it("非配置包 / 非字符串 → undefined", () => {
    expect(configPackageVersion("foo")).toBeUndefined();
    expect(configPackageVersion(undefined)).toBeUndefined();
  });
});

describe("buildConfigPackage — 导出", () => {
  it("可导出的环境 → 产出一份合规包（含 env 与 requiredVars，不含账号）", () => {
    const d = domain({
      strategyConfig: {
        spec: spec({
          vars: [
            { name: "publicKey", title: "公钥" },
            { name: "apiHost", title: "地址" },
          ],
        }),
      },
    });
    const { package: pkg, issues } = buildConfigPackage(d, "https://example.com", ["publicKey"]);
    expect(issues).toEqual([]);
    expect(pkg).toBeDefined();
    expect(pkg!.format).toBe("dt-login-config/v1");
    expect(pkg!.environments).toHaveLength(1);
    expect(pkg!.environments[0].name).toBe("dev");
    // 包不携带账号绑定 / 账号数据（只有环境声明 + spec + 变量声明）
    expect(pkg).not.toHaveProperty("accounts");
    expect(pkg!.environments[0]).not.toHaveProperty("account");
    expect(pkg!.environments[0].spec.ops).toEqual(BASE_OPS);
    // requiredVars ⊆ spec.vars 生效
    expect(pkg!.requiredVars).toEqual([{ name: "publicKey", title: "公钥" }]);
  });

  it("导出含 script → 拒绝并指出第几步", () => {
    const d = domain({
      strategyConfig: {
        spec: spec({
          ops: [
            ...BASE_OPS,
            { op: "script", code: "(b) => ({x:1})", as: "s" },
          ],
        }),
      },
    });
    const { package: pkg, issues } = buildConfigPackage(d, "https://example.com", []);
    expect(pkg).toBeUndefined();
    // script 在 base(1) + 1 = index 1（0 基）
    expect(issues).toHaveLength(1);
    expect(issues[0].opIndex).toBe(1);
    expect(issues[0].message).toContain("script");
  });

  it("findScriptOps 定位到每个 script 步", () => {
    const issues = findScriptOps(
      spec({
        ops: [
          { op: "script", code: "(b)=>({})", as: "a" },
          ...BASE_OPS,
          { op: "script", code: "(b)=>({})", as: "c" },
        ],
      }),
    );
    expect(issues.map((i) => i.opIndex)).toEqual([0, 2]);
  });

  it("导出含 secret 变量 → 拒绝并指出变量名", () => {
    const d = domain({
      strategyConfig: {
        spec: spec({
          vars: [{ name: "signKey", secret: true }],
        }),
      },
    });
    const { package: pkg, issues } = buildConfigPackage(d, "https://example.com", []);
    expect(pkg).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0].varName).toBe("signKey");
    expect(issues[0].message).toContain("secret");
  });

  it("requiredVars 含 spec.vars 之外的变量 → 拒绝", () => {
    const d = domain({
      strategyConfig: {
        spec: spec({ vars: [{ name: "publicKey" }] }),
      },
    });
    const { package: pkg, issues } = buildConfigPackage(d, "https://example.com", ["typo"]);
    expect(pkg).toBeUndefined();
    expect(issues.some((i) => i.varName === "typo")).toBe(true);
  });

  it("无 spec → 拒绝", () => {
    const d = domain({ strategyConfig: {} });
    const { issues } = buildConfigPackage(d, "https://example.com", []);
    expect(issues.some((i) => i.message.includes("spec"))).toBe(true);
  });
});

describe("validateConfigPackage — 导入", () => {
  function validRaw(): unknown {
    return {
      format: "dt-login-config/v1",
      specVersion: 2,
      requiredVars: [{ name: "publicKey" }],
      environments: [
        {
          name: "dev",
          url: "https://dev.example.com",
          spec: spec({
            vars: [{ name: "publicKey" }],
          }),
        },
      ],
    };
  }

  it("合规包 → 无问题", () => {
    expect(validateConfigPackage(validRaw())).toEqual([]);
  });

  it("非对象 → CONFIG_INVALID", () => {
    const issues = validateConfigPackage(null);
    expect(issues[0].code).toBe("CONFIG_INVALID");
  });

  it("格式不对 → 拒绝并说明", () => {
    const issues = validateConfigPackage({
      format: "dt-login-config/v0",
      environments: [],
      specVersion: 2,
    });
    expect(issues[0].code).toBe("CONFIG_INVALID");
    expect(issues[0].message).toContain("dt-login-config/v1");
  });

  it("specVersion 高于当前 → 拒绝并说明『先升级扩展』", () => {
    const raw = validRaw() as Record<string, unknown>;
    raw.specVersion = 99;
    const issues = validateConfigPackage(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("CONFIG_INVALID");
    expect(issues[0].message).toContain("高于当前扩展");
  });

  it("导入含 script 的包 → CONFIG_INVALID 指出步骤", () => {
    const raw = validRaw() as Record<string, unknown>;
    const envs = raw.environments as { spec: LoginSpec }[];
    envs[0].spec = spec({
      ops: [...BASE_OPS, { op: "script", code: "(b)=>({})", as: "s" }],
    });
    raw.requiredVars = []; // 替换 spec 后 publicKey 不再声明；清空避免额外噪音
    const issues = validateConfigPackage(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("CONFIG_INVALID");
    expect(issues[0].opIndex).toBe(1);
    expect(issues[0].message).toContain("script");
  });

  it("导入含 secret 变量的包 → CONFIG_INVALID 直接拒绝", () => {
    const raw = validRaw() as Record<string, unknown>;
    const envs = raw.environments as { spec: LoginSpec }[];
    envs[0].spec = spec({ vars: [{ name: "signKey", secret: true }] });
    raw.requiredVars = [];
    const issues = validateConfigPackage(raw);
    expect(issues.some((i) => i.code === "CONFIG_INVALID")).toBe(true);
    expect(issues.some((i) => i.varName === "signKey")).toBe(true);
  });

  it("包级 requiredVars ⊆ spec.vars 校验（二次校验）", () => {
    const raw = validRaw() as Record<string, unknown>;
    raw.requiredVars = [{ name: "typo" }]; // 不在 spec.vars
    const issues = validateConfigPackage(raw);
    expect(issues.some((i) => i.varName === "typo")).toBe(true);
  });

  it("空环境列表 → 拒绝", () => {
    const issues = validateConfigPackage({
      format: "dt-login-config/v1",
      specVersion: 2,
      environments: [],
    });
    expect(issues.some((i) => i.message.includes("不含任何环境"))).toBe(true);
  });
});