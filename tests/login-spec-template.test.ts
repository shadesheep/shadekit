/**
 * login-spec/template — 引用解析与转义（ADR-0015 D4）
 *
 * 纯函数单测：零浏览器 API、零 chrome stub。
 */
import { describe, expect, it } from "vitest";

import {
  collectTemplateRefs,
  resolveTemplate,
  resolveTemplateValue,
  escapeLiteralBraces,
  TemplateError,
} from "../entrypoints/tools/account-switch/spec/template";

const ctx = {
  inputs: { username: "alice", password: "s3cret", origin: "https://app.test" },
  bindings: {
    resp: { data: { token: "tk-1", user: { name: "张三" } } },
    list: [{ name: "first" }, { name: "second" }],
    empty: null,
    obj: { a: 1, b: [1, 2] },
  },
};

describe("resolveTemplate — 输入引用 {name}", () => {
  it("解析单个与混排的输入引用", () => {
    expect(resolveTemplate("{username}", ctx)).toBe("alice");
    expect(resolveTemplate("pre-{username}-{origin}", ctx)).toBe(
      "pre-alice-https://app.test",
    );
  });

  it("未声明的输入引用报 TEMPLATE_UNRESOLVED，不原样保留", () => {
    let error: unknown;
    try {
      resolveTemplate("{usernam}", ctx);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as TemplateError).code).toBe("TEMPLATE_UNRESOLVED");
    expect((error as TemplateError).message).toContain("usernam");
    expect((error as TemplateError).token).toBe("{usernam}");
  });
});

describe("resolveTemplate — 绑定引用 $name", () => {
  it("解析点路径与数组下标", () => {
    expect(resolveTemplate("$resp.data.token", ctx)).toBe("tk-1");
    expect(resolveTemplate("$list.0.name", ctx)).toBe("first");
    expect(resolveTemplate("Bearer $resp.data.token", ctx)).toBe("Bearer tk-1");
  });

  it("中间路径不存在时报错；末值为 null 时解析为空串", () => {
    expect(() => resolveTemplate("$resp.dat.token", ctx)).toThrow(
      TemplateError,
    );
    expect(() => resolveTemplate("$list.9.name", ctx)).toThrow(TemplateError);
    expect(() => resolveTemplate("$nope", ctx)).toThrow(TemplateError);
    expect(resolveTemplate("$empty", ctx)).toBe("");
  });

  it("引用解析为对象时按无空格 JSON 序列化", () => {
    expect(resolveTemplate("$obj", ctx)).toBe('{"a":1,"b":[1,2]}');
    expect(resolveTemplate("$resp.data.user", ctx)).toBe('{"name":"张三"}');
  });
});

describe("resolveTemplate — 转义", () => {
  it("{{ / }} / $$ 还原为字面量", () => {
    expect(resolveTemplate("a{{b", ctx)).toBe("a{b");
    expect(resolveTemplate("a}}b", ctx)).toBe("a}b");
    expect(resolveTemplate("$$5", ctx)).toBe("$5");
  });

  it("转义后的花括号不再参与引用解析", () => {
    expect(resolveTemplate("{{username}}", ctx)).toBe("{username}");
    expect(resolveTemplate("{{{username}}}", ctx)).toBe("{alice}");
    expect(resolveTemplate("$$resp", ctx)).toBe("$resp");
  });

  it("非法模板（孤立 } / 未闭合 { / 空引用）报语法错误", () => {
    for (const template of ["{", "{username", "a}b", "{}", "{na me}", "$"]) {
      expect(() => resolveTemplate(template, ctx), template).toThrow(
        TemplateError,
      );
    }
  });
});

describe("resolveTemplateValue — 整串引用保留原始类型", () => {
  it("整串恰为绑定引用时返回原值，混排时返回字符串", () => {
    expect(resolveTemplateValue("$resp.data.token", ctx)).toBe("tk-1");
    expect(resolveTemplateValue("$obj", ctx)).toEqual({ a: 1, b: [1, 2] });
    expect(resolveTemplateValue("x-$obj", ctx)).toBe('x-{"a":1,"b":[1,2]}');
    expect(resolveTemplateValue("{username}", ctx)).toBe("alice");
    expect(
      resolveTemplateValue("{obj}", {
        inputs: { obj: { n: 2 } },
        bindings: {},
      }),
    ).toEqual({
      n: 2,
    });
  });
});

describe("collectTemplateRefs — 校验期收集引用", () => {
  it("分别收集输入名与绑定路径（去重）", () => {
    expect(
      collectTemplateRefs("{username}-{username}-$resp.data.token-$resp"),
    ).toEqual({
      inputs: ["username"],
      bindings: ["resp.data.token", "resp"],
    });
  });

  it("转义不是引用；字面量文本不产生引用", () => {
    expect(collectTemplateRefs("{{username}} $$resp plain")).toEqual({
      inputs: [],
      bindings: [],
    });
  });

  it("非法模板抛出 TemplateError", () => {
    expect(() => collectTemplateRefs("{broken")).toThrow(TemplateError);
  });
});

describe("escapeLiteralBraces — 导入侧结构花括号规范化（ADR-0015 D4 补充）", () => {
  it("字面 JSON 对象 value 的花括号被转义，绑定引用保持", () => {
    expect(escapeLiteralBraces('{"token":"$resp.data.token"}')).toBe(
      '{{"token":"$resp.data.token"}}',
    );
  });

  it("真正的 {name} 输入引用与 $ 绑定保持原样", () => {
    expect(escapeLiteralBraces('{"token":"{username}"}')).toBe(
      '{{"token":"{username}"}}',
    );
    expect(escapeLiteralBraces("{username}-$resp.data.token")).toBe(
      "{username}-$resp.data.token",
    );
  });

  it("已转义形式（{{/}}/$$）幂等，纯文本保持", () => {
    expect(escapeLiteralBraces("{{a}}$$x$y}}")).toBe("{{a}}$$x$y}}");
    expect(escapeLiteralBraces("no braces")).toBe("no braces");
  });
});
