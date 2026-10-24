---
name: authoring-shadekit-login-specs
description: Use when exploring a user-provided application directory to build, debug, or validate ShadeKit quick-login declarations, LoginSpec v2 JSON, API-first login strategies, or dt-login-config/v1 import packages, especially when credentials, CSRF, signatures, cookies, session storage, or page-only login behavior are involved.
---

# 编写 ShadeKit 登录策略

## 核心原则

从用户目录中的**实际登录调用链**生成声明，不从接口名或 UI 猜测。优先接口，但只采用当前 LoginSpec 能忠实表达的流程；静态合法不等于登录成功，更不等于会话已正确建立。

## 事实源

目标系统探索限定在用户提供的目录；另读取 ShadeKit 当前实现，不用记忆或旧 ADR 覆盖代码：

| 用途 | 文件 |
|---|---|
| 类型、输入、算子 | `entrypoints/tools/account-switch/spec/types.ts`、`docs/login-specs/operators.md` |
| R1–R7、执行顺序、试登录 | `spec/validate.ts`、`spec/run.ts`、`spec/trial.ts` |
| HTTP / 会话 / 打包 | `spec/http.ts`、`spec/session.ts`、`spec/package.ts` |
| 本地包约定 | `docs/login-specs/README.md` |

上表 `spec/` 均指 `entrypoints/tools/account-switch/spec/`。代码与文档冲突时，以代码和当前测试为准。

## 工作流

1. **追踪证据**：定位登录入口 → 认证客户端 → 环境配置 → 服务端契约/测试。记录请求顺序、字段与 header、CSRF/编码/签名、响应成功与失败形状、会话建立方式、必要页面挑战值；为关键结论保留文件/行号。缺目录时先询问，不扫描整个磁盘找目标。
2. **选择可表达的流程**：
   - 优先使用 `http.execute` + `payload.build` / `digest` / `crypto.encrypt` / `map` / `apply.set`，前提是请求及会话效果均可由当前 LoginSpec 忠实声明。
   - `http.execute` 只绑定响应体，不能从 `$resp.headers` 取 Set-Cookie，也没有通用 Cookie Jar 配置；2xx 不证明浏览器会话存在。依赖渲染页状态或表单提交管理的 HttpOnly 会话时，保留最小 `goto` / `fill` / `click`，使用 `auth.mode: "page"`，不把通用 HTTP 客户端的能力当作声明能力。
   - 引擎写响应中的 token 时，用 `auth.mode: "engine"` + `auth.write`；按证据声明 Cookie domain/path/SameSite/expiry 和 local/sessionStorage，不把 token 同时写入应用未使用的存储。
   - 缺字段、MFA/验证码、未支持算法、必须依赖 `script` 或无法声明的会话行为，输出 **BLOCKED** 和具体缺口；不伪造可导入成品。
3. **编排声明**：使用 `{username}` / `{password}` / `{origin}`；其他 `{name}` 必须来自 `vars` / `aux`。绑定先产出再引用。页面 URL 的 `SettleCondition.glob` 不渲染模板，使用当前实现实际匹配的 glob（如 `*/workspace`），不写 `{origin}/workspace`。`success[]` 是 AND，`anyOf` 是 OR。成功引用的绑定及 page 条件必须满足 R1 的顺序要求，不能表述成“success 是一个会提前执行的步骤”。
4. **保护会话写入**：`runSpec` 在全部算子后才最终判定成功；`auth.write` 可能先于业务失败判定执行。若响应可能是 HTTP 2xx + 业务失败，不能仅写 `success.response` 就算完成。对 engine 写入，在 `auth.write` 前用无 default 的 `map` 仅匹配成功值，产出会话对象/值，所有 Cookie/Storage 值从该门控绑定或其派生路径读取：

```json
{ "op": "map", "input": "$login.code", "cases": [{ "equals": 0, "value": "$login.data" }], "as": "accepted" }
```

后续使用 `$accepted.sessionToken` 等路径，同时保留 `success: [{ "response": { "from": "login", "path": "code", "equals": 0 } }]`。所有 Cookie/Storage 的值及 `expiresFrom.from` 都必须位于门控之后，未门控的 expiry 同样可能提前写会话。业务拒绝会以 `CONFIG_INVALID` 提前停止，这是当前 map 门控的已知错误码限制，不宣称等于理想 `LOGIN_REJECTED`。若不能用声明式门控保护会话，标记 BLOCKED，而非接受错误会话污染。
5. **生成双交付物**：完整独立 `LoginSpec v2` JSON，以及 `format: "dt-login-config/v1"`、`specVersion: 2`、`environments[].spec` 嵌同一声明的包。包级与环境级 `requiredVars` 同步，且仅含已声明的非敏感变量。地址未知用字面量 `"{origin}"`，导入 UI 会询问真实地址。
6. **验证后交付**：实际调用 `validateLoginSpec(spec)`、`buildConfigPackage(...)` 和 `validateConfigPackage(pkg)`；检查包内 spec 与独立 spec 相等。包校验通过不能替代内层声明校验。用本地内存 HTTP/Chrome stub 覆盖业务成功与业务拒绝，断言成功会话正确、拒绝时零引擎会话写入；目标源码已明确业务失败不会返回任何会话值时，可改用有证据的模板缺失阻断并说明。无法测试时明确列为未验证，不虚构结果。

## 包与隐私边界

包不包含账号绑定、真实凭据/token、secret 变量或 `script`；`log.reveal` 不用于秘密。优先通过 `buildConfigPackage` 构造，而非手写外壳。真实内部策略放 `docs/login-specs/*.local.json`；示例保持虚构。不要为测试自动请求真实登录、提交表单或写会话；试登录也会发真实请求，需单独获得用户明确授权。

## 交付契约

证据足够且可表达时，按顺序交付：

1. 完整 LoginSpec JSON；
2. 内嵌同一声明的策略包 JSON（两份内容而非只给骨架；文件名可分别用 `login-spec.json` 与 `dt-login-config.json`）；
3. 证据、必要假设及文件路径；
4. 实际执行的校验命令与结果；
5. 未验证边界（真实导入、运行、会话写入未做则明说）。

缺信息或能力不支持时，以 **BLOCKED + 缺口 + 针对性问题** 代替“完整双文件”。只有实际完成的验证才能声称通过；未执行真实登录就不能写“登录成功”。

## 常见误区速查

| 情况 | 正确处理 |
|---|---|
| “接口更快，跳过页面挑战值” | 只有请求与会话效果均可表达才用纯 HTTP |
| “响应有 token / HTTP 200，所以成功” | 使用应用代码证明的业务成功条件 |
| “success 已声明，失败不会写会话” | 检查执行顺序；engine 写入前增加业务门控 |
| “包格式正确，所以可导入” | 同时验证内层 spec、包构造与包校验 |
| “试登录通过即可交付” | 区分请求、数据信号、页面信号及会话写入；报告实际范围 |
