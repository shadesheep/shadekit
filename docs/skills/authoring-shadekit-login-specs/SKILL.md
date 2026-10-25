---
name: authoring-shadekit-login-specs
description: Use when authoring, debugging, or validating ShadeKit quick-login declarations, LoginSpec v2 JSON, API-first login strategies, or dt-login-config/v1 packages from source directories, pasted code, HAR, OpenAPI, or request/response evidence, with or without a ShadeKit checkout, especially for CSRF, signatures, cookies, storage, or page-managed sessions.
---

# 编写 ShadeKit 登录策略

## 核心原则

从目标系统的实际证据生成声明，不从接口名或 UI 猜测。默认使用 Skill 内置的兼容快照，**不需要 ShadeKit 仓库**；有仓库时再增加官方复核。静态合法、离线行为通过、仓库复核和真实登录是四种不同结论。

运行内置工具需要 Node.js >=20，无需安装 Skill 依赖。将下文 `<skill>` 替换为本技能目录的绝对路径；命令可从任意工作目录运行。

## 事实源与能力边界

- 目标证据：用户指定目录、粘贴代码、HAR、OpenAPI、请求/响应样例。只探索明确提供的位置，不扫描磁盘。
- ShadeKit 语义：`compatibility.json` 标明的内置快照。字段与执行规则见 [LoginSpec v2](references/login-spec-v2.md)。
- 包规则见 [策略包 v1](references/config-package-v1.md)；证据模式与 BLOCKED 判断见 [编写模式](references/authoring-patterns.md)。
- 内置模拟只覆盖数据平面。DOM、页面条件、真实 Cookie/Storage、failure 轮询均为 `NOT_SIMULATED`，不能跳过步骤后声称通过。

## 六步工作流

### 1. 追踪证据

定位登录入口 → 认证客户端 → 环境配置 → 服务契约/测试。记录请求顺序、字段/header、CSRF/编码/签名、业务成功与失败形状、会话建立方式及页面挑战值；保留文件/行号或材料位置。

没有 ShadeKit 仓库可继续。没有足够目标证据时输出 **BLOCKED + 缺口 + 针对性问题**。

### 2. 选择可表达流程

- 请求和会话效果都可声明时优先 `http.execute` + 数据算子。
- 页面自管或 HttpOnly 会话保留最小 `goto` / `fill` / `click`，使用 `auth.mode: "page"`；`http.execute` 不绑定响应头，也没有通用 Cookie Jar。
- engine 写 token 时使用 `auth.mode: "engine"` + `auth.write`，只写应用实际使用的 Cookie/Storage。
- MFA、验证码、未支持算法、必须依赖 `script` 或无法声明的会话行为输出 BLOCKED。

### 3. 编排双交付物

生成完整 `login-spec.json` 与 `dt-login-config.json`，不是骨架。使用 `{username}` / `{password}` / `{origin}`；其他输入必须来自 `vars` / `aux`，绑定先产出再引用。

engine 会话必须由业务成功门控保护：当前 lint 接受单一直接 `response.equals` 成功信号及匹配它的无 default `map`，并接受其 `payload.build` / `map` 派生绑定。所有 Cookie/Storage 值及 `expiresFrom.from` 都必须来自该门控；复杂成功条件无法静态证明时 BLOCKED。

用包构造器保持两级 `requiredVars` 同步。默认必填项是无默认值、非 secret 的声明变量；地址未知用字面量 `{origin}`：

```bash
node <skill>/scripts/package.mjs \
  --spec login-spec.json --name "Example" --url "{origin}" \
  --out dt-login-config.json
```

### 4. 运行快照静态验证

```bash
node <skill>/scripts/validate.mjs --spec login-spec.json --package dt-login-config.json
```

退出码 0 且状态为 `SNAPSHOT_STATIC_VALIDATED` 才表示通过。它分别检查 LoginSpec、包、两处 spec 深度相等和 Skill 会话门控；包合法不能替代内层声明合法。失败就修复并重跑，或改为 BLOCKED。

### 5. 运行离线行为验证

只使用虚构 inputs 和注入响应，不使用真实凭据。为可模拟策略至少准备业务成功和 HTTP 2xx + 业务拒绝两个夹具：

```bash
node <skill>/scripts/simulate.mjs --spec login-spec.json --fixture success.json
node <skill>/scripts/simulate.mjs --spec login-spec.json --fixture rejected.json
```

- `PASS` / 退出码 0：实际结果符合夹具。
- `FAIL` / 退出码 1：修复声明或夹具后重跑。
- `NOT_SIMULATED` / 退出码 2：列出未验证的页面边界，不改写成通过。

所有行为夹具通过才可报告 `OFFLINE_BEHAVIOR_PASSED`。业务拒绝必须断言零会话写入；无 default map 的 `CONFIG_INVALID` 是当前已知错误码限制，不称为理想 `LOGIN_REJECTED`。

### 6. 可选仓库复核

仅当用户提供 ShadeKit 根目录时运行；不自动安装依赖：

```bash
npm exec --prefix <repo> -- tsx <skill>/scripts/repo-verify.ts \
  --repo <repo> --spec login-spec.json --package dt-login-config.json
```

只有实际返回 `REPO_VERIFIED` 才能声称当前仓库复核通过。`NOT_RUN` 表示未复核；`FAILED` 或快照/官方差异必须如实报告，不能用快照结果覆盖官方失败。

## 隐私与副作用

包不得包含账号绑定、真实凭据/token、secret 变量或 `script`；`log.reveal` 不用于秘密。公开示例使用虚构地址和数据。内置验证/模拟不访问网络或 Chrome。真实登录、试登录、表单提交及真实会话写入均需另行明确授权，本技能不自动执行。

## 交付契约

证据充分且可表达时依次交付：

1. 完整 LoginSpec JSON；
2. 内嵌同一声明的完整策略包 JSON；
3. 证据、假设和来源路径；
4. 兼容 revision、实际命令及分项状态：`SNAPSHOT_STATIC_VALIDATED`、`OFFLINE_BEHAVIOR_PASSED` / `NOT_SIMULATED`、`REPO_VERIFIED` / `NOT_RUN` / `FAILED`；
5. 真实导入、真实会话、真实登录的 `NOT_RUN` 状态及其他未验证边界。

只有工具实际完成的结果才能声称通过。缺证据、能力不支持或必要验证失败时，以 **BLOCKED + 缺口 + 针对性问题** 替代完整双文件；未执行真实登录就不能写“登录成功”。
