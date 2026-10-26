# ADR-0014: 统一登录声明引擎 —— LoginSpec 取代宿主策略

- **日期**: 2026-10-22（由 `0007-api-login-suite.md` 草案合并重写；草案编号作废，0007 归还 Config Kit）
- **状态**: 已接受，待实施
- **背景**: 账号切换的登录能力由内置策略承载（旧内置 API 登录 / `generic`），经 `registerStrategy` 注册、`runAuthFlow` 按固定 6 阶段执行、`DomainsPanel` 按 `loginMethod` 动态渲染表单。ADR-0012/0013 已把 generic 改造为「配方 + 认证快照」，但配方只覆盖 DOM 操作，API 登录、加密、签名仍只能写宿主策略。原草案对迁移范围与数据模型的结论互斥，且发明了与 `AuthSpec` 并行的 `cookiePolicy`、与 `Recipe` 并行的 `LoginSpec`、四套占位符语法。本次经 29 项决策评审，收敛为**一份声明、一个执行器、一套词汇**。
- **范围**: `entrypoints/tools/account-switch/`（`types.ts`、`auth-flow.ts`、`login-session.ts`、`login-tab-flow.ts`、`background-handler.ts`、`strategies/*`、`utils/auth-*`、`utils/error-codes.ts`、`config/*`）；`entrypoints/shared/tool-config.ts`（配置包导入导出）；`docs/glossary.md`。不改其他工具。
- **关联**: ADR-0003（引擎收口 / D1 测试 seam 教训）、ADR-0004（D2 Login Session / D4 Navigation Intent / D5 统一日志）、ADR-0005（D5 随机数）、ADR-0006（不恢复插件市场）、ADR-0012（Recipe / AuthSpec / D7 写入顺序 / D15 配方不分发）、ADR-0013（拾取器与简易-高级视图投影）。
- **取代**: `docs/adr/0007-api-login-suite.md`（草案，已删除）。

---

## 术语（先定，正文不再解释）

| 词 | 含义 |
|---|---|
| **登录声明 `LoginSpec`** | 一次登录的完整、可序列化描述。唯一存储、唯一事实源。 |
| **算子 `op`** | `LoginSpec.ops[]` 的一项，可序列化、纯声明、由引擎执行。 |
| **内置 spec** | 以声明形式内置在仓库中的 spec，与用户配置同构。 |
| **配置包** | 跨环境/跨用户分发的 spec 载体，格式 `dt-login-config/v1`。 |
| **模板 `template`** | 新建 spec 的初始形态来源，即 `loginMethod` 的新语义；不参与执行。 |
| **成功信号** | 声明「怎样算登录成功」，见 D6。 |
| **认证声明 `AuthSpec`** | 会话的清理范围与写入目标，见 D5；读写分离。 |
| **配方 `Recipe`** | `LoginSpec.ops` 中 DOM 子集的**类型视图**，不是第二份数据。 |
| **`api-form`（旧名，已废弃）** | 原草案中「配置驱动的 API 策略」。统一后不存在该策略，一律称 `LoginSpec`。 |

---

## 决策清单

### D1. 引擎统一：一个执行器、一个存储

- **决策**: 删除 `LoginStrategy` 接口与 `registerStrategy` / `getStrategyDefinitions`。引擎只有 `runSpec(spec, ctx)`，按 `ops[]` 顺序执行。宿主策略与用户配置同为 `LoginSpec`，引擎不区分来源。内置 spec 放在 `strategies/builtin/*.spec.ts`，与用户配置走同一校验器与执行器。
- **被否决**: 保留接口做「向后兼容适配器」（原草案 II.7）。ADR-0006 已移除插件市场，生产路径上不存在跨接口的调用方；保留它会让 8 个测试继续跨一个生产中不存在的 seam——正是 ADR-0003 D1 记录的失败模式。
- **被否决**: 分两期（先新增 api-form 并存、再替换）。并存期需要同时维护两套模型与两套测试，且「是否替换」的结论会在文档里再次分裂。
- **后果**: `types.ts` 的 `AuthType`、`StrategyDefinition`、`LoginStrategy` 删除；`AuthStep` 枚举删除（阶段变成算子，见 D3）。开发者扩展口改为 D9 的算子注册（`registerLoginOp`），粒度是能力而非策略。

### D2. 一份数据、两个视图

- **决策**: `LoginSpec.ops` 是唯一存储。`Recipe` 退化为「DOM 算子子集」的类型视图：`RecipeStep` 与 DOM 算子一一对应，`runRecipe` 合并进 `runSpec`。`RecipeEditor` 继续读写该子集，不重写 UI。
- **被否决**: `LoginSpec.page` 嵌套 `Recipe`（两份数据、两个执行器，会让「一份声明」成为假话）；重写 `RecipeEditor`（64KB 组件与 4 个测试文件的成本与收益不成比例）。
- **后果**: 简易/高级模式的投影（ADR-0013 D9）改为对 `ops[]` 投影，`toSimpleForm` / `simpleShapeOf` 的形态判定需适配算子数组。`runRecipe` 的 `settle` / `limits` 语义并入 D7 的统一超时模型。

### D3. 有序算子数组，阶段即算子

- **决策**: 删除 `steps: AuthStep[]` 名字列表。原 6 阶段改写为算子：`clear.cookies` / `clear.storage` / `http.execute` / `auth.write` / `navigate`。顺序不变量改由**保存期校验**保证，不靠硬编码阶段顺序。
- **校验规则**（违反即 `CONFIG_INVALID`，保存与导入均拦截）:
  1. `auth.write` 必须位于**产生成功信号**的算子之后；
  2. 引用 `$x` 的算子必须位于产出 `x` 的算子之后（数据流可达性）；
  3. `navigate` 不得位于 `auth.write` 之前（除非 `auth.mode: "page"`）；
  4. 引用 `{name}` 的名称必须在输入命名空间中已声明（D4）。
- **被否决**: 固定五阶段 + 阶段内算子（同一份 spec 存在两套执行顺序来源，且 `page-handles` / 跨阶段跳转无法表达）；`steps` 与 `ops` 分工（同上）。
- **后果**: 调试轨迹统一为逐算子（`RecipeStepTrace` 升格为 `SpecOpTrace`，「第几步哪个目标失败」语义覆盖所有登录类型）。

### D4. 引用语法：两枚符号、两个转义

- **决策**:
  - `{name}` — 从**输入命名空间**取值：`username` / `password` / `origin` / `apiBase` / `nonce` / `timestamp` / `vars.*`。未声明即报错。
  - `$name` — 从**算子输出 / 运行时上下文**取值（如 `$pwd.enc`）。产出者不存在即报错。
  - 转义：`{{` → `{`，`}}` → `}`，`$$` → `$`。
  - **未解析引用 = 错误**：保存期 `CONFIG_INVALID`，运行期 `TEMPLATE_UNRESOLVED`。不再静默保留原样。
- **被否决**: 保留现有 `interpolate` 的「未命中保留原样」（`generic-steps.ts:146-153`）——那是一个已存在的静默失败点，与「token 路径取不到要报错」的原则相反；`{#something}` / `${#nonce}` 两套草案写法（D4 定案后无第三、第四种形式）。
- **后果**: 存量配方中拼错的占位符将从「原样发送」变为保存期报错。**这是行为收紧，须写进迁移说明**。
- **补充（实现细节）**: `nonce` / `timestamp` 由 spec 级 `aux` 声明（`source: "auto"`，nonce 用 `crypto.getRandomValues`），属输入命名空间而非算子；引用它们要求 `aux` 已声明（校验规则 4）。

### D5. 认证声明：读写分离的统一 `AuthSpec`

- **决策**: 删除 `cookiePolicy`（`write-cookie` / `storage-only` / `page-handles`）与顶层 `cookiesToClear`。统一为：

```jsonc
"auth": {
  "mode": "engine",              // engine | snapshot | page
  "cookiesClear": "all",         // all | none | string[]
  "localStorageClear": "all",    // all | none | string[]
  "sessionStorageClear": "none",
  "cookiesWrite": {              // mode=engine 时生效
    "name": "auth", "domain": null, "path": "/", "secure": "auto",
    "sameSite": "Lax",
    "expiresFrom": { "path": "data.expiredTime", "unit": "epochMs" }
  },
  "localStorageWrite": ["auth", "token"],
  "sessionStorageWrite": "none"
}
```

- `mode: "engine"` — 引擎按 `*Write` 声明写入；`auth.write` 算子执行它。
- `mode: "snapshot"` — 登录 origin 上捕获、目标 origin 恢复（保住 ADR-0012 D6/D7 的跨 origin 调试跳转）。
- `mode: "page"` — 引擎不写任何会话（原 `page-handles`）。
- **被否决**: 保留 `cookiePolicy` 三值（它把「谁写」与「写哪里」混在一个枚举里）；两套声明并存（清理用 `AuthSpec`、写入用 `cookiePolicy`）。
- **后果**: `auth.write` 不再以 `ctx.tokenData` 为前置条件——纯 cookie 登录（无 token）也能写入。现有 `afterLogin` 的 `ctx.tokenData` 前置条件（`auth-flow.ts:341-345`）同步删除，否则 `mode: "page"` 与无 token 登录会「登录成功但永不刷新」。
- **实现前提**: 现有 `setCookie` 只写 host-only、`path=/`、无 `sameSite`（`auth-storage.ts:52-83`），需按 `cookiesWrite` 参数化；`httpOnly` 无法由扩展设置，声明中出现即校验报错（诚实边界）。
- **说明**: 原决策为 `engine | page` 两值；此处扩展为三值以保住 ADR-0012 D6 的既有能力，读写分离的结论不变。

### D6. 成功信号：显式声明，至少一条

- **决策**: 删除「`parseLoginResult` 返回 null 即失败」的隐含规则。`spec.success` 至少声明一条，保存期校验：
  - `response.successPath` — 响应 JSON 路径为真（如 `data.success`）；
  - `response.tokenPath` — 路径取到非空值；
  - `settle` — 页面模式的结算条件（D7）。

  运行期：**所有已声明的信号都成立**才算成功；无 token 时 `auth.write` 正常执行。
- **被否决**: 「HTTP 200 即成功」（把路径写错变成静默成功）；「必须有 token」（纯 `Set-Cookie` 系统与 `mode: "page"` 不可用）。
- **后果**: 新增错误码 `SUCCESS_SIGNAL_UNMET`（声明了但未满足），与 `LOGIN_FAILED`（请求本身失败）区分。

### D7. 结算与超时

- **决策**: spec 级 `limits` 三类：`requestMs`（默认 15000）、`stepMs`（默认 5000）、`settleMs`（默认 10000，仅页面模式）。`navigate` / `page.goto` 算子自带 `timeoutMs`，不再单设 `pageLoadMs`。超时统一 `REQUEST_TIMEOUT`（HTTP）与 `STEP_TIMEOUT`（算子）。
- **被否决**: 单一全局超时（DOM 5s 与 HTTP 15s 的合理值差三倍）；保留三套并存默认值（`pageLoadMs` 与 `navigate.timeoutMs` 会长期同名不同义）。
- **后果**: 现有 `DEFAULT_REQUEST_TIMEOUT`（`fetch-timeout.ts:22`）继续作为 `requestMs` 默认值来源；`RecipeLimits` 三个字段合并为上述三类。

### D8. 加密与摘要：只内置核心算子，不做预设

- **决策**:
  - 第一批算子：`digest`（`sha1` / `sha256` / `md5`；输入编码 utf8/ascii/latin1；输出 hex/base64/base64url；大小写）、`crypto.encrypt`（`rsa-pkcs1v15` / `rsa-oaep`，公钥）、`payload.build`（连接规则与逐字段归一化）、`apply.set`（落 header / body / query）。
  - **不提供任何命名预设**（原草案的命名签名预设取消）。签名形态由用户按目标系统自行组合上述算子。
  - **`sign` 不是算子、也不是内置模板**，而是编辑器对「`payload.build` → `digest` → `apply.set`」的**四阶段折叠视图**：新建时展开成算子，编辑时可折回视图；存储始终是算子数组。算法白名单单点维护。
  - 字段归一化（trim / numericString / base64 变体 / upper / lower / 时间重排）落在 `payload.build` 的 per-part 上，不放进摘要层。
- **被否决**: 命名预设——在没有真实系统样本时会发明模板，且预设一旦发布就形成「改它会影响谁」的兼容包袱；`sign` 作为独立原子算子（算法与编码参数会与 `crypto` 各维护一份）；只做 `sign` 不暴露 `digest`（「先摘要再当字段拼进 body」无法表达）；第一批上 SM3/SM2（vendor 体积与真实用例都未确认）。
- **签名知识的交付渠道**: **生成 Skill**（问答式产出签名算子组合，用户维护到插件里），而不是内置预设。Skill 属本期范围外（见「明确不做」）。
- **后果（诚实记录）**: Skill 上线前，签名只能手工做四阶段编排，不提供站点专用预设。这是为「不发明模板」付出的体验成本，需在接入指南里明说。

### D9. 安全边界

- **决策**: 红线收敛为三条：
  1. **引用体系不允许逃逸到任意 JS**：D4 的两枚符号只能取声明过的值；无表达式求值。
  2. **`script` 是唯一任意代码算子，且本地专用**：用户可新建/编辑含 `script` 的本地 spec；**导出配置包时拒绝**并指明是第几步（不静默剥离）；**导入含 `script` 的包**报 `CONFIG_INVALID`。内置 spec 可含经人工审阅的 `script`。
  3. **v1 不引入秘密**：配置包与日志永不含秘密。不接受内联 `secret` / `key` 参数（HMAC / AES 等密钥类算子 v1 不提供），仅支持无密钥摘要与 RSA 公钥加密。`vars` 只允许非敏感值。
- **被否决**: 内联秘密 + 掩码（会产出「看起来安全、实际随导出泄露」的假保证）；建 secret store（当前唯一迁移目标只用公钥，属推测性建设）；禁止 `script`（会破坏存量本地配方）。
- **后果**: ADR-0012 D15「配方不分发」的实质保留：**分享载体不含代码**，而不是禁止一切代码。`generic-steps.ts` 中第二份 `new Function` 实现（约 627 行处）删除。
- **必改**: dev 模式日志目前原样记录请求头/请求体/完整响应并保留 30 天（`auth-flow.ts:229-261`、`shared/logger.ts` 配额），需按 spec 的 `vars` 声明与已知敏感键（`authorization` / `cookie` / `set-cookie` / `x-*-token`）做值级脱敏。

### D10. 令牌生命周期：只登录、不续期

- **决策**: 扩展负责「登录 → 按 D5 写入」。`refreshToken` 原样透传；expiry 的唯一用途是 cookie `expires`。过期后用户重新登录。`expiresFrom.unit` 显式声明（`epochMs` / `epochS` / `iso` / `relativeSeconds`，默认 `epochMs`），不做启发式猜测。
- **被否决**: 登录前 refresh-then-login（账号切换的语义是「以指定凭据建立新会话」，先复活旧会话在语义上就是错的）；后台监听 401 自动续期（超出工具职责，且需要额外权限与页面 hook）。
- **后果**: 旧 API 策略按 `new Date(epochMs)` 处理 expiry——该隐含约定迁移为 `unit: "epochMs"` 的显式声明。

### D11. 配置包

- **决策**:
  - 格式 `dt-login-config/v1`（与本地存储的 `CONFIG_VERSION`、spec 的 `version` 各自独立）。
  - `environments: [{ key, url, name }]` 可多个，导入时逐个创建 domain 并让用户勾选；账号绑定关系不进入配置包。
  - `requiredVars: [{ name, title, description, default? }]` 声明每环境需要用户填写的非敏感变量（如 `publicKey`），导入时提示填写；`secret: true` 在 v1 直接拒绝。
  - 版本：`spec.version` 增加时实现 `migrateSpec(v) → v+1` 顺序迁移链（纯函数、可单测）；导入时 `spec.version > CURRENT` **明确拒绝**，提示「配置包比你当前的扩展新」。
- **被否决**: `matches` 单值 + 导入三次（与「dev/test/prod 共享一份配置」的动机不符）；`origins: string[]`（只解决 URL，不解决环境名与每环境不同的 `apiBase`）；复用 `CONFIG_VERSION` 做包版本（导入他人的包与升级自己的配置会互相卡版本）。
- **后果**: 原草案的 `hostPermissions` 注入删除——manifest 已声明 `http://*/*` + `https://*/*`（`wxt.config.ts:36`），没有增量权限可请求。
- **边界**: 现有「导出配置」按钮导出的是**整个账号切换配置**（含明文账号密码，`Config.vue:422-430`），与配置包是两条入口，不得混用；配置包导出单独的 spec 载体。

### D12. 试登录

- **决策**: 经消息在 **background SW** 执行（复用 `runSpec` 的单算子模式），默认只跑 `http.execute` + 成功信号解析，**不执行 `auth.write`、不执行 `navigate`**、不接触用户当前 tab。用户显式勾选「写入会话」才执行至 `auth.write`。
- **被否决**: options 页直接 fetch（那里没有 SW 的特权语义，CORS 与 cookie 行为不同，测的是一个生产中不存在的环境）；在目标站点 tab 内注入执行（会覆盖用户现有登录态）。
- **后果**: 文案必须区分「能换到凭据」与「已登录」；默认不产生任何副作用，可对生产环境安全执行。

### D13. `loginMethod` 与 UI

- **决策**:
  - `loginMethod` 降为**模板 id**：仅用于新建时生成初始 spec 与日志可读性，保存后**以 `strategyConfig.spec` 为准**，引擎不再按它分派。
  - 单一 spec 编辑器、三层视图：简易（标准 DOM 登录三步，投影自 `ops[]`）/ 高级（算子列表增删排序）/ 原始 JSON（含校验）。关闭 `SettingDefinition` 动态表单路径；`StrategyDefinition` 仅保留模板元数据。
  - **例外**：`debugRedirect` / `defaultPassword` / `cookieClearIncludeParent` 属环境管理字段，不进 spec，继续用现有 Setting Item 表单渲染。
- **被否决**: 删除 `loginMethod`（需同时改日志、迁移与 7 处 UI 分支，且 `DebugLogEntry.domain.loginMethod` 会失去可读语义）；保留为执行分派键（与「引擎不区分宿主与用户配置」矛盾）；全部字段 JSON 化（改一个调试跳转地址也要开 JSON）。
- **后果**: `DomainsPanel.vue` 现有 7 处 `loginMethod` 分支（155/235/251/278/411/485/591）收敛为一个 spec 编辑器挂载点；`loginMethod` 的类型注释必须写死新语义，防止后人再拿它做分派。

### D14. 迁移与验收

- **迁移映射**:

| 现状 | 目标 |
|---|---|
| 旧 API 登录宿主类 | 内置声明（含 RSA、签名、语言读取、redirect 解析） |
| `generic` 的 `strategyConfig.recipe` | 原字段就地升级为 `strategyConfig.spec`（DOM 算子 + `auth` 声明） |
| 旧 8 个扁平 `strategyParams` | 仍由 `migrateLegacyParams` 先上转 recipe，再并入 spec |
| `strategyParams`（按环境覆写） | `spec.vars`（非敏感键值），引用形式 `{key}` |
| `apiBase === origin` 时自动补站点专用路径 | 删除隐式规则；路径写进对应声明，`resolvePostLoginUrl` 的 `/api` 回退删除 |
| `AuthSpec.mode: "page" \| "snapshot"` | 保留并新增 `engine`（D5） |

- **验收（金标准）**: 测试上下文注入固定 nonce/timestamp，断言迁移声明的请求 URL / headers / body 与宿主版 **byte 级一致**，`parseLoginResult` 与 `auth.write` 产物一致。前提是把旧策略的 `Math.random()` 改为 `crypto.getRandomValues`（同时满足 ADR-0005 D5）。
- **被否决**: 只要求「语义一致」（无法防止签名拼接顺序这类回归，而那正是签名失败的主要来源）。
- **不回归**: `npm run check` + 既有测试同 PR 保绿。

---

## 后果

- **收益**: 登录只剩一种形态；API 登录、加密、签名、DOM 流程共享同一个执行器与同一套校验、日志、错误码；站点登录从不可配置的宿主代码变成可参考、可复制、可 diff 的声明；用户可通过配置包接入新系统而无需改码。
- **成本**: 一次不可拆的引擎替换；8 个测试文件改到新 seam；`DomainsPanel` 的策略表单分支与 `RecipeEditor` 的模式投影都要适配算子数组。
- **风险**: D4 的未解析引用报错会让存量配方中拼错的占位符从「静默原样发送」变为保存期失败——需在迁移说明中点明，并在 UI 上把错误定位到具体算子。

## 明确不做（本期）

- OAuth / OIDC / 开放平台授权码流程、`chrome.identity`、IdP 回调与 state/PKCE。**没有真实目标系统时不做推测性设计。**
- 生成 Skill（问答驱动生成器，含签名算子组合的生成与入库）与开源准备（脱敏审计、接入指南重写）。它们与引擎统一无依赖，另行排期；在它落地前**不提供任何内置签名预设**（D8）。
- 秘密管理（secret store）、HMAC / AES 等密钥类算子、SM3 / SM2 国密。
- 令牌续期与后台 401 刷新（D10）。
- 录制回放器、插件市场（ADR-0006）、`chrome.debugger` / CDP。

## 验证

**删除**

- `tests/stateless-login-strategies.test.ts` — 跨的是已删除的 `LoginStrategy` 接口。
- `tests/generic-steps.test.ts` + `strategies/generic-steps.ts` 的步骤引擎部分 — 这是第二套已死的 6 阶段执行器（生产仅 `interpolate` 被引用），其测试是该 seam 的唯一调用方。`interpolate` 迁入模板模块后由新测试覆盖。

**改写（到 spec 执行器 seam）**

- `auth-flow` / `login-tab-flow` / `login-session` / `generic-runner` / `generic-strategy` / `generic-recipe` / 旧 API 登录测试

**新增**

- spec 校验器：D3 四条顺序/数据流规则、D6 至少一条成功信号；
- 迁移链：`migrateSpec` 逐版本、行为等价（含旧 recipe → spec）；
- 模板解析：`{name}` / `$name` / `{{` `}}` `$$` / 未解析报错；
- 认证声明：`engine` 写入参数化、`snapshot` 捕获恢复、`page` 不写；无 token 登录仍导航（D5 后果）；
- 试登录：默认零副作用（断言未调用 `auth.write` / `navigate` / `tabs.*`）；
- 配置包：导入拒绝含 `script` 的包、拒绝高版本 spec、`secret: true` 的 `requiredVars`；
- 旧 API 登录声明的金标准 byte 级对比（D14）。

**保持不动**: 其余全部既有测试（cookie 清理范围、tab 回滚、错误码、日志裁剪等）必须原样保绿，不得为迁就让断言失效。

---

## 附录 A. 能力覆盖与边界

| 形态 | 覆盖方式 | 备注 |
|---|---|---|
| 纯 JSON API 登录（token） | `http.execute` + `success.response.tokenPath` | 主路径 |
| 纯 cookie API 登录（无 token） | `http.execute` + `success.response.successPath` + `auth.mode: engine` | D6 修好的场景 |
| 请求体加密 / 签名 | `crypto.encrypt` / `payload.build` + `digest` + `apply.set` | 公钥与无密钥摘要 |
| 页面表单登录 | DOM 算子（`page.goto` / `fill` / `click` / `waitFor`）+ `settle` | 原 `generic` |
| 页面读取前置值 | `extract`（storage / session / dom / url / cookie，`parse: raw \| jsonValue`） | 原草案的 `page.read` 取消：`extract` 已覆盖，缺的是「有序」而非「原语」 |
| 跨 origin 调试跳转 | `auth.mode: "snapshot"` + `navigate` | ADR-0012 D6/D7 |
| 无 token 且页面自管会话 | `auth.mode: "page"` | |

**不支持**: 公私钥交换 / 多轮手签 / 双向认证（只能写自定义算子）；验证码与人工多因子（`CAPTCHA_REQUIRED`）；跨域第三方 Set-Cookie（降级为页面模式或 DOM 流程）；非 http(s) origin。

## 附录 B. 实施前必须修正的既有事实

| # | 事实 | 位置 |
|---|---|---|
| F1 | `hostPermissions` 注入是空操作（manifest 已是全量 http/https） | `wxt.config.ts:36` |
| F2 | 「导出配置」含明文账号密码；导入整体覆盖 accounts/domains | `Config.vue:422-430, 461-469` |
| F3 | dev 日志落盘请求头/体/完整响应，保留 30 天 / 1MB | `auth-flow.ts:229-261`、`shared/logger.ts` |
| F4 | 旧 API 策略的 nonce 用 `Math.random()` | 旧策略随机数生成处 |
| F5 | 四套占位写法；`interpolate` 未命中保留原样 | `generic-steps.ts:142-153` |
| F6 | `script` 是 MAIN world `new Function`，`allFrames` 取首个成功结果；另有一份重复实现 | `generic-runner.ts:376-401`、`generic-steps.ts:627` |
| F7 | `extract` 已能取 storage/dom/url，`page.read` 缺口不成立 | `generic-runner.ts:247-264` |
| F8 | `afterLogin` 有 `tokenData` 前置，纯 cookie 登录不会导航/刷新 | `auth-flow.ts:341-345` |
| F9 | 旧 API 策略在 UI 中 DEV_ONLY，默认 `loginMethod` 为 `generic`；但已存 domain 仍在用它 | `DomainsPanel.vue` |
| F10 | `setCookie` 仅 host-only、无 `domain` / `sameSite` 参数 | `auth-storage.ts:52-83` |
| F11 | `generic-steps.ts` 的步骤引擎已是死代码，仅 `interpolate` 在生产被引用 | `strategies/generic.ts:28` |

## 后续修订（2026-10-26）：自动定位仍属 LoginSpec

- 自动、锁定和手动定位继续由同一份 `LoginSpec.ops` 表达，不新增定位存储或第二执行路径。版本保持 2，配置包格式不变。
- `runSpec` 在首个自动算子前把整组 auto 解析成具体 Target + FrameScope，后续仍逐步调用既有 `runDomAction`；trace 记录实际 Target 与 `resolution`，不记录填充值。
- 历史空 Target 仅对完整原版默认模板做只读兼容，不把任意三空步骤猜成自动。
