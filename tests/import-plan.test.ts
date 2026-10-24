/**
 * 导入识别与预览计划（ADR-0017 D2，S5 seam）
 *
 * detectImportKind：按内容识别三轴（登录策略包 / 账号备份 / 全部工具设置），
 * 不靠文件名。planImport：导入预览的唯一事实源——可落地的轴、内容计数、
 * 与现有环境地址的冲突（默认不勾选）、校验问题（复用 PackageIssue 形状，
 * 含 opIndex；校验逻辑复用 validateConfigPackage）、落地方式选项。
 *
 * 纯函数单测：零浏览器 API、零 chrome stub。只断言外部可观察行为。
 */
import { describe, expect, it } from "vitest";
import {
  detectImportKind,
  planImport,
} from "../entrypoints/tools/account-switch/account-env-view";
import type {
  Account,
  DomainConfig,
} from "../entrypoints/tools/account-switch/types";
import { listStrategyPresets } from "../entrypoints/tools/account-switch/spec/strategy-presets";
import {
  LOGIN_SPEC_VERSION,
  type LoginSpec,
  type SpecOp,
} from "../entrypoints/tools/account-switch/spec/types";

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
    version: LOGIN_SPEC_VERSION,
    ops: BASE_OPS,
    success: [{ response: { from: "resp", path: "ok" } }],
    auth: { mode: "engine" },
    ...overrides,
  };
}

function strategyPackage(overrides: Record<string, unknown> = {}) {
  return {
    format: "dt-login-config/v1",
    specVersion: LOGIN_SPEC_VERSION,
    requiredVars: [],
    environments: [
      {
        name: "dev",
        url: "https://dev.example.com",
        spec: spec(),
        requiredVars: [],
      },
    ],
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "a1",
    name: "admin",
    username: "admin",
    password: "123456",
    roles: [],
    domains: [],
    ...overrides,
  };
}

function domain(overrides: Partial<DomainConfig> = {}): DomainConfig {
  return {
    name: "dev",
    tags: [],
    loginMethod: "generic",
    strategyConfig: { spec: spec() },
    ...overrides,
  };
}

function accountBackup(overrides: Record<string, unknown> = {}) {
  return {
    accounts: [account()],
    domains: { "https://dev.example.com": domain() },
    ...overrides,
  };
}

const EMPTY_CONFIG: { accounts: Account[]; domains: Record<string, DomainConfig> } = {
  accounts: [],
  domains: {},
};

// ---------------------------------------------------------------------------
// detectImportKind — 四类识别（按内容，不靠文件名）
// ---------------------------------------------------------------------------

describe("detectImportKind — 按内容识别导入对象", () => {
  it("format = dt-login-config/v1 → strategy（登录策略包）", () => {
    expect(detectImportKind(strategyPackage())).toBe("strategy");
  });

  it("存在 accounts 且无 format → accounts（账号备份）", () => {
    expect(detectImportKind(accountBackup())).toBe("accounts");
    expect(detectImportKind({ accounts: [] })).toBe("accounts");
  });

  it("存在 accounts 且含 __version → full（全部工具设置）", () => {
    expect(detectImportKind({ accounts: [], __version: 2 })).toBe("full");
  });

  it("存在 __version（无 accounts）→ full", () => {
    expect(
      detectImportKind({ __version: 2, "json-format": { tabSize: 2 } }),
    ).toBe("full");
  });

  it("其余 → unknown（含非对象、数组、空对象、无关 format）", () => {
    expect(detectImportKind({})).toBe("unknown");
    expect(detectImportKind(null)).toBe("unknown");
    expect(detectImportKind("dt-login-config/v1")).toBe("unknown");
    expect(detectImportKind([account()])).toBe("unknown");
    expect(detectImportKind({ format: "something/else" })).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// planImport — 预览计划
// ---------------------------------------------------------------------------

describe("planImport — 登录策略包", () => {
  it("合规包：strategy 轴可用（计数 = 环境声明数），accounts 轴不可用，无问题", () => {
    const plan = planImport(strategyPackage(), EMPTY_CONFIG);
    expect(plan.kind).toBe("strategy");
    expect(plan.issues).toEqual([]);
    expect(plan.axes.strategy).toEqual({
      available: true,
      count: 1,
      defaultChecked: true,
    });
    expect(plan.axes.accounts.available).toBe(false);
    expect(plan.envs).toHaveLength(1);
    expect(plan.envs[0].url).toBe("https://dev.example.com");
    expect(plan.envs[0].conflict).toBe(false);
    expect(plan.envs[0].checked).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.landOptions).toEqual({
      modes: ["create"],
      defaultMode: "create",
    });
  });

  it("字面 JSON 对象的 cookie value：结构花括号自动转义后通过校验并落地（原 user 1.json）", () => {
    const pkg = strategyPackage({
      environments: [
        {
          name: "共享后台 (demo)",
          url: "{origin}",
          spec: spec({
            ops: [
              {
                op: "crypto.encrypt",
                algorithm: "rsa-pkcs1v15",
                publicKey: "synthetic-public-key",
                input: "{password}",
                as: "xstr",
              } as unknown as SpecOp,
              ...BASE_OPS,
            ],
            auth: {
              mode: "engine",
              cookiesWrite: [
                {
                  name: "auth",
                  value:
                    '{"token":"$resp.data.token","refreshToken":"$resp.data.refreshToken"}',
                },
              ],
              localStorageWrite: [{ key: "token", value: "$resp.data.token" }],
            },
          }),
          requiredVars: [],
        },
      ],
    });
    const plan = planImport(pkg, EMPTY_CONFIG);
    expect(plan.issues).toEqual([]);
    expect(plan.axes.strategy.available).toBe(true);
    // 落地 spec 里的 cookie value 已被转义为合法模板
    const landed = (plan.envs[0].domain.strategyConfig!.spec! as LoginSpec)
      .auth! as { cookiesWrite?: { value: string }[] };
    expect(landed.cookiesWrite![0].value).toBe(
      '{{"token":"$resp.data.token","refreshToken":"$resp.data.refreshToken"}}',
    );
  });

  it("script 算子：问题定位到算子下标（opIndex，0 基）", () => {
    const pkg = strategyPackage({
      environments: [
        {
          name: "dev",
          url: "https://dev.example.com",
          spec: spec({
            ops: [
              ...BASE_OPS,
              { op: "script", run: "return {}" } as unknown as SpecOp,
            ],
          }),
          requiredVars: [],
        },
      ],
    });
    const plan = planImport(pkg, EMPTY_CONFIG);
    expect(plan.issues.length).toBeGreaterThan(0);
    const hit = plan.issues.find((i) => i.opIndex !== undefined);
    expect(hit).toBeDefined();
    expect(hit!.opIndex).toBe(1);
    expect(hit!.message).toContain("第 2 步");
  });

  it("specVersion 高于当前扩展 → 拒绝并告知升级", () => {
    const plan = planImport(
      strategyPackage({ specVersion: LOGIN_SPEC_VERSION + 1 }),
      EMPTY_CONFIG,
    );
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.issues[0].message).toContain("升级扩展");
    // 版本过高时无可落地的轴（确认按钮必须禁用的事实源）
    expect(plan.axes.strategy.available).toBe(false);
  });

  it("secret 变量 → 拒绝并指出变量名", () => {
    const pkg = strategyPackage({
      environments: [
        {
          name: "dev",
          url: "https://dev.example.com",
          spec: spec({
            vars: [{ name: "privateKey", secret: true }],
          }),
          requiredVars: [],
        },
      ],
    });
    const plan = planImport(pkg, EMPTY_CONFIG);
    const hit = plan.issues.find((i) => i.varName === "privateKey");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("privateKey");
  });

  it("与现有环境地址冲突的条目：标出且默认不勾选，非冲突默认勾选", () => {
    const pkg = strategyPackage({
      environments: [
        {
          name: "dev",
          url: "https://dev.example.com",
          spec: spec(),
          requiredVars: [],
        },
        {
          name: "staging",
          url: "https://staging.example.com",
          spec: spec(),
          requiredVars: [],
        },
      ],
    });
    const plan = planImport(pkg, {
      accounts: [],
      domains: { "https://dev.example.com": domain() },
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].url).toBe("https://dev.example.com");
    // 冲突默认不勾选（避免误覆盖），可手动勾
    expect(plan.conflicts[0].checked).toBe(false);
    const staging = plan.envs.find(
      (e) => e.url === "https://staging.example.com",
    );
    expect(staging!.conflict).toBe(false);
    expect(staging!.checked).toBe(true);
    // 有冲突才提供「覆盖已有环境」
    expect(plan.landOptions.modes).toEqual(["create", "overwrite"]);
    expect(plan.landOptions.defaultMode).toBe("create");
  });
});

describe("planImport — 账号备份 / 全部工具设置", () => {
  it("账号备份：两轴可用，计数正确（账号含明文密码）", () => {
    const plan = planImport(accountBackup(), EMPTY_CONFIG);
    expect(plan.kind).toBe("accounts");
    expect(plan.issues).toEqual([]);
    expect(plan.axes.accounts).toEqual({
      available: true,
      count: 1,
      defaultChecked: true,
    });
    expect(plan.axes.strategy).toEqual({
      available: true,
      count: 1,
      defaultChecked: true,
    });
    expect(plan.accountsToLand).toHaveLength(1);
    expect(plan.accountsToLand[0].username).toBe("admin");
  });

  it("账号备份缺 accounts → 结构问题，账号轴不可用", () => {
    const plan = planImport(
      { domains: { "https://dev.example.com": domain() } },
      EMPTY_CONFIG,
    );
    // 无 accounts 无 __version 无 format → unknown
    expect(plan.kind).toBe("unknown");
    expect(plan.issues.length).toBeGreaterThan(0);
  });

  it("账号记录 domains 不是字符串数组 → 结构问题（指向记录序号），不进入 accountsToLand", () => {
    // 回归（final review）：domains 为非数组的账号落地后，buildEnvGroups
    // 遍历 account.domains 直接抛错，整个「环境与账号」主视图白屏
    const plan = planImport(
      accountBackup({
        accounts: [{ id: "a1", name: "admin", username: "admin", domains: 5 }],
      }),
      EMPTY_CONFIG,
    );
    expect(plan.accountsToLand).toEqual([]);
    expect(plan.axes.accounts.available).toBe(false);
    expect(
      plan.issues.some(
        (i) => i.code === "CONFIG_INVALID" && i.message.includes("第 1 个账号"),
      ),
    ).toBe(true);
  });

  it("全部工具设置：取 account-switch 切片，两轴可用且默认全勾", () => {
    const full = {
      __version: 2,
      "account-switch": accountBackup(),
      "json-format": { tabSize: 2 },
    };
    const plan = planImport(full, EMPTY_CONFIG);
    expect(plan.kind).toBe("full");
    expect(plan.issues).toEqual([]);
    expect(plan.axes.accounts).toEqual({
      available: true,
      count: 1,
      defaultChecked: true,
    });
    expect(plan.axes.strategy).toEqual({
      available: true,
      count: 1,
      defaultChecked: true,
    });
  });

  it("全部工具设置缺 account-switch 切片 → 问题 + 两轴不可用", () => {
    const plan = planImport(
      { __version: 2, "json-format": { tabSize: 2 } },
      EMPTY_CONFIG,
    );
    expect(plan.kind).toBe("full");
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.axes.accounts.available).toBe(false);
    expect(plan.axes.strategy.available).toBe(false);
  });

  it("空账号列表的备份：账号轴可用但默认不勾选（避免默认动作清空现有账号）", () => {
    const current = {
      accounts: [account()],
      domains: {} as Record<string, DomainConfig>,
    };
    // 账号备份（空 accounts）
    const fromBackup = planImport(accountBackup({ accounts: [] }), current);
    expect(fromBackup.axes.accounts).toEqual({
      available: true,
      count: 0,
      defaultChecked: false,
    });
    // 全部工具设置（切片内空 accounts）同语义
    const fromFull = planImport(
      { __version: 2, "account-switch": accountBackup({ accounts: [] }) },
      current,
    );
    expect(fromFull.axes.accounts.defaultChecked).toBe(false);
  });

  it("备份中的环境与现有地址冲突：默认不勾选", () => {
    const plan = planImport(accountBackup(), {
      accounts: [],
      domains: { "https://dev.example.com": domain({ name: "existing" }) },
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].checked).toBe(false);
    expect(plan.landOptions.modes).toContain("overwrite");
  });
});

describe("planImport — skill 产出的具名策略", () => {
  /** 与 skill 产物同形：template 是可读策略名，环境名为平台名 */
  const namedSpec = () => ({
    ...spec(),
    template: "custom-api-login · RSA 账号登录",
  });

  it("导入环境保留声明里的策略名（不再一律记成 generic）", () => {
    const pkg = strategyPackage({
      environments: [
        {
          name: "共享后台 (demo)",
          url: "{origin}",
          spec: namedSpec(),
          requiredVars: [],
        },
      ],
    });
    const plan = planImport(pkg, EMPTY_CONFIG);
    expect(plan.issues).toEqual([]);
    // 环境名与策略名是两件事：前者是平台，后者是登录声明
    expect(plan.envs[0].name).toBe("共享后台 (demo)");
    expect(
      (plan.envs[0].domain.strategyConfig!.spec! as LoginSpec).template,
    ).toContain("RSA 账号登录");
  });

  it("落地后该声明成为一条可再次选用的登录方式（名称取 template）", () => {
    const pkg = strategyPackage({
      environments: [
        {
          name: "共享后台 (demo)",
          url: "https://app.example.com",
          spec: namedSpec(),
          requiredVars: [],
        },
      ],
    });
    const plan = planImport(pkg, EMPTY_CONFIG);
    const domains: Record<string, DomainConfig> = {};
    for (const item of plan.envs) domains[item.url] = item.domain;

    const presets = listStrategyPresets(domains);
    expect(presets.map((p) => p.key)).toContain("generic");
    const dynamic = presets.find((p) => !p.builtin);
    expect(dynamic).toBeDefined();
    expect(dynamic!.title).toBe(
      "custom-api-login · RSA 账号登录",
    );
    // 选中即套用同一份声明
    expect(dynamic!.spec).toEqual(
      (plan.envs[0].domain.strategyConfig!.spec as LoginSpec),
    );
  });

  it("两个环境导入同一策略：下拉只多出一条，不重复刷屏", () => {
    const pkg = strategyPackage({
      environments: [
        {
          name: "平台 A",
          url: "https://a.example.com",
          spec: namedSpec(),
          requiredVars: [],
        },
        {
          name: "平台 B",
          url: "https://b.example.com",
          spec: namedSpec(),
          requiredVars: [],
        },
      ],
    });
    const plan = planImport(pkg, EMPTY_CONFIG);
    const domains: Record<string, DomainConfig> = {};
    for (const item of plan.envs) domains[item.url] = item.domain;
    const dynamic = listStrategyPresets(domains).filter(
      (p) => !p.builtin,
    );
    expect(dynamic).toHaveLength(1);
  });
});

describe("planImport — 无法识别", () => {
  it("unknown：给出问题，两轴不可用，无可落地内容", () => {
    const plan = planImport({ hello: "world" }, EMPTY_CONFIG);
    expect(plan.kind).toBe("unknown");
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(plan.issues[0].message).toContain("无法识别");
    expect(plan.axes.strategy.available).toBe(false);
    expect(plan.axes.accounts.available).toBe(false);
    expect(plan.envs).toEqual([]);
    expect(plan.accountsToLand).toEqual([]);
  });
});
