/**
 * login-spec/migrate — 配方 → LoginSpec 迁移链（ADR-0015 D10）
 *
 * 纯函数单测：零浏览器 API、零 chrome stub。
 * 断言的是迁移后的 spec，而不是中间步骤。
 */
import { describe, expect, it } from "vitest";

import {
  migrateSpec,
  readSpecFromConfig,
} from "../entrypoints/tools/account-switch/spec/migrate";
import { validateLoginSpec } from "../entrypoints/tools/account-switch/spec/validate";

const DEFAULT_SETTLE = {
  type: "any" as const,
  of: [{ type: "formGone" as const }, { type: "urlChanged" as const }],
};

function recipe(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    steps: [
      { op: "goto", url: "{origin}/login" },
      { op: "fill", target: "#u", value: "{username}" },
      { op: "fill", target: "#p", value: "{password}" },
      { op: "click", target: "#go" },
    ],
    settle: DEFAULT_SETTLE,
    auth: { mode: "page" },
    ...overrides,
  };
}

function migrated(input: unknown) {
  const result = migrateSpec(input);
  if (!result.ok) {
    throw new Error(`预期迁移成功，实际失败：${result.error}`);
  }
  return result;
}

describe("migrateSpec — 步骤映射", () => {
  it("六种步骤一一对应，frame 范围与可选字段保留", () => {
    const result = migrated(
      recipe({
        steps: [
          { op: "goto", url: "{origin}/login", waitForLoad: false },
          {
            op: "fill",
            target: { ariaLabel: "用户名" },
            value: "{username}",
            clearFirst: false,
            frameId: 3,
            frameUrl: "https://example.com/frame",
          },
          {
            op: "click",
            target: "#go",
            onNotFound: "skip",
            frameUrl: "https://example.com/frame",
          },
          {
            op: "waitFor",
            when: { type: "selector", target: ".ready" },
            timeoutMs: 3000,
          },
          { op: "extract", source: "url", as: "landed" },
          { op: "script", code: "return 1", as: "out" },
        ],
      }),
    );

    const ops = result.spec.ops.slice(1);
    expect(ops[0]).toEqual({
      op: "goto",
      url: "{origin}/login",
      waitForLoad: false,
    });
    expect(ops[1]).toEqual({
      op: "fill",
      target: { ariaLabel: "用户名" },
      value: "{username}",
      clearFirst: false,
      frameId: 3,
      frameUrl: "https://example.com/frame",
    });
    expect(ops[2]).toEqual({
      op: "click",
      target: "#go",
      onNotFound: "skip",
      frameUrl: "https://example.com/frame",
    });
    expect(ops[3]).toEqual({
      op: "waitFor",
      when: { type: "selector", target: ".ready" },
      timeoutMs: 3000,
    });
    expect(ops[4]).toEqual({ op: "extract", source: "url", as: "landed" });
    expect(ops[5]).toMatchObject({ op: "script", as: "out" });
  });

  it("settle → success.page，failWhen → failure 数组", () => {
    const result = migrated(
      recipe({ failWhen: { type: "selector", target: ".error" } }),
    );
    expect(result.spec.success).toEqual([{ page: DEFAULT_SETTLE }]);
    expect(result.spec.failure).toEqual([
      { type: "selector", target: ".error" },
    ]);
  });

  it("extract / script 缺省 as 补为 extract / script", () => {
    const result = migrated(
      recipe({
        steps: [
          { op: "extract", source: "url" },
          { op: "script", code: "return 1" },
        ],
      }),
    );
    const ops = result.spec.ops.slice(1);
    expect(ops[0]).toMatchObject({ op: "extract", as: "extract" });
    expect(ops[1]).toMatchObject({ op: "script", as: "script" });
  });

  it("limits：stepMs / settleMs 保留，pageLoadMs 删除", () => {
    const result = migrated(
      recipe({ limits: { stepMs: 4000, settleMs: 9000, pageLoadMs: 20000 } }),
    );
    expect(result.spec.limits).toEqual({ stepMs: 4000, settleMs: 9000 });
  });

  it("limits 缺失时不写入空对象", () => {
    expect(migrated(recipe()).spec.limits).toBeUndefined();
  });

  it("非法步骤被丢弃并告警（与旧读取路径 normalizeRecipe 等价）", () => {
    const result = migrated(
      recipe({
        steps: [
          { op: "teleport" },
          { op: "click" },
          { op: "click", target: "#go" },
        ],
      }),
    );
    expect(result.spec.ops.filter((op) => op.op === "click")).toEqual([
      { op: "click", target: "#go" },
    ]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("缺 settle / auth 时补零配置默认（旧 normalizeRecipe 的默认值）", () => {
    const result = migrated({
      version: 1,
      steps: [{ op: "click", target: "#go" }],
    });
    expect(result.spec.success).toEqual([{ page: DEFAULT_SETTLE }]);
    expect(result.spec.auth).toEqual({ mode: "page" });
  });

  it("步骤为空 → 拒绝（旧读取路径同样视为非法）", () => {
    for (const steps of [[], "x"]) {
      expect(
        migrateSpec({ version: 1, steps, settle: DEFAULT_SETTLE }).ok,
      ).toBe(false);
    }
  });
});

describe("migrateSpec — extract 来源", () => {
  it('source: "storage" → local，并告警说明消除了 local→session 回退', () => {
    const result = migrated(
      recipe({
        steps: [{ op: "extract", source: "storage", key: "token", as: "tk" }],
      }),
    );
    expect(result.spec.ops.slice(1)[0]).toEqual({
      op: "extract",
      source: "local",
      key: "token",
      as: "tk",
    });
    expect(result.warnings.some((w) => w.includes("sessionStorage"))).toBe(
      true,
    );
  });

  it("dom / url 来源原样保留，不产生告警", () => {
    const result = migrated(
      recipe({
        steps: [
          { op: "extract", source: "dom", key: ".token", as: "a" },
          { op: "extract", source: "url", key: "code", as: "b" },
        ],
      }),
    );
    expect(result.spec.ops.slice(1)).toEqual([
      { op: "extract", source: "dom", key: ".token", as: "a" },
      { op: "extract", source: "url", key: "code", as: "b" },
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe("migrateSpec — script 函数化", () => {
  it("模板字符串形态迁移为函数形态，并标注破坏性变更", () => {
    const result = migrated(
      recipe({ steps: [{ op: "script", code: "return 1", as: "out" }] }),
    );
    const script = result.spec.ops.find((op) => op.op === "script");
    expect(script).toMatchObject({ op: "script" });
    if (script?.op !== "script") {
      throw new Error("迁移结果缺少 script 算子");
    }
    expect(script.code).toContain("(bindings) =>");
    expect(script.code).toContain("return 1");
    expect(result.warnings.some((w) => w.includes("破坏性"))).toBe(true);
  });
});

describe("migrateSpec — 认证声明", () => {
  it('mode: "page" → auth.mode: "page"，不产生捕获恢复算子', () => {
    const result = migrated(recipe());
    expect(result.spec.auth).toEqual({ mode: "page" });
    expect(result.spec.ops.some((op) => op.op.startsWith("auth."))).toBe(false);
  });

  it('mode: "snapshot" → 清理 + capture + goto + restore，范围取自原声明', () => {
    const result = migrated(
      recipe({
        auth: {
          mode: "snapshot",
          cookies: ["auth"],
          cookiesClear: "none",
          localStorage: ["token"],
        },
      }),
    );
    const ops = result.spec.ops;
    expect(ops[0]).toEqual({ op: "clear.cookies", range: "none" });
    expect(ops.filter((op) => op.op === "auth.capture")).toEqual([
      {
        op: "auth.capture",
        as: "snapshot",
        cookies: ["auth"],
        localStorage: ["token"],
      },
    ]);
    const captureIndex = ops.findIndex((op) => op.op === "auth.capture");
    const restoreIndex = ops.findIndex((op) => op.op === "auth.restore");
    expect(restoreIndex).toBeGreaterThan(captureIndex);
    // 落地导航：只有一个目标 origin 的 goto（debugRedirect 优先级归 login-tab-flow）
    expect(ops.slice(captureIndex, restoreIndex + 1)).toEqual([
      {
        op: "auth.capture",
        as: "snapshot",
        cookies: ["auth"],
        localStorage: ["token"],
      },
      { op: "goto", url: "{targetUrl}", when: "{targetUrl}" },
      { op: "auth.restore", snapshot: "snapshot" },
    ]);
    // 迁移后的 spec 不写会话：认证态由页面或快照承载
    expect(ops.some((op) => op.op === "auth.write")).toBe(false);
    expect(result.spec.auth).toEqual({ mode: "page" });
  });

  it("快照声明的 storage 白名单在登录前清理（与旧 clearAuth 等价）", () => {
    const result = migrated(
      recipe({
        auth: {
          mode: "snapshot",
          cookies: "none",
          localStorage: ["token"],
          sessionStorage: ["tmp"],
        },
      }),
    );
    expect(result.spec.ops.slice(0, 3)).toEqual([
      { op: "clear.cookies", range: "all" },
      { op: "clear.storage", area: "local", range: ["token"] },
      { op: "clear.storage", area: "session", range: ["tmp"] },
    ]);
  });

  it("任一 storage 范围为 all → 两种 storage 都清空（旧 clearPageStorage 语义）", () => {
    const result = migrated(
      recipe({
        auth: {
          mode: "snapshot",
          cookies: "none",
          localStorage: ["token"],
          sessionStorage: "all",
        },
      }),
    );
    expect(result.spec.ops.slice(1, 3)).toEqual([
      { op: "clear.storage", area: "local", range: "all" },
      { op: "clear.storage", area: "session", range: "all" },
    ]);
  });

  it("storage 范围缺省（none）时不产生 clear.storage", () => {
    const result = migrated(
      recipe({ auth: { mode: "snapshot", cookies: "all" } }),
    );
    expect(result.spec.ops.some((op) => op.op === "clear.storage")).toBe(false);
  });
});

describe("readSpecFromConfig — 旧 8 个扁平参数", () => {
  const legacy = {
    loginPageUrl: "{origin}/login",
    pageLoadSelector: "#app-ready",
    usernameSelector: "#u",
    passwordSelector: "#p",
    submitSelector: "#go",
    successType: "selector",
    successValue: ".welcome",
    successTimeout: 8000,
    authSource: "localStorage",
    authKey: "auth",
  };

  it("全字段配置：导航 / 等待 / 填充 / 点击 / 成功判定 / limits 全部落地", () => {
    const result = readSpecFromConfig({ strategyParams: legacy });

    expect(result.invalid).toBeUndefined();
    expect(result.migrated).toBe(true);
    // localStorage 认证源在旧管线里同时声明了「登录前清理这些键」
    expect(result.spec!.ops.slice(0, 7)).toEqual([
      { op: "clear.cookies", range: "all" },
      { op: "clear.storage", area: "local", range: ["auth"] },
      { op: "goto", url: "{origin}/login" },
      { op: "waitFor", when: { type: "selector", target: "#app-ready" } },
      { op: "fill", target: "#u", value: "{username}", clearFirst: true },
      { op: "fill", target: "#p", value: "{password}", clearFirst: true },
      { op: "click", target: "#go", onNotFound: "fail" },
    ]);
    expect(result.spec!.success).toEqual([
      { page: { type: "selector", target: ".welcome" } },
    ]);
    expect(result.spec!.limits).toEqual({ settleMs: 8000 });
  });

  it("空配置：默认填充与提交，settle 用零配置默认，页面自管", () => {
    const result = readSpecFromConfig({
      strategyParams: { loginPageUrl: "/login" },
    });

    const spec = result.spec!;
    expect(spec.ops.filter((op) => op.op === "fill")).toHaveLength(2);
    expect(spec.ops.filter((op) => op.op === "click")).toHaveLength(1);
    expect(spec.success).toEqual([{ page: DEFAULT_SETTLE }]);
    expect(spec.auth).toEqual({ mode: "page" });
  });

  it("缺失的输入框 / 按钮选择器补默认值，账号密码用变量引用", () => {
    const result = readSpecFromConfig({
      strategyParams: { loginPageUrl: "/login" },
    });

    const fills = result.spec!.ops.filter((op) => op.op === "fill");
    expect(fills[0]).toMatchObject({
      target: 'input[name="username"], input[name="account"], #username',
      value: "{username}",
    });
    expect(fills[1]).toMatchObject({
      target: 'input[type="password"], #password',
      value: "{password}",
    });
    expect(result.spec!.ops.find((op) => op.op === "click")).toMatchObject({
      target: 'button[type="submit"], input[type="submit"], .login-btn',
    });
  });

  it('authSource: "cookie" → extract(source: "cookie")，不再误映射为 storage', () => {
    const result = readSpecFromConfig({
      strategyParams: { authSource: "cookie", authKey: "sid" },
    });

    expect(result.spec!.ops).toContainEqual({
      op: "extract",
      source: "cookie",
      key: "sid",
      as: "auth",
    });
    expect(
      result.spec!.ops.some(
        (op) => op.op === "extract" && op.source !== "cookie",
      ),
    ).toBe(false);
    // cookie 快照仍需在登录后捕获，供跨 origin 恢复
    expect(result.spec!.ops.some((op) => op.op === "auth.capture")).toBe(true);
  });

  it('authSource: "localStorage" 产生「已改为显式 local」的告警', () => {
    const result = readSpecFromConfig({
      strategyParams: { authSource: "localStorage", authKey: "tk" },
    });
    expect(result.warnings.some((w) => w.includes("sessionStorage"))).toBe(
      true,
    );
  });

  it('authSource: "localStorage" / "sessionStorage" 分别映射到 local / session', () => {
    const local = readSpecFromConfig({
      strategyParams: { authSource: "localStorage", authKey: "tk" },
    });
    expect(local.spec!.ops).toContainEqual({
      op: "extract",
      source: "local",
      key: "tk",
      as: "auth",
    });

    const session = readSpecFromConfig({
      strategyParams: { authSource: "sessionStorage", authKey: "tk" },
    });
    expect(session.spec!.ops).toContainEqual({
      op: "extract",
      source: "session",
      key: "tk",
      as: "auth",
    });
  });

  it("authSource 有值但 authKey 为空 → 页面自管，不猜测键名", () => {
    const result = readSpecFromConfig({
      strategyParams: { authSource: "cookie", authKey: "  " },
    });
    expect(result.spec!.auth).toEqual({ mode: "page" });
    expect(result.spec!.ops.some((op) => op.op === "extract")).toBe(false);
  });

  it("successType 的四种来源映射到对应结算条件", () => {
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [
        { successType: "url", successValue: "*/dashboard*" },
        { type: "url", glob: "*/dashboard*" },
      ],
      [
        { successType: "cookie", successValue: "sid" },
        { type: "cookie", name: "sid" },
      ],
      [
        { successType: "localStorage", successValue: "tk" },
        { type: "storage", area: "local", key: "tk" },
      ],
      [
        { successType: "timeout", successValue: "1500" },
        { type: "fixed", ms: 1500 },
      ],
    ];
    for (const [params, page] of cases) {
      expect(
        readSpecFromConfig({ strategyParams: params }).spec!.success,
      ).toEqual([{ page }]);
    }
  });

  it("strategyParams.cookieClear 三态覆盖非快照配方的清理范围", () => {
    const pageRecipe = recipe();
    const read = (cookieClear: unknown) =>
      readSpecFromConfig({
        strategyConfig: { recipe: pageRecipe },
        strategyParams: { cookieClear },
      }).spec!.ops[0];

    expect(read("none")).toEqual({ op: "clear.cookies", range: "none" });
    expect(read(["auth"])).toEqual({ op: "clear.cookies", range: ["auth"] });
    expect(read([])).toEqual({ op: "clear.cookies", range: "none" });
    expect(read(undefined)).toEqual({ op: "clear.cookies", range: "all" });
  });

  it("迁移结果通过校验器（R1–R7）", () => {
    for (const params of [
      { loginPageUrl: "/login" },
      { authSource: "cookie", authKey: "sid" },
      { authSource: "localStorage", authKey: "tk", loginPageUrl: "/login" },
    ]) {
      const result = readSpecFromConfig({ strategyParams: params });
      expect(validateLoginSpec(result.spec)).toEqual([]);
    }
  });
});

describe("readSpecFromConfig — 读取优先级", () => {
  it("strategyConfig.spec 优先于 recipe 与 legacy 参数", () => {
    const stored = {
      version: 2,
      template: "generic",
      ops: [{ op: "click", target: "#new" }],
      success: [{ page: { type: "urlChanged" } }],
      auth: { mode: "page" },
    };
    const result = readSpecFromConfig({
      strategyConfig: {
        spec: stored,
        recipe: recipe({ steps: [{ op: "click", target: "#old" }] }),
      },
      strategyParams: { usernameSelector: "#legacy" },
    });
    expect(result.migrated).toBe(false);
    expect(result.spec).toEqual(stored);
  });

  it("strategyConfig.recipe 优先于 legacy 参数，并标记 migrated", () => {
    const result = readSpecFromConfig({
      strategyConfig: {
        recipe: recipe({ steps: [{ op: "click", target: "#new" }] }),
      },
      strategyParams: { usernameSelector: "#old" },
    });
    expect(result.migrated).toBe(true);
    expect(
      result.spec!.ops.some((op) => op.op === "click" && op.target === "#new"),
    ).toBe(true);
  });

  it("两者都没有 → invalid（未配置）", () => {
    expect(readSpecFromConfig({ strategyParams: {} }).invalid).toBeTruthy();
    expect(readSpecFromConfig({}).invalid).toBeTruthy();
  });

  it("存储的 spec 版本高于当前 → invalid 且说明原因", () => {
    const result = readSpecFromConfig({
      strategyConfig: {
        spec: { version: 9, ops: [], success: [], auth: { mode: "page" } },
      },
    });
    expect(result.spec).toBeNull();
    expect(result.invalid).toContain("9");
  });

  it("已有配方的快照模式迁移后通过校验器（page 信号 + capture → goto → restore）", () => {
    const result = readSpecFromConfig({
      strategyConfig: {
        recipe: recipe({
          auth: { mode: "snapshot", cookies: ["auth"], localStorage: "all" },
        }),
      },
    });
    expect(validateLoginSpec(result.spec)).toEqual([]);
  });
});

describe("migrateSpec — 版本链", () => {
  it("Recipe v1 → LoginSpec v2：DOM 四步 + 清理 + 成功信号 + 页面自管", () => {
    const result = migrated(recipe());

    expect(result.spec).toEqual({
      version: 2,
      template: "generic",
      ops: [
        { op: "clear.cookies", range: "all" },
        { op: "goto", url: "{origin}/login" },
        { op: "fill", target: "#u", value: "{username}" },
        { op: "fill", target: "#p", value: "{password}" },
        { op: "click", target: "#go" },
      ],
      success: [{ page: DEFAULT_SETTLE }],
      auth: { mode: "page" },
    });
    expect(result.warnings).toEqual([]);
  });

  it("版本高于当前扩展 → 明确拒绝，不尝试解释", () => {
    const result = migrateSpec({ version: 3, steps: [], success: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("3");
    expect(result.error).toContain("2");
    expect(result.error).toContain("升级");
  });

  it("已是当前版本 → 原样返回，不做二次迁移", () => {
    const spec = {
      version: 2,
      ops: [{ op: "goto", url: "{origin}/login" }],
      success: [{ page: { type: "urlChanged" } }],
      auth: { mode: "page" },
    };

    expect(migrated(spec).spec).toEqual(spec);
  });

  it("非对象 / 缺少版本 → 拒绝", () => {
    for (const input of [null, "x", {}, { version: "x" }]) {
      expect(migrateSpec(input).ok).toBe(false);
    }
  });

  it("迁移可重入：同一输入两次结果深度相等", () => {
    const input = recipe();
    expect(migrated(input).spec).toEqual(migrated(input).spec);
  });
});

// ---------------------------------------------------------------------------
// 已移除的内置登录策略：不回退到私有声明，提示用户自行导入
// ---------------------------------------------------------------------------

describe("readSpecFromConfig — 已移除的内置登录环境", () => {
  it("旧内置登录且无声明 → 不回退声明，提示导入自己的登录策略包", () => {
    const result = readSpecFromConfig({ loginMethod: "legacy-builtin" });
    expect(result.spec).toBeNull();
    expect(result.invalid).toContain("导入登录策略包");
    expect(result.invalid).not.toContain("docs/");
    expect(result.invalid).not.toContain("ebs");
  });

  it("旧策略标识仍返回通用导入提示，不指向仓库内私有文件", () => {
    const result = readSpecFromConfig({ loginMethod: "ebs-rsa" });
    expect(result.spec).toBeNull();
    expect(result.invalid).toContain("导入登录策略包");
    expect(result.invalid).not.toContain("docs/");
  });

  it("内联声明仍然优先（迁移后可保留旧登录方式标识）", () => {
    const inline = {
      version: 2,
      template: "custom-login",
      ops: [],
      success: [],
      auth: { mode: "page" },
    };
    const result = readSpecFromConfig({
      loginMethod: "legacy-builtin",
      strategyConfig: { spec: inline },
    });
    expect(result.spec?.template).toBe("custom-login");
  });

  it("没有声明且不是已移除的内置 key → 仍报未配置", () => {
    const result = readSpecFromConfig({ loginMethod: "generic" });
    expect(result.spec).toBeNull();
    expect(result.invalid).toContain("未配置");
  });
});

// ---------------------------------------------------------------------------

describe("readSpecFromConfig — 策略库镜像（ADR-0019 修订）", () => {
  const librarySpec = {
    version: 2,
    template: "shared-login",
    ops: [{ op: "click", target: "#lib" }],
    success: [{ page: { type: "urlChanged" } }],
    auth: { mode: "page" },
  };
  const strategies = { "custom:shared-login": { spec: librarySpec } };

  it("无私有声明时按 strategyId 镜像读库条目", () => {
    const result = readSpecFromConfig(
      { strategyId: "custom:shared-login" },
      strategies,
    );
    expect(result.spec).toEqual(librarySpec);
    expect(result.migrated).toBe(false);
  });

  it("环境私有声明优先于库镜像（脱镜）", () => {
    const privateSpec = {
      version: 2,
      template: "shared-login",
      ops: [{ op: "click", target: "#private" }],
      success: [],
      auth: { mode: "page" },
    };
    const result = readSpecFromConfig(
      {
        strategyId: "custom:shared-login",
        strategyConfig: { spec: privateSpec },
      },
      strategies,
    );
    expect(result.spec?.ops).toEqual([{ op: "click", target: "#private" }]);
  });

  it("strategyId 悬空（库已删 / 未传 strategies）→ 未配置", () => {
    expect(
      readSpecFromConfig({ strategyId: "gone" }, strategies).invalid,
    ).toBeTruthy();
    expect(
      readSpecFromConfig({ strategyId: "custom:shared-login" }).invalid,
    ).toBeTruthy();
  });

  it("库条目内容损坏 → 返回 invalid，不抛错", () => {
    const result = readSpecFromConfig(
      { strategyId: "custom:shared-login" },
      { "custom:shared-login": { spec: { version: 999 } } },
    );
    expect(result.spec).toBeNull();
    expect(result.invalid).toBeTruthy();
  });
});
