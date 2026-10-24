/**
 * 登录方式预设（动态策略 / 去内置）
 *
 * 导入登录策略包后，环境的登录声明应作为一种**具名、可再次选用**的登录方式
 * 出现在下拉里；名称取 spec.template（skill 产出）或环境名。
 *
 * 不引入独立注册表：预设全部从现有环境归纳，所以「导入即生效、无需启动重放」，
 * 也不会出现「注册表丢了但环境还在引用」。
 *
 * 不提供站点专用预设，自定义声明由用户导入。
 */
import { describe, expect, it } from "vitest";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import {
  BUILTIN_GENERIC,
  collectStrategyPresets,
  findPreset,
  listStrategyPresets,
  matchPresetKey,
  presetTitleOf,
  slugifyKey,
} from "../entrypoints/tools/account-switch/spec/strategy-presets";
import {
  DEFAULT_AUTH,
  LOGIN_SPEC_VERSION,
  type LoginSpec,
} from "../entrypoints/tools/account-switch/spec/types";
import type {
  DomainConfig,
  StrategyEntry,
} from "../entrypoints/tools/account-switch/types";

function env(
  overrides: Partial<DomainConfig> & { spec?: LoginSpec } = {},
): DomainConfig {
  const { spec, ...rest } = overrides;
  return {
    name: rest.name ?? "环境",
    tags: [],
    loginMethod: rest.loginMethod ?? "generic",
    ...rest,
    ...(spec ? { strategyConfig: { spec } } : {}),
  } as DomainConfig;
}

/** 用户导入的具名声明（不含 script） */
function skillSpec(template = "共享后台登录"): LoginSpec {
  return {
    version: LOGIN_SPEC_VERSION,
    template,
    ops: [],
    success: [{ response: { from: "resp", path: "success", equals: true } }],
    auth: DEFAULT_AUTH,
  };
}

describe("slugifyKey", () => {
  it("中文保留可读部分，空格/符号归一为连字符", () => {
    expect(slugifyKey("共享后台 V6 (demo)")).toBe("共享后台-v6-demo");
  });

  it("全非法字符时退化为 unnamed", () => {
    expect(slugifyKey("!!!")).toBe("unnamed");
  });
});

describe("presetTitleOf", () => {
  it("template 优先", () => {
    expect(presetTitleOf(skillSpec("custom-login"), "某环境")).toBe("custom-login");
  });

  it("template 是内置 generic → 用环境名", () => {
    expect(presetTitleOf(skillSpec("generic"), "某环境")).toBe("某环境");
  });

  it("template 与环境名都缺失 → 自定义登录", () => {
    expect(
      presetTitleOf({ ...skillSpec(), template: undefined }, undefined),
    ).toBe("自定义登录");
  });
});

describe("listStrategyPresets — 内置", () => {
  it("只内置通用登录（不提供站点专用预设）", () => {
    const list = listStrategyPresets({});
    expect(list.map((p) => p.key)).toEqual([BUILTIN_GENERIC]);
    expect(list[0].title).toBe("通用登录");
    expect(list[0].builtin).toBe(true);
  });

  it("只有历史 loginMethod、没有内联声明的环境不凭空产生预设", () => {
    const list = listStrategyPresets({
      "http://old.com": env({ loginMethod: "ebs-rsa" }),
    });
    expect(list.map((p) => p.key)).toEqual([BUILTIN_GENERIC]);
  });
});

describe("collectStrategyPresets — 从环境归纳动态策略", () => {
  it("导入的具名声明成为一条可选登录方式", () => {
    const presets = collectStrategyPresets({
      "http://a.com": env({ spec: skillSpec("RSA 账号登录") }),
    });
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({
      key: "custom:rsa-账号登录",
      title: "RSA 账号登录",
      builtin: false,
      sourceUrl: "http://a.com",
    });
    expect(presets[0].spec).toEqual(skillSpec("RSA 账号登录"));
  });

  it("没有内联声明的环境（旧配方）不产生预设", () => {
    expect(
      collectStrategyPresets({
        "http://a.com": env({ loginMethod: "generic" }),
      }),
    ).toEqual([]);
  });

  it("与内置通用登录默认声明相同的环境不重复成一条策略", () => {
    expect(
      collectStrategyPresets({
        "http://a.com": env({ spec: defaultLoginSpec() }),
      }),
    ).toEqual([]);
  });

  it("custom-login 导入后作为动态预设出现（不再被内置规则跳过）", () => {
    const presets = collectStrategyPresets({
      "http://a.com": env({ spec: skillSpec("custom-login"), loginMethod: "custom-login" }),
    });
    expect(presets).toHaveLength(1);
    expect(presets[0].title).toBe("custom-login");
    expect(presets[0].builtin).toBe(false);
  });

  it("同名 / 同内容声明只保留第一条", () => {
    const presets = collectStrategyPresets({
      "http://a.com": env({ name: "A", spec: skillSpec("同名策略") }),
      "http://b.com": env({ name: "B", spec: skillSpec("同名策略") }),
      "http://c.com": env({ name: "C", spec: skillSpec("另一个") }),
    });
    expect(presets.map((p) => p.title)).toEqual(["同名策略", "另一个"]);
    expect(presets[0].sourceUrl).toBe("http://a.com");
  });

  it("多个环境时排在通用登录之后", () => {
    const list = listStrategyPresets({
      "http://a.com": env({ spec: skillSpec("导入策略") }),
      "http://b.com": env({ spec: skillSpec("另一个策略") }),
    });
    expect(list.map((p) => p.title)).toEqual([
      "通用登录",
      "导入策略",
      "另一个策略",
    ]);
  });
});

describe("策略库条目（ADR-0019）", () => {
  const libraryEntry = (
    spec: LoginSpec,
    name = "库策略",
  ): StrategyEntry => ({
    name,
    spec,
    createdAt: 1,
    updatedAt: 1,
  });

  it("库条目优先收录，key 直接用库 id（与环境的 strategyId 同值）", () => {
    const strategies = { "custom:custom-login": libraryEntry(skillSpec("custom-login"), "custom-login") };
    const presets = collectStrategyPresets({}, strategies);
    expect(presets).toHaveLength(1);
    expect(presets[0].key).toBe("custom:custom-login");
    expect(presets[0].title).toBe("custom-login");
    expect(presets[0].sourceUrl).toBeUndefined();
  });

  it("只入库、没有环境时预设依然出现（导入不再依赖环境记录）", () => {
    const strategies = { s1: libraryEntry(skillSpec("仅入库策略")) };
    const list = listStrategyPresets({}, strategies);
    expect(list.map((p) => p.title)).toEqual(["通用登录", "仅入库策略"]);
  });

  it("已绑定库条目的环境不重复收录", () => {
    const strategies = { s1: libraryEntry(skillSpec("库策略")) };
    const presets = collectStrategyPresets(
      {
        "http://a.com": env({
          spec: skillSpec("库策略"),
          strategyId: "s1",
        }),
      },
      strategies,
    );
    expect(presets).toHaveLength(1);
    expect(presets[0].key).toBe("s1");
    expect(presets[0].sourceUrl).toBeUndefined();
  });

  it("库条目 + 未入库的存量环境声明并存", () => {
    const strategies = { s1: libraryEntry(skillSpec("库策略")) };
    const presets = collectStrategyPresets(
      { "http://legacy.com": env({ spec: skillSpec("存量策略") }) },
      strategies,
    );
    expect(presets.map((p) => p.title)).toEqual(["库策略", "存量策略"]);
    expect(presets[1].sourceUrl).toBe("http://legacy.com");
  });
});

describe("matchPresetKey — 已保存环境归属哪条登录方式", () => {
  it("按 spec 内容精确匹配动态预设", () => {
    const spec = skillSpec("导入策略");
    const presets = listStrategyPresets({ "http://a.com": env({ spec }) });
    expect(matchPresetKey(spec, "环境", presets)).toBe(
      presets.find((p) => p.title === "导入策略")!.key,
    );
  });

  it("generic 默认声明匹配通用登录", () => {
    const spec = defaultLoginSpec();
    const presets = listStrategyPresets({});
    expect(matchPresetKey(spec, "环境", presets)).toBe(BUILTIN_GENERIC);
  });

  it("未收录的声明按标题生成稳定 key（编辑时不回落到 generic）", () => {
    const spec = skillSpec("孤儿策略");
    expect(matchPresetKey(spec, undefined, [])).toBe("custom:孤儿策略");
  });
});

describe("findPreset", () => {
  it("按 key 取预设，取不到返回 undefined", () => {
    const presets = listStrategyPresets({});
    expect(findPreset(presets, BUILTIN_GENERIC)?.title).toBe("通用登录");
    expect(findPreset(presets, "nope")).toBeUndefined();
  });
});

describe("端到端场景：导入 → 下拉出现 → 新建环境套用", () => {
  it("导入的环境声明可用作另一环境的登录方式", () => {
    const imported = skillSpec("共享后台登录");
    const domains = {
      "http://imported.example": env({
        name: "共享后台登录",
        spec: imported,
      }),
    };

    // 1) 导入后自动出现一条命名策略
    const presets = listStrategyPresets(domains);
    const preset = presets.find((p) => p.title === "共享后台登录");
    expect(preset).toBeDefined();

    // 2) 新环境选中它 → 套用同一份声明
    expect(preset!.spec).toEqual(imported);

    // 3) 选中的 key 再被读取时能匹配回同一条（下拉不会跳回通用登录）
    expect(matchPresetKey(preset!.spec, "新环境", presets)).toBe(preset!.key);
  });
});
