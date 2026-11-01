# H0：扩展安全 spike 与共享契约基线

本目录是设计阶段 0 的一次性验证与交接材料，不是生产保险库、生产执行器或共享包实现。

## 契约文件

- `contract/h0.d.ts`：固定 `LoginRunInput`、`HostBridge`、`HostCapabilities`、`RunSpecOptions`、`RunSpecResult`、`HttpPort`、`PagePort`、`SessionPort`、可选 `ScriptPort`、公共面板/运行 DTO 及自有 Cookie/Storage DTO。
- `fixtures/error-codes.json`：固定 `SPEC_VERSION_UNSUPPORTED`、`OP_UNSUPPORTED`、`HOST_CAPABILITY_MISSING`、`VAULT_LOCKED`、`VAULT_UNAVAILABLE`、`BACKUP_AUTH_FAILED`。
- `fixtures/capabilities.json`：固定未知版本、未知算子、Desktop `script`、缺少 page/session 能力和 trial 不需要未使用 page 能力的预期。每个用例都要求副作用列表为空。
- `fixtures/http.json`：扩展与 Desktop 共用的请求、响应、错误和原始 `Set-Cookie` 输入。
- `fixtures/format-boundaries.json`：固定秘密引用为不透明字符串、`shadekit-vault/v1`、`shadekit-backup/v1`；密码学向量见 A2 产出的 [`H1.md`](./H1.md) 与 `fixtures/h1-security-vectors.json`。

`LoginRunInput` 只能在 Background 或 Desktop 受控运行层构造。公共 DTO 不包含秘密引用、密码、secret vars、完整策略库或 bindings。核心契约不包含扩展消息、扩展配置模型或页面标签数字标识。

## 能力预检顺序

1. 校验 spec/package 版本；不受支持的版本返回 `SPEC_VERSION_UNSUPPORTED`。
2. 静态遍历全部算子；引擎未知或宿主未声明的算子返回 `OP_UNSUPPORTED`。Desktop 不声明 `script`，因此包含它时明确拒绝。
3. 对实际要执行的算子检查 page/session/script 端口；端口缺失返回 `HOST_CAPABILITY_MISSING`。
4. trial 只检查 trial 允许集，不要求未使用的页面能力。
5. 上述检查全部先于导航、HTTP、Cookie/Storage 清理、会话写入或秘密发送，不允许跳过或猜测降级。

## HTTP 共同表示与边界

- 请求 DTO 包含完全构造好的 URL、method、headers、可选 body 和 timeout；核心不在 adapter 中重建请求。
- 成功响应包含 status、`finalUrl`、redirected、headers、UTF-8 `text` 和 `bodyBase64`。保留字节是为了让字符集差异可核对；当前扩展现有 `Response.text()` 语义按 UTF-8 解码，即使服务器声明 GBK。
- 超时统一为 `HTTP_TIMEOUT/timeout`。其他传输失败统一为 `HTTP_TRANSPORT_ERROR`；原因允许 `network`、`tls`、`unknown`。扩展 fetch 不能可靠区分网络与 TLS 错误，实测均返回 `unknown`，adapter 不得靠 URL scheme 猜测。
- Chrome/Edge 的扩展 fetch 实测不向 JavaScript 暴露 `Set-Cookie`；浏览器负责把 Cookie 写入当前上下文。Desktop 若由 Rust 发送请求，必须消费 fixture 中的原始行并回灌同一页面上下文，保留 domain/path、Secure、HttpOnly、SameSite 和过期语义。
- 回灌失败必须返回结构化错误，不能把 HTTP 成功当成完整登录成功。Rust 不得隐式维护另一份 Cookie Jar、自动换代理或忽略证书错误。
- 代理、客户端证书、CORS 和 TLS 实现差异不因共享 fixture 而消失；B0 必须记录实测差异。

## 密钥 spike 方法

`extension/` 是一次性 MV3 扩展：生成不可提取 AES-KW KEK 并存入 IndexedDB，只把 AES-KW 包装后的 DEK 存入扩展存储；不解包保存明文 DEK。探针验证 KEK/DEK 均不可导出、加解密回环、后台/浏览器重启后包装记录摘要不变，以及删除 KEK 后返回 `VAULT_UNAVAILABLE` 且无明文降级。

`run-cdp.mjs` 使用独立临时 profile，通过 CDP `Extensions.loadUnpacked` 装载扩展；当前品牌 Chrome 不允许 `--disable-extensions-except`，因此不使用该命令行路径。测试结束只删除自己的临时 profile，不连接或修改用户默认 profile。

`run-firefox.mjs` 使用 WebDriver BiDi `webExtension.install` 和独立临时 profile。Firefox 使用 MV3 event page：runner 在临时副本中声明 `background.scripts` 与固定 Gecko ID，由扩展自身打开探针页。关闭页面并不是后台重启的前提；探针保持打开，等待 95 秒让 event page 实际休眠，再通过消息唤醒，以新的 `INSTANCE_ID` 和不变的包装密钥摘要证明后台重启与密钥持久化。Firefox 159 要求只在该测试进程设置 `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` 才能求值扩展页面。

运行：

```bash
npx vitest run tests/login-h0-contract.test.ts
node docs/spikes/0021-login-security-h0/run-cdp.mjs chrome
node docs/spikes/0021-login-security-h0/run-cdp.mjs edge
node docs/spikes/0021-login-security-h0/run-firefox.mjs
```

## 实测证据

原始脱敏结果见 `evidence/chrome.json`、`evidence/edge.json` 与 `evidence/firefox.json`。

| 平台 | 浏览器 | 密钥持久化 | MV3 后台重启 | 浏览器重启 | HTTP/Set-Cookie | 密钥不可用 |
|---|---|---|---|---|---|---|
| macOS arm64 | Chrome 156.0.8078.76 | 通过 | 通过 | 通过 | 通过 | 通过 |
| macOS arm64 | Edge 156.0.4314.50 | 通过 | 通过 | 通过 | 通过 | 通过 |
| macOS arm64 | Firefox 159.0 | 通过 | 通过（event page） | 通过 | 通过 | 通过 |
| Windows | Chrome/Edge/Firefox | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 |

三端 HTTP 对照均覆盖重定向与最终 URL、UTF-8 解码、超时、网络错误、TLS 错误和两条 Set-Cookie 的浏览器上下文写入。Cookie 证据只保留名称和属性，不保留值。

## 交接与阻塞

- B0 必须原样消费 `fixtures/http.json`，并补充 Rust 的最终 URL、解码、错误原因及原始 Set-Cookie 回灌证据；不能用 Node shim 代替 Rust。
- A2 只能在 Firefox 的真实扩展环境完成同类密钥持久化与重启验证后启动生产保险库。若该平台确实不能持久化密钥，只能明确选择临时输入或可选主密码，禁止明文 DEK 降级。
- Firefox 159.0 的真实扩展证据已补齐，A2 的 Firefox 密钥 spike 硬阻塞已解除；这不代表其他 Firefox 版本或平台已经验证。
- Windows、其他 OS/架构未执行，不得写入已支持矩阵。
