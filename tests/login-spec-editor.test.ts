/**
 * login-spec/editor — 编辑器纯逻辑（S2 seam）
 *
 * 零浏览器 API、零 chrome stub。覆盖：默认模板可保存、简易视图判定与
 * 往返无损、可用引用清单、错误归位、算子工厂与增删排序/复制/改类型。
 */
import { describe, expect, it } from "vitest";
import type { SpecOp } from "../entrypoints/tools/account-switch/spec/types";
import { validateLoginSpec } from "../entrypoints/tools/account-switch/spec/validate";
import {
  bucketSpecErrors,
  changeSpecOp,
  cloneSpecOps,
  createSpecOp,
  defaultLoginSpec,
  duplicateSpecOp,
  hasSpecErrors,
  insertSpecOp,
  moveSpecOp,
  removeSpecOp,
  reorderOpsAroundForm,
  setSpecAuthStorageCleanup,
  setSpecLoginUrl,
  simpleSpecShape,
  specAuxToEdit,
  specInputHints,
  specsAux,
  specsVariables,
  specVarsToEdit,
  updateSpecOp,
} from "../entrypoints/tools/account-switch/spec/editor";

function simpleOps(): SpecOp[] {
  return [
    { op: "clear.cookies", range: "all" },
    { op: "goto", url: "{origin}/login" },
    { op: "fill", target: "#u", value: "{username}" },
    { op: "fill", target: "#p", value: "{password}" },
    { op: "click", target: "#go", onNotFound: "fail" },
    { op: "auth.write" },
  ];
}

describe("defaultLoginSpec", () => {
  it("可直接通过 R1–R7 校验（可保存）", () => {
    const spec = defaultLoginSpec();
    expect(validateLoginSpec(spec)).toEqual([]);
  });

  it("剔除 clear/auth.write 后落在简易形态", () => {
    expect(simpleSpecShape(defaultLoginSpec())).not.toBeNull();
  });
});

describe("simpleSpecShape", () => {
  it("标准三步（含清理与写会话）→ 返回下标定位", () => {
    const spec = {
      version: 2 as const,
      ops: simpleOps(),
      success: [],
      auth: { mode: "engine" as const },
    };
    // 断言返回的是「原始数组」下标（clear 在 0、auth.write 在 5 被剔除）
    expect(simpleSpecShape(spec)).toEqual({
      gotoIndex: 1,
      usernameIndex: 2,
      passwordIndex: 3,
      submitIndex: 4,
    });
  });

  it("无 goto → 无 goto 下标", () => {
    const ops = simpleOps().filter((o) => o.op !== "goto");
    // 剔除后：clear(0), fill#u(1), fill#p(2), click(3), auth.write(4)
    const spec = {
      version: 2 as const,
      ops,
      success: [],
      auth: { mode: "engine" as const },
    };
    expect(simpleSpecShape(spec)).toEqual({
      usernameIndex: 1,
      passwordIndex: 2,
      submitIndex: 3,
    });
  });

  it("多出非登录算子（http.execute）→ 不适用", () => {
    const ops = [
      ...simpleOps(),
      { op: "http.execute" as const, url: "{origin}/api", as: "resp" },
    ];
    const spec = {
      version: 2 as const,
      ops,
      success: [],
      auth: { mode: "engine" as const },
    };
    expect(simpleSpecShape(spec)).toBeNull();
  });

  it("值不是 {username}/{password} → 不适用", () => {
    const ops = simpleOps().map((o) =>
      o.op === "fill" && o.value === "{username}"
        ? { ...o, value: "admin" }
        : o,
    );
    const spec = {
      version: 2 as const,
      ops,
      success: [],
      auth: { mode: "engine" as const },
    };
    expect(simpleSpecShape(spec)).toBeNull();
  });

  it("末尾不是 click → 不适用", () => {
    const ops: SpecOp[] = [
      { op: "clear.cookies", range: "all" },
      { op: "goto", url: "{origin}/login" },
      { op: "fill", target: "#u", value: "{username}" },
      { op: "fill", target: "#p", value: "{password}" },
      { op: "fill", target: "#hny", value: "{username}" },
      { op: "auth.write" },
    ];
    const spec = {
      version: 2 as const,
      ops,
      success: [],
      auth: { mode: "engine" as const },
    };
    // 剔除后是 goto+3×fill：长度 4 但第 4 个不是 click
    expect(simpleSpecShape(spec)).toBeNull();
  });
});

describe("specInputHints", () => {
  it("列出内置输入", () => {
    const spec = defaultLoginSpec();
    const tokens = specInputHints(spec).map((h) => h.token);
    expect(tokens).toContain("{username}");
    expect(tokens).toContain("{origin}");
    expect(tokens).toContain("{targetUrl}");
  });

  it("包含 vars 与已声明 aux", () => {
    const spec = {
      ...defaultLoginSpec(),
      vars: [{ name: "publicKey", title: "公钥" }],
      aux: { nonce: "auto" as const },
    };
    const hints = specInputHints(spec);
    expect(hints.map((h) => h.token)).toContain("{publicKey}");
    expect(hints.map((h) => h.token)).toContain("{nonce}");
    expect(hints.map((h) => h.token)).not.toContain("{timestamp}");
  });
});

describe("bucketSpecErrors", () => {
  it("带 opIndex 进 ops[i]，否则进 general", () => {
    const errors = bucketSpecErrors([
      { code: "CONFIG_INVALID", message: "算子 0 错", opIndex: 0 },
      { code: "CONFIG_INVALID", message: "spec 级错" },
      { code: "CONFIG_INVALID", message: "算子 2 错", opIndex: 2 },
      { code: "CONFIG_INVALID", message: "算子 0 另一错", opIndex: 0 },
    ]);
    expect(errors.general).toEqual(["spec 级错"]);
    expect(errors.ops[0]).toHaveLength(2);
    expect(errors.ops[2]).toEqual(["算子 2 错"]);
  });

  it("hasSpecErrors 判空", () => {
    expect(hasSpecErrors({ general: [], ops: {} })).toBe(false);
    expect(hasSpecErrors({ general: ["x"], ops: {} })).toBe(true);
    expect(hasSpecErrors({ general: [], ops: { 1: ["y"] } })).toBe(true);
  });
});

describe("createSpecOp / changeSpecOp", () => {
  it("fill/click 互切保留 target", () => {
    const fill: SpecOp = { op: "fill", target: "#u", value: "{username}" };
    const clicked = changeSpecOp(fill, "click");
    expect(clicked).toEqual({ op: "click", target: "#u", onNotFound: "fail" });

    const back = changeSpecOp(clicked, "fill");
    expect(back).toMatchObject({ op: "fill", target: "#u" });
  });

  it("fill/click 互切保留 frame 范围（spec 行 12）", () => {
    const fill: SpecOp = {
      op: "fill",
      target: "#u",
      value: "{username}",
      frameId: 3,
      frameUrl: "https://x/login",
    };
    const clicked = changeSpecOp(fill, "click");
    expect(clicked).toMatchObject({
      op: "click",
      target: "#u",
      frameId: 3,
      frameUrl: "https://x/login",
    });
    const back = changeSpecOp(clicked, "fill");
    expect(back).toMatchObject({
      op: "fill",
      frameId: 3,
      frameUrl: "https://x/login",
      value: "",
    });
  });

  it("不同家族切换按默认重建", () => {
    const fill: SpecOp = { op: "fill", target: "#u", value: "{username}" };
    expect(changeSpecOp(fill, "goto")).toEqual({ op: "goto", url: "" });
  });

  it("每种 op 都有默认骨架", () => {
    for (const name of [
      "clear.cookies",
      "clear.storage",
      "goto",
      "http.execute",
      "auth.write",
      "waitFor",
      "extract",
    ] as const) {
      const op = createSpecOp(name);
      expect(op.op).toBe(name);
    }
  });
});

describe("reorderOpsAroundForm（智能识别回填重排）", () => {
  it("clear.* 提到最前、auth.* 押后，表单段居中", () => {
    // 复现管理后台的形态：goto + 表单 + clear + auth.write
    // （旧 applyScan 会把 clear 挪到 click 之后，导致已登录主页无法切号）
    const existing: SpecOp[] = [
      { op: "clear.cookies", range: "all" },
      { op: "goto", url: "{origin}/admin/login", waitForLoad: true },
      { op: "fill", target: "#old-u", value: "{username}" },
      { op: "fill", target: "#old-p", value: "{password}" },
      { op: "click", target: "#old-go", onNotFound: "fail" },
      { op: "auth.write" },
    ];
    const formOps: SpecOp[] = [
      {
        op: "fill",
        target: { placeholder: "请输入手机号" },
        value: "{username}",
      },
      {
        op: "fill",
        target: { placeholder: "请输入密码" },
        value: "{password}",
      },
      { op: "click", target: { text: "登 录" }, onNotFound: "fail" },
    ];
    const next = reorderOpsAroundForm(existing, formOps);
    expect(next.map((o) => o.op)).toEqual([
      "clear.cookies",
      "goto",
      "fill",
      "fill",
      "click",
      "auth.write",
    ]);
    // 表单段是识别结果，不是旧 fill
    expect(next[2]).toEqual(formOps[0]);
    expect(next[4]).toEqual(formOps[2]);
  });

  it("多个清理算子保持原相对顺序", () => {
    const existing: SpecOp[] = [
      { op: "clear.cookies", range: "all" },
      { op: "fill", target: "", value: "{username}" },
      { op: "clear.storage", area: "local", range: "all" },
      { op: "fill", target: "", value: "{password}" },
      { op: "clear.storage", area: "session", range: "all" },
      { op: "click", target: "", onNotFound: "fail" },
    ];
    const next = reorderOpsAroundForm(existing, []);
    const clears = next.filter(
      (o) => o.op === "clear.cookies" || o.op === "clear.storage",
    );
    expect(
      clears.map((o) => (o.op === "clear.storage" ? o.area : "cookies")),
    ).toEqual(["cookies", "local", "session"]);
    // 且都在最前
    expect(next.slice(0, 3).every((o) => o.op.startsWith("clear."))).toBe(true);
  });

  it("没有 goto 时不补，没有 clear/auth 时也不无中生有", () => {
    const existing: SpecOp[] = [
      { op: "fill", target: "#u", value: "{username}" },
      { op: "fill", target: "#p", value: "{password}" },
      { op: "click", target: "#go", onNotFound: "fail" },
    ];
    const formOps: SpecOp[] = [
      { op: "fill", target: "#nu", value: "{username}" },
      { op: "fill", target: "#np", value: "{password}" },
      { op: "click", target: "#ngo", onNotFound: "fail" },
    ];
    expect(reorderOpsAroundForm(existing, formOps)).toEqual(formOps);
  });

  it("中间算子（extract/script/waitFor/http.execute 等）保持原顺序，接在表单段后", () => {
    const existing: SpecOp[] = [
      { op: "clear.cookies", range: "all" },
      { op: "goto", url: "{origin}/login" },
      {
        op: "extract",
        source: "local",
        key: "language",
        as: "lang",
        default: "zh",
      },
      { op: "fill", target: "#u", value: "{username}" },
      { op: "waitFor", when: { type: "fixed", ms: 200 } },
      { op: "fill", target: "#p", value: "{password}" },
      { op: "click", target: "#go", onNotFound: "fail" },
      { op: "script", code: "() => 1", as: "probe" },
      { op: "auth.write" },
    ];
    const formOps: SpecOp[] = [
      { op: "fill", target: "#nu", value: "{username}" },
      { op: "fill", target: "#np", value: "{password}" },
      { op: "click", target: "#ngo", onNotFound: "fail" },
    ];
    const next = reorderOpsAroundForm(existing, formOps);
    expect(next.map((o) => o.op)).toEqual([
      "clear.cookies",
      "goto",
      "fill",
      "fill",
      "click",
      "extract", // 中间算子保持原相对顺序
      "waitFor",
      "script",
      "auth.write",
    ]);
  });

  it("auth.capture / auth.restore 同样押后（写会话族）", () => {
    const existing: SpecOp[] = [
      { op: "auth.capture", as: "snap" },
      { op: "goto", url: "{origin}/login" },
      { op: "fill", target: "#u", value: "{username}" },
      { op: "auth.restore", snapshot: "snap" },
      { op: "click", target: "#go", onNotFound: "fail" },
    ];
    const next = reorderOpsAroundForm(existing, []);
    expect(next.map((o) => o.op)).toEqual([
      "goto",
      "auth.capture",
      "auth.restore",
    ]);
  });
});

describe("setSpecLoginUrl（简易视图登录页）", () => {
  it("新增 goto 放在全部前导清理之后，并等待页面加载", () => {
    const ops: SpecOp[] = [
      { op: "clear.cookies", range: "all" },
      { op: "clear.storage", area: "local", range: "all" },
      {
        op: "fill",
        target: { placeholder: "请输入手机号" },
        value: "{username}",
      },
      {
        op: "fill",
        target: { placeholder: "请输入密码" },
        value: "{password}",
      },
      { op: "click", target: { text: "登 录" }, onNotFound: "fail" },
      { op: "auth.write" },
    ];
    const next = setSpecLoginUrl(ops, "{origin}/admin/login");
    expect(next.map((op) => op.op)).toEqual([
      "clear.cookies",
      "clear.storage",
      "goto",
      "fill",
      "fill",
      "click",
      "auth.write",
    ]);
    expect(next[2]).toEqual({
      op: "goto",
      url: "{origin}/admin/login",
      waitForLoad: true,
    });
  });

  it("没有清理算子时插在表单前，空地址时移除已有 goto", () => {
    const withGoto = setSpecLoginUrl(
      simpleOps().filter(
        (op) => op.op !== "goto" && !op.op.startsWith("clear."),
      ),
      "{origin}/login",
    );
    expect(withGoto[0]).toMatchObject({ op: "goto", url: "{origin}/login" });
    expect(setSpecLoginUrl(withGoto, " ").some((op) => op.op === "goto")).toBe(
      false,
    );
  });

  it("更新已有 goto 不重复插入并保留加载等待设置", () => {
    const next = setSpecLoginUrl(simpleOps(), "{origin}/admin/login");
    expect(next.filter((op) => op.op === "goto")).toHaveLength(1);
    expect(next[1]).toEqual({ op: "goto", url: "{origin}/admin/login" });
  });
});

describe("setSpecAuthStorageCleanup（精准本地登录态清理）", () => {
  it("按 local/session 分组去重并放在 Cookie 清理后、登录页前", () => {
    const next = setSpecAuthStorageCleanup(simpleOps(), {
      local: ["token", " userInfo ", "token"],
      session: ["access_token"],
    });
    expect(next.slice(0, 4)).toEqual([
      { op: "clear.cookies", range: "all" },
      { op: "clear.storage", area: "local", range: ["token", "userInfo"] },
      { op: "clear.storage", area: "session", range: ["access_token"] },
      { op: "goto", url: "{origin}/login" },
    ]);
  });

  it("空选择移除前导自动清理但保留后续自定义 storage 算子", () => {
    const custom: SpecOp = {
      op: "clear.storage",
      area: "local",
      range: ["keep-me"],
    };
    const ops: SpecOp[] = [
      { op: "clear.cookies", range: "all" },
      { op: "clear.storage", area: "local", range: "all" },
      { op: "goto", url: "{origin}/login" },
      custom,
    ];
    const next = setSpecAuthStorageCleanup(ops, { local: [], session: [] });
    expect(next).toEqual([ops[0], ops[2], custom]);
  });
});

describe("算子数组操作", () => {
  const ops: SpecOp[] = [
    { op: "goto", url: "{origin}/login" },
    { op: "fill", target: "#u", value: "{username}" },
  ];

  it("cloneSpecOps 深拷贝", () => {
    const copy = cloneSpecOps(ops);
    expect(copy).toEqual(ops);
    expect(copy).not.toBe(ops);
    expect(copy[0]).not.toBe(ops[0]);
  });

  it("moveSpecOp 上下移，越界不动", () => {
    const moved = moveSpecOp(ops, 1, -1);
    expect(moved[0].op).toBe("fill");
    expect(moved[1].op).toBe("goto");
    expect(moveSpecOp(ops, 0, -1)).toEqual(ops);
    expect(moveSpecOp(ops, 1, 1)).toEqual(ops);
  });

  it("removeSpecOp 删除", () => {
    expect(removeSpecOp(ops, 0)).toHaveLength(1);
  });

  it("insertSpecOp / duplicateSpecOp 插入与复制", () => {
    expect(
      insertSpecOp(ops, -1, { op: "click", target: "#go", onNotFound: "fail" }),
    ).toHaveLength(3);
    const dup = duplicateSpecOp(ops, 1);
    expect(dup).toHaveLength(3);
    expect(dup[2]).toEqual(ops[1]);
  });

  it("updateSpecOp 不可变补丁", () => {
    const next = updateSpecOp(ops, 0, { url: "{origin}/other" });
    expect(next[0]).toMatchObject({ op: "goto", url: "{origin}/other" });
    expect(ops[0]).toMatchObject({ op: "goto", url: "{origin}/login" });
  });
});

describe("vars / aux 往返", () => {
  it("vars 编辑清单 → spec.vars（空名丢弃）", () => {
    const vars = specsVariables([
      { name: "publicKey", title: "公钥", default: "abc" },
      { name: "", title: "", default: "" },
    ]);
    expect(vars).toEqual([
      { name: "publicKey", title: "公钥", default: "abc" },
    ]);
    expect(
      specVarsToEdit({
        version: 2 as const,
        ops: [],
        success: [],
        auth: { mode: "engine" as const },
        vars,
      }),
    ).toEqual([{ name: "publicKey", title: "公钥", default: "abc" }]);
  });

  it("aux 往返", () => {
    expect(specsAux({ nonce: true, timestamp: false })).toEqual({
      nonce: "auto",
    });
    expect(
      specAuxToEdit({
        version: 2 as const,
        ops: [],
        success: [],
        auth: { mode: "engine" as const },
        aux: { timestamp: "auto" },
      }),
    ).toEqual({ nonce: false, timestamp: true });
  });
});
