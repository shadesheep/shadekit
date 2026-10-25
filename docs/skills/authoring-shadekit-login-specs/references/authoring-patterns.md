# 登录声明编写模式

## 证据矩阵

| 必须回答的问题 | 可接受证据 |
|---|---|
| 请求按什么顺序发生？ | 认证客户端调用链、HAR、服务契约 |
| 字段/header 如何生成？ | 请求构造代码、HAR 与签名/编码实现 |
| CSRF/nonce/挑战值从哪里来？ | 页面提取、前置请求或引擎 aux 的明确对应 |
| 业务成功和失败分别是什么？ | 响应分支代码、服务端测试、成功与失败样例 |
| 会话由谁建立、写到哪里？ | 应用读取位置、Set-Cookie 证据、页面表单/HttpOnly 行为 |

HTTP 200、响应存在 token、接口名称包含 login 都不是完整证据。缺少关键行时提出针对性问题，不扫描其他目录或猜测。

## API + engine 会话

适用于请求、成功条件和 Cookie/Storage 效果都能由 LoginSpec 表达的流程。

1. 用 extract/default、payload.build、digest、crypto.encrypt、map、apply.set 构造请求。
2. 用业务代码证明的 response.equals 作为成功信号。
3. 在 auth.write 前以无 default map 仅放行成功响应。
4. 所有会话值和 expiry 从门控绑定或其派生绑定读取。
5. 保留 response 成功信号；不要把它理解为会在算子前提前阻断。
6. 用成功与 2xx 业务拒绝夹具验证，拒绝时 Cookie/Storage 都为零。

如果响应失败也带 token，直接 `$login.data.token` 会污染会话。复杂 AND/anyOf 条件、无法证明 map 覆盖成功条件时，当前 Skill lint 会 fail closed，应 BLOCKED 而不是绕过。

## 页面自管会话

适用于表单提交、HttpOnly Cookie、渲染页挑战或服务端 Cookie Jar 管理的登录。

- 使用最小 `goto` / `fill` / `click` / `waitFor`。
- 使用 `auth.mode: "page"`，不伪造 engine Cookie/Storage 写入。
- 用页面证据选择 formGone、urlChanged、url、selector、cookie 或 storage 成功条件。
- 页面 URL glob 不写 `{origin}` 模板。
- 内置静态验证可运行；浏览器行为必须标记 `NOT_SIMULATED`，真实登录仍 `NOT_RUN`。

## CSRF、签名与变量

- 页面已有挑战值才用 extract；前置 API 提供时才增加有证据的 http.execute。
- nonce/timestamp 只有引擎语义与服务契约一致时才声明 aux。
- 非敏感配置放 vars；默认值只用于非敏感且确实可选的配置。
- secret 变量和 script 不能进入分享包。需要它们且无法改用可分发声明时 BLOCKED。

## BLOCKED 条件

- MFA、验证码或人工挑战无法声明。
- 签名/加密算法不受支持，或证据不足以重放。
- 必须读取 http.execute 不暴露的响应头，或依赖通用 Cookie Jar。
- 页面行为不可表达，或会话效果无法确定。
- 必须依赖 script 才能工作。
- 业务成功无法形成安全会话门控。
- 关键请求、成功或会话证据缺失。

输出 `BLOCKED`、具体缺口和能解除该缺口的一个问题；不要交付伪完整双文件。
