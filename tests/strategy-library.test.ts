/**
 * 登录策略库（ADR-0019，引用 + 镜像）
 *
 * 锁住三条产品语义：
 * 1. **导入策略不产生环境**：`upsertStrategy` 只动 `strategies`，不碰 `domains`；
 * 2. **绑定即镜像**：`bindEnvironment` 只写 `strategyId`，不拷声明；库更新
 *    即时对所有镜像环境生效；
 * 3. **取消关联 / 删除不产生环境**：`unbindEnvironment` / `removeStrategy`
 *    只摘 `strategyId`；镜像环境失去声明回到「未配置」，脱镜环境的私有声明
 *    原样保留。
 *
 * 纯函数单测：零浏览器 API、零 chrome stub。
 */
import { describe, expect, it } from "vitest";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import {
  bindEnvironment,
  boundEnvironments,
  isMirroring,
  listStrategies,
  makeStrategyId,
  removeStrategy,
  resolveEnvironmentBinding,
  strategyTitle,
  syncBoundEnvironments,
  syncEnvironment,
  unbindEnvironment,
  updateStrategy,
  upsertStrategy,
} from "../entrypoints/tools/account-switch/spec/strategy-library";
import {
  DEFAULT_AUTH,
  LOGIN_SPEC_VERSION,
  type LoginSpec,
} from "../entrypoints/tools/account-switch/spec/types";
import { buildSpecInputs } from "../entrypoints/tools/account-switch/spec/run";
import type {
  AuthContext,
  DomainConfig,
  StrategyEntry,
} from "../entrypoints/tools/account-switch/types";

/** 带一个变量的具名声明（模拟导入的 custom-login） */
function librarySpec(template = "custom-login"): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template,
    ops: [
      {
        op: "http.execute",
        url: "{origin}/login",
        method: "POST",
        body: { json: { publicKey: "{publicKey}" } },
        as: "resp",
      },
    ],
    success: [{ response: { from: "resp", path: "ok", equals: true } }],
    auth: DEFAULT_AUTH,
    vars: [{ name: "publicKey", title: "公钥", default: "DEFAULT_KEY" }],
  };
}

function env(overrides: Partial<DomainConfig> = {}): DomainConfig {
  return {
    name: "环境",
    tags: [],
    loginMethod: "generic",
    ...overrides,
  };
}

function entry(overrides: Partial<StrategyEntry> = {}): StrategyEntry {
  return {
    name: "custom-login",
    spec: librarySpec(),
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("upsertStrategy — 导入只入库", () => {
  it("新增一条策略，不触碰环境", () => {
    const result = upsertStrategy(undefined, librarySpec(), "custom-login", 2000);
    expect(result.created).toBe(true);
    expect(result.id).toBe("custom:custom-login");
    expect(result.strategies[result.id]).toMatchObject({
      name: "custom-login",
      createdAt: 2000,
      updatedAt: 2000,
    });
  });

  it("同内容重复导入幂等：不新增、不改时间", () => {
    const first = upsertStrategy(undefined, librarySpec(), "custom-login", 2000);
    const second = upsertStrategy(
      first.strategies,
      librarySpec(),
      "另起一个名字",
      3000,
    );
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.strategies[first.id].updatedAt).toBe(2000);
    expect(Object.keys(second.strategies)).toHaveLength(1);
  });

  it("同名不同内容分配不同 id", () => {
    const first = upsertStrategy(undefined, librarySpec(), "custom-login", 2000);
    const changed: LoginSpec = {
      ...librarySpec(),
      vars: [{ name: "publicKey", title: "公钥", default: "OTHER_KEY" }],
    };
    const second = upsertStrategy(first.strategies, changed, "custom-login", 3000);
    expect(second.id).not.toBe(first.id);
    expect(second.id).toBe("custom:custom-login-2");
  });
});

describe("makeStrategyId / strategyTitle", () => {
  it("非法字符归一，并以 custom: 前缀保持可读", () => {
    expect(makeStrategyId("Custom Login (demo)", {})).toBe("custom:custom-login-demo");
    expect(makeStrategyId("!!!", {})).toBe("custom:unnamed");
  });

  it("标题：template 优先，generic 时回落到给定名", () => {
    expect(strategyTitle(librarySpec("custom-login"), "环境名")).toBe("custom-login");
    expect(strategyTitle(librarySpec("generic"), "环境名")).toBe("环境名");
    expect(strategyTitle({ ...librarySpec(""), template: undefined }, undefined)).toBe(
      "自定义登录",
    );
  });
});

describe("绑定与解绑 — 引用 + 镜像", () => {
  it("绑定只写 strategyId 与显示名，**不**拷声明（镜像）", () => {
    const bound = bindEnvironment(env(), "custom:custom-login", entry());
    expect(bound.strategyId).toBe("custom:custom-login");
    expect(bound.strategyConfig).toBeUndefined();
    expect(bound.loginMethod).toBe("custom-login");
    expect(isMirroring(bound)).toBe(true);
  });

  it("绑定不覆盖已有的环境私有声明（脱镜态保留用户修改）", () => {
    const privateSpec = defaultLoginSpec();
    const bound = bindEnvironment(
      env({ strategyConfig: { spec: privateSpec } }),
      "s1",
      entry(),
    );
    expect(bound.strategyId).toBe("s1");
    expect(bound.strategyConfig?.spec).toEqual(privateSpec);
    expect(isMirroring(bound)).toBe(false);
  });

  it("解绑（keep-spec）：只摘 strategyId，环境字段不变", () => {
    const bound = bindEnvironment(env({ name: "A" }), "s1", entry());
    const unbound = unbindEnvironment(bound, "keep-spec", defaultLoginSpec);
    expect(unbound).not.toHaveProperty("strategyId");
    expect(unbound.name).toBe("A");
    expect(unbound.loginMethod).toBe(bound.loginMethod);
    // 镜像环境解绑后无私有声明
    expect(unbound.strategyConfig).toBeUndefined();
  });

  it("解绑（revert-generic）：回到通用登录默认声明", () => {
    const bound = bindEnvironment(env(), "s1", entry());
    const unbound = unbindEnvironment(bound, "revert-generic", defaultLoginSpec);
    expect(unbound).not.toHaveProperty("strategyId");
    expect(unbound.loginMethod).toBe("generic");
    expect(unbound.strategyConfig?.spec).toEqual(defaultLoginSpec());
  });

  it("删除策略：库条目消失，绑定环境只摘 strategyId；镜像环境失去声明，环境数量不变", () => {
    const mirrored = bindEnvironment(env(), "s1", entry());
    const diverged = bindEnvironment(
      env({ strategyConfig: { spec: librarySpec("custom-login-custom") } }),
      "s1",
      entry(),
    );
    const domains = {
      "https://a.example.com": mirrored,
      "https://b.example.com": diverged,
      "https://c.example.com": env({ name: "未绑定" }),
    };
    const strategies = { s1: entry() };
    const result = removeStrategy(strategies, domains, "s1");

    expect(result.strategies).toEqual({});
    expect(Object.keys(result.domains)).toHaveLength(3);
    expect(result.detached.sort()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    // 镜像环境：声明随库条目一起消失（未配置）
    const a = result.domains["https://a.example.com"];
    expect(a).not.toHaveProperty("strategyId");
    expect(a.strategyConfig).toBeUndefined();
    // 脱镜环境：私有声明保留
    const b = result.domains["https://b.example.com"];
    expect(b).not.toHaveProperty("strategyId");
    expect(b.strategyConfig?.spec).toEqual(librarySpec("custom-login-custom"));
  });
});

describe("编辑与同步 — 镜像即时生效，同步=重置回镜像", () => {
  it("updateStrategy 保留 createdAt，刷新 updatedAt 与标题", () => {
    const strategies = { s1: entry() };
    const nextSpec = { ...librarySpec("custom-login-v2") };
    const next = updateStrategy(strategies, "s1", nextSpec, 5000);
    expect(next.s1.createdAt).toBe(1000);
    expect(next.s1.updatedAt).toBe(5000);
    expect(next.s1.name).toBe("custom-login-v2");
  });

  it("编辑库条目后，镜像环境不需要任何动作即跟随（无 spec 拷贝可过期）", () => {
    const bound = bindEnvironment(env(), "s1", entry({ spec: librarySpec("custom-login") }));
    // 环境没有 spec，镜像语义下不存在「陈旧快照」的概念
    expect(bound.strategyConfig).toBeUndefined();
    // syncEnvironment 对已是镜像的环境返回 undefined（无需变更）
    const edited = entry({ spec: librarySpec("custom-login-v2") });
    expect(syncEnvironment(bound, edited)).toBeUndefined();
  });

  it("脱镜环境被 syncEnvironment 拉回镜像（丢弃私有声明）", () => {
    const diverged = bindEnvironment(
      env({ strategyConfig: { spec: librarySpec("custom-login-custom") } }),
      "s1",
      entry(),
    );
    const synced = syncEnvironment(diverged, entry());
    expect(synced).toBeDefined();
    expect(synced?.strategyConfig).toBeUndefined();
    expect(synced?.strategyId).toBe("s1");
    expect(isMirroring(synced!)).toBe(true);
  });

  it("syncBoundEnvironments 只重置脱镜环境，镜像环境不动", () => {
    const mirrored = bindEnvironment(env(), "s1", entry());
    const divergedA = bindEnvironment(
      env({ strategyConfig: { spec: librarySpec("custom-a") } }),
      "s1",
      entry(),
    );
    const boundOther = bindEnvironment(
      env({ strategyConfig: { spec: librarySpec("custom-b") } }),
      "s2",
      entry(),
    );
    const domains = {
      "https://a.example.com": mirrored,
      "https://b.example.com": divergedA,
      "https://c.example.com": boundOther,
    };
    const result = syncBoundEnvironments(domains, "s1", entry());

    expect(result.updated).toBe(1);
    // 镜像的 a 未被重写
    expect(result.domains["https://a.example.com"]).toBe(mirrored);
    // 脱镜的 b 被拉回镜像
    expect(result.domains["https://b.example.com"].strategyConfig).toBeUndefined();
    // 其它策略的绑定不受影响
    expect(result.domains["https://c.example.com"].strategyConfig?.spec).toEqual(
      librarySpec("custom-b"),
    );
  });

  it("未绑定的环境不需要同步", () => {
    expect(syncEnvironment(env(), entry())).toBeUndefined();
  });
});

describe("listStrategies / boundEnvironments", () => {
  it("按最近更新排序并统计关联环境数", () => {
    const strategies = {
      old: entry({ updatedAt: 1000 }),
      fresh: entry({ spec: librarySpec("fresh"), updatedAt: 2000 }),
    };
    const domains = {
      "https://a.example.com": bindEnvironment(env(), "old", strategies.old),
      "https://b.example.com": bindEnvironment(env(), "old", strategies.old),
    };
    const list = listStrategies(strategies, domains);
    expect(list.map((i) => i.id)).toEqual(["fresh", "old"]);
    expect(list.find((i) => i.id === "old")?.boundCount).toBe(2);
    expect(list.find((i) => i.id === "fresh")?.boundCount).toBe(0);
    expect(boundEnvironments(domains, "old")).toHaveLength(2);
  });
});

describe("resolveEnvironmentBinding — 保存环境时的收口", () => {
  it("策略库条目存在 → 绑定；不复制声明", () => {
    const strategies = { s1: entry() };
    const resolved = resolveEnvironmentBinding(
      env({ strategyId: "s1", strategyConfig: { spec: defaultLoginSpec() } }),
      strategies,
    );
    expect(resolved.strategyId).toBe("s1");
    // 私有声明保留（调用方决定是否丢弃），但**不**被库内容覆盖
    expect(resolved.strategyConfig?.spec).toEqual(defaultLoginSpec());
    expect(resolved.loginMethod).toBe("custom-login");
  });

  it("引用的条目已不存在 → 清除绑定，保留环境自己的声明", () => {
    const own = defaultLoginSpec();
    const resolved = resolveEnvironmentBinding(
      env({ strategyId: "gone", strategyConfig: { spec: own } }),
      {},
    );
    expect(resolved).not.toHaveProperty("strategyId");
    expect(resolved.strategyConfig?.spec).toEqual(own);
  });

  it("本来就未绑定 → 原样返回", () => {
    const input = env({ strategyConfig: { spec: defaultLoginSpec() } });
    expect(resolveEnvironmentBinding(input, {})).toBe(input);
  });
});

describe("环境级变量覆盖（ADR-0019）", () => {
  const ctx = (vars?: Record<string, string>): AuthContext => ({
    tabId: 1,
    origin: "https://a.example.com",
    domainConfig: env({ vars }),
    credentials: { username: "u", password: "p" },
    tokenData: null,
  });
  const aux = { nonce: "n", timestamp: 1 };

  it("环境覆盖优先于声明默认值", () => {
    const inputs = buildSpecInputs(
      librarySpec(),
      ctx({ publicKey: "ENV_KEY" }),
      aux,
    );
    expect(inputs.publicKey).toBe("ENV_KEY");
  });

  it("没有覆盖（或覆盖为空串）时回落声明默认值", () => {
    expect(buildSpecInputs(librarySpec(), ctx(), aux).publicKey).toBe(
      "DEFAULT_KEY",
    );
    expect(
      buildSpecInputs(librarySpec(), ctx({ publicKey: "" }), aux).publicKey,
    ).toBe("DEFAULT_KEY");
  });

  it("同一份声明 + 不同环境覆盖 → 取值互不污染", () => {
    const spec = librarySpec();
    expect(buildSpecInputs(spec, ctx({ publicKey: "A" }), aux).publicKey).toBe(
      "A",
    );
    expect(buildSpecInputs(spec, ctx({ publicKey: "B" }), aux).publicKey).toBe(
      "B",
    );
  });
});
