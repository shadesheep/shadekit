/**
 * login-spec/validate — LoginSpec 静态检查器（ADR-0015 D3 R1–R7）
 *
 * 纯函数单测：零浏览器 API、零 chrome stub。
 * 每条规则正反用例；错误定位到算子下标。
 */
import { describe, expect, it } from "vitest";
import { AUTO_LOGIN_TARGET } from "../entrypoints/tools/account-switch/spec/auto-login";
import type {
  LoginSpec,
  SettleCondition,
  SpecOp,
} from "../entrypoints/tools/account-switch/spec/types";
import {
  type SpecIssue,
  validateLoginSpec,
} from "../entrypoints/tools/account-switch/spec/validate";

const FORM_OPS: SpecOp[] = [
  { op: "goto", url: "{origin}/login" },
  { op: "fill", target: "#u", value: "{username}", clearFirst: true },
  { op: "fill", target: "#p", value: "{password}", clearFirst: true },
  { op: "click", target: "#go", onNotFound: "fail" },
];

function spec(overrides: Partial<LoginSpec> = {}): LoginSpec {
  return {
    version: 2,
    ops: FORM_OPS,
    success: [
      {
        page: {
          type: "any",
          of: [{ type: "formGone" }, { type: "urlChanged" }],
        },
      },
    ],
    auth: { mode: "page" },
    ...overrides,
  };
}

function codes(issues: SpecIssue[]): string[] {
  return issues.map((i) => i.rule ?? i.code);
}

function byRule(issues: SpecIssue[], rule: string): SpecIssue[] {
  return issues.filter((i) => i.rule === rule);
}

describe("validateLoginSpec — 合法 spec", () => {
  it("默认表单登录无问题", () => {
    expect(validateLoginSpec(spec())).toEqual([]);
  });

  it("完整的加密 + 签名 + 写会话 spec 无问题", () => {
    const full = spec({
      vars: [{ name: "publicKey" }],
      aux: { nonce: "auto", timestamp: "auto" },
      ops: [
        { op: "clear.cookies", range: "all" },
        { op: "clear.storage", area: "local", range: "all" },
        {
          op: "extract",
          source: "local",
          key: "lang",
          parse: "jsonValue",
          as: "lang",
        },
        {
          op: "map",
          input: "$lang",
          cases: [{ equals: "zh", value: "zh-CN" }],
          default: "en-US",
          as: "acceptLang",
        },
        {
          op: "crypto.encrypt",
          algorithm: "rsa-pkcs1v15",
          publicKey: "{publicKey}",
          input: "{password}",
          as: "pwd",
        },
        {
          op: "payload.build",
          parts: [
            { key: "account", value: "{username}" },
            { key: "password", value: "$pwd" },
          ],
          as: "body",
        },
        {
          op: "payload.build",
          parts: [
            { value: "$body", normalize: ["trim"] },
            { value: "{nonce}" },
            { value: "{timestamp}" },
          ],
          join: "",
          as: "signInput",
        },
        { op: "digest", algorithm: "sha256", input: "$signInput", as: "sign" },
        { op: "apply.set", target: "header", key: "X-Sign", value: "$sign" },
        {
          op: "http.execute",
          url: "{origin}/api/login",
          method: "POST",
          headers: { "Accept-Language": "$acceptLang" },
          body: { ref: "body" },
          as: "resp",
        },
        { op: "auth.write" },
      ],
      success: [
        { response: { from: "resp", path: "data.success", equals: true } },
        { token: { from: "resp", path: "data.token" } },
      ],
      auth: {
        mode: "engine",
        cookiesWrite: [
          {
            name: "token",
            value: "$resp.data.token",
            sameSite: "unspecified",
            expiresFrom: { from: "resp", path: "data.exp", unit: "epochMs" },
          },
        ],
        localStorageWrite: [{ key: "auth", value: "$resp.data.token" }],
      },
    });
    expect(validateLoginSpec(full)).toEqual([]);
  });
});

describe("结构检查", () => {
  it("非对象 / 版本不符", () => {
    expect(codes(validateLoginSpec(null))).toContain("CONFIG_INVALID");
    expect(
      codes(validateLoginSpec({ version: 1, ops: [], success: [] })),
    ).toContain("CONFIG_INVALID");
    expect(codes(validateLoginSpec({ ...spec(), version: 3 }))).toContain(
      "CONFIG_INVALID",
    );
  });

  it("未知算子被拦截并定位下标", () => {
    const issues = validateLoginSpec(
      spec({ ops: [{ op: "navigate", url: "x" } as unknown as SpecOp] }),
    );
    expect(issues[0].opIndex).toBe(0);
    expect(issues[0].message).toContain("navigate");
  });

  it("算子缺必填字段被拦截并定位下标", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [{ op: "http.execute", url: "{origin}/x" } as unknown as SpecOp],
      }),
    );
    expect(
      issues.some((i) => i.opIndex === 0 && i.message.includes("as")),
    ).toBe(true);
  });
});

describe("R7 成功信号至少一条", () => {
  it("空数组报 R7", () => {
    const issues = validateLoginSpec(spec({ success: [] }));
    expect(byRule(issues, "R7")).toHaveLength(1);
  });

  it("anyOf 为空同样不满足", () => {
    const issues = validateLoginSpec(spec({ success: [{ anyOf: [] }] }));
    expect(byRule(issues, "R7")).toHaveLength(1);
  });
});

describe("R1 成功先行", () => {
  it("auth.write 位于成功信号引用绑定之前报 R1", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "auth.write" },
          { op: "http.execute", url: "{origin}/api", as: "resp" },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
        auth: {
          mode: "engine",
          localStorageWrite: [{ key: "t", value: "$resp.token" }],
        },
      }),
    );
    const r1 = byRule(issues, "R1");
    expect(r1.length).toBeGreaterThan(0);
    expect(r1[0].opIndex).toBe(0);
  });

  it("page 信号要求 auth.write 位于最后一个 DOM 交互之后", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "auth.write" },
          { op: "fill", target: "#u", value: "{username}" },
          { op: "click", target: "#go" },
        ],
        auth: { mode: "engine" },
      }),
    );
    expect(byRule(issues, "R1")[0].opIndex).toBe(0);
  });

  it("auth.capture 同样受 R1 约束", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "auth.capture", cookies: "all", as: "snap" },
          { op: "http.execute", url: "{origin}/api", as: "resp" },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
        auth: { mode: "engine" },
      }),
    );
    expect(byRule(issues, "R1")[0].opIndex).toBe(0);
  });

  it("mode: page 时 auth.capture 仍受 R1 约束（D3 仅豁免 auth.write）", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "auth.capture", cookies: "all", as: "snap" },
          { op: "click", target: "#go" },
        ],
        auth: { mode: "page" },
      }),
    );
    expect(byRule(issues, "R1")[0].opIndex).toBe(0);
  });

  it("跨 origin 的落地 goto 不计入 DOM 基线（capture → goto → restore 可通过 R1）", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "fill", target: "#u", value: "{username}" },
          { op: "click", target: "#go" },
          { op: "auth.capture", cookies: "all", as: "snap" },
          { op: "goto", url: "{targetUrl}/home" },
          { op: "auth.restore", snapshot: "snap" },
        ],
        success: [{ page: { type: "urlChanged" } }],
        auth: { mode: "engine" },
      }),
    );
    expect(byRule(issues, "R1")).toEqual([]);
  });

  it("没有 restore 跟随的跨 origin goto 不算落地导航，仍计入 DOM 基线", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "fill", target: "#u", value: "{username}" },
          { op: "click", target: "#go" },
          { op: "auth.capture", cookies: "all", as: "snap" },
          { op: "goto", url: "{targetUrl}/home" },
        ],
        success: [{ page: { type: "urlChanged" } }],
        auth: { mode: "engine" },
      }),
    );
    expect(byRule(issues, "R1").some((i) => i.opIndex === 2)).toBe(true);
  });

  it("mode: page 时 auth.write 是空操作，R1 不适用", () => {
    expect(
      validateLoginSpec(
        spec({
          ops: [{ op: "auth.write" }, { op: "click", target: "#go" }],
          auth: { mode: "page" },
        }),
      ),
    ).toEqual([]);
  });
});

describe("R2 数据流可达", () => {
  it("引用后产出的绑定报 R2 并指出算子与绑定名", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          {
            op: "digest",
            algorithm: "sha256",
            input: "$resp.body",
            as: "sign",
          },
          { op: "http.execute", url: "{origin}/api", as: "resp" },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
      }),
    );
    const r2 = byRule(issues, "R2");
    expect(r2[0].opIndex).toBe(0);
    expect(r2[0].message).toContain("$resp.body");
  });

  it("goto.when 的引用同样受约束", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "goto", url: "{origin}/x", when: "$resp.redirect" },
          { op: "http.execute", url: "{origin}/api", as: "resp" },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
      }),
    );
    expect(byRule(issues, "R2")[0].opIndex).toBe(0);
  });

  it("引用不存在的绑定报 R2", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [{ op: "digest", algorithm: "sha1", input: "$nope", as: "d" }],
      }),
    );
    expect(byRule(issues, "R2")[0].message).toContain("$nope");
  });

  it("成功信号与 auth 写入值引用后产出的绑定也报 R2", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [{ op: "http.execute", url: "{origin}/api", as: "resp" }],
        success: [{ token: { from: "later", path: "token" } }],
      }),
    );
    expect(byRule(issues, "R2")).toHaveLength(1);
  });

  it("auth.write 位于产出其写入值的算子之前报 R2", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "auth.write" },
          { op: "http.execute", url: "{origin}/api", as: "resp" },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
        auth: {
          mode: "engine",
          cookiesWrite: [{ name: "t", value: "$resp.data.token" }],
        },
      }),
    );
    // auth.write（第 1 步）引用了第 2 步才产出的绑定
    const r2 = byRule(issues, "R2").filter((i) => i.opIndex === 0);
    expect(r2.length).toBeGreaterThan(0);
    expect(r2[0].message).toContain("$resp.data.token");
  });
});

describe("R3 跨 origin 写入", () => {
  it("跨 origin 的 goto 位于 auth.write 之前报 R3", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "goto", url: "{targetUrl}/home" },
          { op: "http.execute", url: "{origin}/api", as: "resp" },
          { op: "auth.write" },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
        auth: { mode: "engine" },
      }),
    );
    expect(byRule(issues, "R3")[0].opIndex).toBe(0);
  });

  it("同 origin 的登录页导航不受 R3 约束（默认模板形态）", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "clear.cookies", range: "all" },
          { op: "goto", url: "{origin}/login" },
          { op: "fill", target: "#u", value: "{username}" },
          { op: "fill", target: "#p", value: "{password}" },
          { op: "click", target: "#go" },
          { op: "auth.write" },
        ],
        auth: {
          mode: "engine",
          localStorageWrite: [{ key: "auth", value: "x" }],
        },
      }),
    );
    expect(byRule(issues, "R3")).toEqual([]);
  });

  it("auth.restore 不在任何 goto 之后报 R3", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "auth.capture", cookies: "all", as: "snap" },
          { op: "auth.restore", snapshot: "snap" },
        ],
        success: [{ page: { type: "urlChanged" } }],
        auth: { mode: "engine" },
      }),
    );
    expect(byRule(issues, "R3")[0].opIndex).toBe(1);
  });

  it("auth.restore 的快照由更晚的 capture 产出报 R3", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "goto", url: "{origin}/a" },
          { op: "auth.restore", snapshot: "snap" },
          { op: "auth.capture", cookies: "all", as: "snap" },
        ],
        success: [{ page: { type: "urlChanged" } }],
        auth: { mode: "engine" },
      }),
    );
    expect(byRule(issues, "R3").some((i) => i.opIndex === 1)).toBe(true);
  });

  it("capture → goto → restore 合法，且 restore 在 goto 之后", () => {
    const valid = spec({
      ops: [
        { op: "http.execute", url: "{origin}/api", as: "resp" },
        { op: "auth.capture", cookies: "all", as: "snap" },
        { op: "goto", url: "{targetUrl}/home" },
        { op: "auth.restore", snapshot: "snap" },
      ],
      success: [{ response: { from: "resp", path: "ok", equals: true } }],
      auth: { mode: "engine" },
    });
    expect(validateLoginSpec(valid)).toEqual([]);
  });
});

describe("R4 输入已声明", () => {
  it("未声明的输入引用报 R4 并定位算子", () => {
    const issues = validateLoginSpec(
      spec({ ops: [{ op: "fill", target: "#u", value: "{usernam}" }] }),
    );
    expect(byRule(issues, "R4")[0].opIndex).toBe(0);
    expect(byRule(issues, "R4")[0].message).toContain("usernam");
  });

  it("vars / aux 声明的名字合法", () => {
    expect(
      validateLoginSpec(
        spec({
          vars: [{ name: "tenant" }],
          aux: { nonce: "auto" },
          ops: [
            { op: "fill", target: "#t", value: "{tenant}" },
            { op: "fill", target: "#n", value: "{nonce}" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("未声明 aux 时引用 {nonce} 报 R4", () => {
    const issues = validateLoginSpec(
      spec({ ops: [{ op: "fill", target: "#n", value: "{nonce}" }] }),
    );
    expect(byRule(issues, "R4")[0].message).toContain("nonce");
  });

  it("vars 重名本身报 CONFIG_INVALID", () => {
    const issues = validateLoginSpec(spec({ vars: [{ name: "password" }] }));
    expect(codes(issues)).toContain("CONFIG_INVALID");
  });
});

describe("script.code 豁免", () => {
  it("代码里的花括号 / $ / 未知引用不参与校验", () => {
    const code = "const o = {a: 1}; return {x: $nope, y: '{missing}', z: '$$'}";
    expect(
      validateLoginSpec(
        spec({
          ops: [{ op: "script", code, as: "s" }],
          success: [{ page: { type: "formGone" } }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("R5 绑定唯一", () => {
  it("同一 as 重复报 R5，指出后一次下标", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "http.execute", url: "{origin}/a", as: "resp" },
          { op: "http.execute", url: "{origin}/b", as: "resp" },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
      }),
    );
    expect(byRule(issues, "R5")[0].opIndex).toBe(1);
    expect(byRule(issues, "R5")[0].message).toContain("resp");
  });
});

describe("R6 算子前置", () => {
  it("apply.set 之后没有 http.execute 报 R6", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "digest", algorithm: "sha1", input: "{username}", as: "d" },
          { op: "apply.set", target: "header", key: "X", value: "$d" },
        ],
      }),
    );
    expect(byRule(issues, "R6")[0].opIndex).toBe(1);
  });

  it("apply.set(body) 之后的请求 body 不是 json/对象引用报 R6", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "digest", algorithm: "sha1", input: "{username}", as: "d" },
          { op: "apply.set", target: "body", key: "sign", value: "$d" },
          {
            op: "http.execute",
            url: "{origin}/api",
            method: "POST",
            body: { raw: "plain" },
            as: "resp",
          },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
      }),
    );
    expect(
      byRule(issues, "R6").some(
        (i) => i.opIndex === 1 && i.message.includes("body"),
      ),
    ).toBe(true);
  });

  it("http.execute.body.ref 引用更晚产出的对象报 R2", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          {
            op: "http.execute",
            url: "{origin}/api",
            method: "POST",
            body: { ref: "body" },
            as: "resp",
          },
          {
            op: "payload.build",
            parts: [{ key: "a", value: "{username}" }],
            as: "body",
          },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
      }),
    );
    expect(
      byRule(issues, "R2").some(
        (i) => i.opIndex === 0 && i.message.includes("$body"),
      ),
    ).toBe(true);
  });

  it("auth.restore 引用非 capture 绑定报 R6", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "goto", url: "{origin}/a" },
          { op: "http.execute", url: "{origin}/api", as: "notSnap" },
          { op: "auth.restore", snapshot: "notSnap" },
        ],
        success: [{ token: { from: "notSnap", path: "token" } }],
      }),
    );
    expect(byRule(issues, "R6").some((i) => i.opIndex === 2)).toBe(true);
  });

  it("http.execute.body.ref 引用非 payload.build 产出报 R6", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          { op: "extract", source: "local", key: "x", as: "body" },
          {
            op: "http.execute",
            url: "{origin}/api",
            body: { ref: "body" },
            as: "resp",
          },
        ],
        success: [{ token: { from: "resp", path: "token" } }],
      }),
    );
    expect(byRule(issues, "R6")[0].opIndex).toBe(1);
  });

  it("payload.build 混用两种模式报 R6", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [
          {
            op: "payload.build",
            parts: [{ key: "a", value: "{username}" }, { value: "{password}" }],
            join: "",
            as: "bad",
          },
        ],
      }),
    );
    expect(byRule(issues, "R6")[0].opIndex).toBe(0);
  });
});

describe("failure 声明形状", () => {
  it("failure 不是合法结算条件报 CONFIG_INVALID", () => {
    const issues = validateLoginSpec(
      spec({ failure: [{ bogus: 1 } as unknown as SettleCondition] }),
    );
    expect(codes(issues)).toContain("CONFIG_INVALID");
  });
});

describe("auth 声明形状", () => {
  it("cookiesWrite 的 sameSite 非法报 CONFIG_INVALID", () => {
    const issues = validateLoginSpec(
      spec({
        auth: {
          mode: "engine",
          cookiesWrite: [{ name: "t", value: "x", sameSite: "Lax" as never }],
        },
      }),
    );
    expect(codes(issues)).toContain("CONFIG_INVALID");
  });

  it("expiresFrom.from 引用不存在的绑定报 CONFIG_INVALID（D7）", () => {
    const issues = validateLoginSpec(
      spec({
        ops: [{ op: "http.execute", url: "{origin}/api", as: "resp" }],
        success: [{ token: { from: "resp", path: "token" } }],
        auth: {
          mode: "engine",
          cookiesWrite: [
            {
              name: "t",
              value: "$resp.token",
              expiresFrom: { from: "nope", path: "exp", unit: "epochMs" },
            },
          ],
        },
      }),
    );
    expect(
      issues.some((i) => i.rule === "R2" && i.message.includes("nope")),
    ).toBe(true);
  });

  it("auth 缺失时报 CONFIG_INVALID 而不是抛异常", () => {
    expect(() =>
      validateLoginSpec({
        ...spec({ ops: [{ op: "auth.write" }] }),
        auth: undefined,
      } as unknown as LoginSpec),
    ).not.toThrow();
    expect(
      codes(
        validateLoginSpec({
          ...spec({ ops: [{ op: "auth.write" }] }),
          auth: undefined,
        } as unknown as LoginSpec),
      ),
    ).toContain("CONFIG_INVALID");
  });

  it("expiresFrom 单位非法报 CONFIG_INVALID", () => {
    const issues = validateLoginSpec(
      spec({
        auth: {
          mode: "engine",
          cookiesWrite: [
            {
              name: "t",
              value: "x",
              expiresFrom: {
                from: "resp",
                path: "exp",
                unit: "seconds" as never,
              },
            },
          ],
        },
      }),
    );
    expect(codes(issues)).toContain("CONFIG_INVALID");
  });
});

describe("自动登录定位结构", () => {
  const automaticOps = (): SpecOp[] => [
    { op: "goto", url: "{origin}/login" },
    { op: "fill", target: AUTO_LOGIN_TARGET, value: "{username}" },
    { op: "fill", target: AUTO_LOGIN_TARGET, value: "{password}" },
    { op: "click", target: AUTO_LOGIN_TARGET, onNotFound: "fail" },
  ];

  it("接受完整标准三步自动组合", () => {
    expect(validateLoginSpec(spec({ ops: automaticOps() }))).toEqual([]);
  });

  it("拒绝自定义三空定位，不把它猜成旧默认", () => {
    const empty = automaticOps().map((op) =>
      op.op === "fill" || op.op === "click" ? { ...op, target: "" } : op,
    );
    const issues = validateLoginSpec(spec({ template: "custom", ops: empty }));
    expect(issues.filter((issue) => issue.code === "CONFIG_INVALID").map((issue) => issue.opIndex))
      .toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("拒绝部分自动和错误顺序", () => {
    const partial = automaticOps();
    partial[1] = { op: "fill", target: "#u", value: "{username}" };
    expect(validateLoginSpec(spec({ ops: partial })).some((issue) => issue.opIndex === 2)).toBe(true);

    const wrongOrder = automaticOps();
    wrongOrder[1] = { op: "fill", target: AUTO_LOGIN_TARGET, value: "{password}" };
    wrongOrder[2] = { op: "fill", target: AUTO_LOGIN_TARGET, value: "{username}" };
    expect(codes(validateLoginSpec(spec({ ops: wrongOrder })))).toContain("CONFIG_INVALID");
  });

  it("拒绝高级非标准声明中的自动组合", () => {
    const ops = [...automaticOps(), { op: "waitFor", when: { type: "fixed", ms: 1 } } as SpecOp];
    expect(codes(validateLoginSpec(spec({ ops })))).toContain("CONFIG_INVALID");
  });

  it.each([
    { auto: "sso" },
    { auto: "login", css: "#u" },
  ])("拒绝非法自动标记 %j", (target) => {
    const ops = automaticOps();
    ops[1] = { op: "fill", target: target as never, value: "{username}" };
    const issues = validateLoginSpec(spec({ ops }));
    expect(issues.some((issue) => issue.code === "CONFIG_INVALID" && issue.opIndex === 1)).toBe(true);
  });

  it("拒绝在 waitFor 和 DOM extract 中使用自动标记", () => {
    const waitIssues = validateLoginSpec(spec({
      ops: [{ op: "waitFor", when: { type: "selector", target: AUTO_LOGIN_TARGET as never } }],
    }));
    expect(waitIssues.some((issue) => issue.code === "CONFIG_INVALID" && issue.opIndex === 0)).toBe(true);

    const extractIssues = validateLoginSpec(spec({
      ops: [{ op: "extract", source: "dom", key: AUTO_LOGIN_TARGET as never, as: "field" }],
    }));
    expect(extractIssues.some((issue) => issue.code === "CONFIG_INVALID" && issue.opIndex === 0)).toBe(true);
  });
});
