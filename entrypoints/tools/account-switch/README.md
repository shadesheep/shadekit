# Account Switch 账号切换系统

## 1. 系统概述

Account Switch 是 ShadeKit 浏览器扩展的核心工具，提供两种登录模式：

| 模式 | 入口 | 说明 |
|------|------|------|
| **选择账号登录** | Popup 面板 / Content Script 快捷键面板 (`Alt+Shift+A`) | 从预配置的账号池中选择账号，执行切换 |
| **快捷登录** | Popup 快捷登录 Tab / 快捷键选中文字 / 右键菜单「快捷登录」 | 粘贴/选中测试信息文本，自动解析并登录 |

---

## 2. 核心数据结构

### 2.1 账号配置 (Account)

```typescript
interface Account {
  id: string;          // 唯一标识 acc_<timestamp>
  name: string;        // 显示名称，如 "招标人-张三"
  username: string;    // 登录用户名
  password: string;    // 登录密码（明文存储在 chrome.storage.local）
  roles: string[];     // 角色标签: 管理员/普通用户/访客（支持自定义）
  domains: string[];   // 关联的环境 URL 列表
}
```

### 2.2 环境配置 (DomainConfig)

```typescript
interface DomainConfig {
  name: string;               // 环境名称: "本地开发", "测试环境" 等
  tags: string[];             // 环境标签: local/dev/test/staging/prod
  loginMethod?: string;       // 仅作 SpecTemplate.id：新建环境时的默认声明 + 日志名称
  debugRedirect?: string;     // Bug 复现地址：登录成功后自动进入的页面
  debugRedirectEnabled?: boolean;  // 「登录后自动进入」开关默认值
  defaultPassword?: string;   // 快进登录默认密码
  cookieClearIncludeParent?: boolean; // 清 Cookie 是否含父域（默认仅精确 host）
  strategyConfig?: {          // 结构化登录配置（ADR-0012 D2）
    spec?: LoginSpec;         // 登录声明 v2：唯一执行依据
    recipe?: Recipe;          // 旧配方（v1）：读取时经迁移链升到 v2
  };
  strategyParams?: Record<string, unknown>; // 旧扁平参数（读取时迁移，只写不读）
  /** @deprecated 使用 strategyParams.publicKey */
  publicKey?: string;
}
```

`loginMethod` **不参与执行分派**：执行始终认 `strategyConfig.spec`（旧版为
`recipe`，读取时自动迁移）。它只在「新建环境」时决定默认声明、以及日志里
显示人类可读名称。

### 2.3 Token 数据 (TokenData)

```typescript
interface TokenData {
  token: string;        // 访问令牌
  refreshToken: string; // 刷新令牌
  expiredTime: number;  // 过期时间 (ISO 时间戳)
  currentTime: number;  // 服务器当前时间
}
```

---

## 3. 登录声明体系（LoginSpec）

### 3.1 单一执行器

自 issue 12 起，登录只有**一条执行路径**：环境上保存的 `LoginSpec` 交给
`spec/run.ts` 的 `runSpec()` 执行。旧的策略接口 / 注册表 / 六阶段管线 / 第二套
步骤引擎已全部删除——仓库里只剩一个执行器、一套算子词汇、一份可序列化声明。

```typescript
interface LoginSpec {
  version: 2;
  template?: string;              // 模板名（新建/日志可读性；不参与分派）
  vars?: Array<{ name; title?; default? }>;  // 用户可覆盖的输入（如 publicKey）
  aux?: { nonce?: "auto"; timestamp?: "auto" }; // 引擎生成的辅助输入
  ops: SpecOp[];                  // 算子序列（见下表）
  success: SuccessSignal[];       // 成功信号（数据信号 / 页面条件，anyOf 语义）
  failure?: FailureSignal[];      // 失败优先：命中即早退
  auth: AuthSpec;                 // 会话范围声明（cookies/storage 清理与写入）
  limits?: { requestMs?; stepMs?; settleMs? };
  log?: { reveal?: string[] };    // 进日志的白名单（黑名单仍优先）
}
```

### 3.2 算子（17 个）

| 类别 | 算子 | 说明 |
|------|------|------|
| 会话清理 | `clear.cookies` / `clear.storage` | 按 `AuthRange`（`all` / 键名数组）清理 |
| 导航 | `goto` | 跳转、等待加载及可选 `waitForTarget` 表单就绪确认；`when` 为假时跳过 |
| HTTP | `http.execute` | 请求 + 解析；`expectStatus` 判定；结果进绑定表 |
| 数据变换 | `digest` / `crypto.encrypt` / `payload.build` / `map` / `apply.set` | SHA-1/256、RSA、拼装（对象/字符串）、映射、改写请求 |
| 会话写入 | `auth.write` / `auth.capture` / `auth.restore` | 按 `auth` 声明写会话、跨 origin 捕获/恢复 |
| DOM 子集 | `fill` / `click` / `waitFor` / `extract` | 复用既有 Target / SettleCondition 类型 |
| 脚本 | `script` | 逃生舱；分享/导入时会被明确标为不可序列化风险 |

模板字符串支持 `{name}`（输入 / vars / 账号 / `{origin}` 等内置）与
`$binding`（前序算子产出）；**未解析即错误**，不再保留旧插值的「原样保留」。

### 3.3 内置声明与自定义策略

`generic` 是唯一的内置声明（`spec/editor.ts` 的 `defaultLoginSpec`），覆盖
通用页面登录。API 请求、摘要、RSA 加密和会话写入由声明中的通用算子组合，
不包含特定站点的登录端点或密钥。

自动识别或锁定标准登录表单时，会同时记录实际标签页的登录页地址；同域地址
保存为 `{origin}/...`，并在前导 `clear.*` 后生成 `goto(waitForLoad: true)`。
扫描只枚举 localStorage / sessionStorage 键名，用户在确认卡片中勾选高置信度认证键，
生成精准的 `clear.storage`，不读取键值也不默认清空全部存储。`waitForTarget` 会在
导航后等待实际用户名输入框出现，避免 SPA 渲染与旧登录态重定向竞态。
高级多步声明不被识别回填隐式重排；明确留空登录页的简易声明仍保留当前页 / SPA 用法，并显示软提示。

其他系统由用户通过「导入登录策略包…」导入 `dt-login-config/v1`，存入
**登录策略库**（ADR-0019）。公开仓库只提供通用格式与虚构示例；导入格式和
本地策略包约定见 `docs/login-specs/`。

### 3.4 登录策略库与动态策略（ADR-0019）

登录方式下拉 = **内置通用登录** + **策略库条目** + 未入库的存量环境声明
（`spec/strategy-presets.ts`）：

- **策略库**：`AccountSwitchConfig.strategies`（`id → { name, spec }`）。
  导入策略包**默认只入库、不产生环境**；需要时再勾选「同时创建环境」。
  策略库卡片在设置页，可编辑 / 重置镜像 / 删除；
- **关联**：环境选中库条目时写 `DomainConfig.strategyId`，默认实时镜像库条目。
  在环境中另存私有声明后才脱离镜像；解绑只摘 `strategyId`，保留私有声明，
  删除库条目会解除所有绑定——**都不增减环境记录**；
- **编辑与重置镜像**：编辑库条目即时影响镜像环境；「重置镜像」清除环境的
  私有声明，使其重新跟随库版本；
- **环境级变量覆盖**：`DomainConfig.vars` 优先于 `spec.vars[].default`，
  同一份共享策略绑多个环境时差异放这里；配置包 `requiredVars` 的填值也落在这里；
- 名称取 `spec.template`，取不到用库条目名 / 环境名，再退化为「自定义登录」；
- 同名 / 同内容的声明只保留一条；同内容重复导入幂等复用。

`loginMethod` 只承担显示名与新建默认模板，执行由读取链解析库镜像或环境私有声明。

> 升级提示：旧环境若只存了已移除的内置登录标识而没有内联声明，不再回退到
> 代码内声明；请导入对应登录策略包，或重新配置通用登录。

> 零迁移（ADR-0019）：存量环境的内联声明不会被自动搬进策略库；需要复用时，
> 在环境编辑页点「存入策略库」。

### 3.5 通用登录与旧配方（Recipe）

`generic` 声明通常由旧配方迁移而来。配方仍作为 v1 数据存在于
`DomainConfig.strategyConfig.recipe`，读取时由 `spec/migrate.ts` 升到 v2；
编辑器保存时只写 `spec`。

| 模块 | 职责 |
|------|------|
| `spec/types.ts` | 数据模型 / 算子判别联合 / 默认值常量（零浏览器 API） |
| `spec/validate.ts` | 保存期静态校验 R1–R7（未解析模板、绑定顺序、算子白名单…） |
| `spec/migrate.ts` | v1 recipe / 旧扁平 `strategyParams` → v2 登录声明 |
| `spec/run.ts` | `runSpec()`：唯一执行器（算子编排、轨迹、成功/失败信号） |
| `spec/auto-login.ts` | 自动 Target、标准形状、旧默认精确投影与无损锁定 |
| `strategies/login-form-scan.ts` | 手动识别与运行时共用的只读扫描、唯一解析 |
| `login-form-lock.ts` | 新建保存的 1500ms 只读准备与后台条件回写 |
| `spec/login-run.ts` | 生产接线：`runSpec` + 调试缓冲 + 会话日志信封 |
| `spec/trial.ts` | 试登录：默认零副作用，仅 `writeSession` 时执行 `auth.write` |
| `spec/strategy-presets.ts` | 登录方式下拉：内置 generic + 策略库条目 + 未入库的存量环境声明（纯函数） |
| `spec/strategy-library.ts` | 登录策略库：入库 / 绑定 / 解绑 / 同步 / 删除（ADR-0019，纯函数） |
| `config/StrategyLibrary.vue` | 设置页策略卡：列表、编辑、同步到关联环境、删除 |
| `spec/package.ts` / `spec/editor.ts` | 分享包（`dt-login-config/v1`）导入导出 / 编辑器模型 |
| `strategies/generic-recipe.ts` | DOM 子集类型（`Target` / `FrameScope` / `SettleCondition`）与旧配方模型 |
| `strategies/generic-dom.ts` | 跨 frame DOM 动作（`allFrames: true`，含 shadow root 深查询） |
| `strategies/generic-target.ts` | `Target` → 页面内定位，多命中报歧义 |
| `strategies/generic-settle.ts` | 成功判定 / 失败判定轮询（失败优先） |
| `strategies/generic-runner.ts` | 仅保留 `interpolateTemplate`（旧配方单步试跑用） |
| `strategies/generic-dry-run.ts` | 旧配方试跑（步骤白名单，不点击/不跑脚本） |
| `utils/auth-snapshot.ts` | 快照 capture / clear / restore（跨 origin Bug 复现跳转） |
| `utils/host-cookies.ts` | 按 host（可选含父域）清理 cookie |
| `config/SpecEditor.vue` + `config/spec-editor-model.ts` | 登录声明编辑器（算子增删排序、行内校验、试跑） |
| `config/RecipeEditor.vue` + `config/recipe-editor-model.ts` | 旧配方编辑器（迁移入口，新建环境默认使用声明） |
| `config/TargetField.vue` | 定位输入组件：kind + 拾取 + 候选胶囊 + 命中提示 |
| `config/login-form-scan.ts` | 一键识别登录表单 `scanLoginForm`（只读，跨 frame 归并） |
| `config/volatile-id.ts` | 框架自动生成 id 的判定，候选与 CSS 路径都跳过它们 |

**文本定位口径**：`{ text }` 比较前去掉全部空白（`登 录` ↔ `登录`），并**精确优先**——有可见的完全相等命中就只用它，没有（或精确命中全部不可见）才退回子串包含。这样「密码登录 / CA登录 / 短信登录 + 登录按钮」这类页面不会因页签抢命中而报歧义。执行器 `byText` 与拾取器 / 识别器的命中计数必须同口径，否则候选胶囊的「命中 N 个」会与实际执行错位。

**定位稳定性**：候选排序虽以 `id` 为先，但**自动生成的 id 不参与**——Element Plus / React / Radix 等按全局计数器渲染的 id 刷新即变，写进配方执行时必然 `ELEMENT_NOT_FOUND`。`cssPathOf` / `pathOf` 同样不拿它当锚点，改由 `nth-of-type` 保证唯一。已保存的配方若写了这类 id，编辑器会在对应行提示重新拾取（不拦截保存）。

**存放位置**：`DomainConfig.strategyConfig.spec`（v2）。旧的 8 个扁平 `strategyParams`（`loginPageUrl` / `usernameSelector` / …）与 v1 `recipe` 经迁移链单向上转；新配置只写 spec。

**失败可见化**：`runSpec` 产出逐算子轨迹（序号 / 算子 / 目标 / 状态 / 耗时 / 错误码），随失败结果进入日志与「复制详情」；dev 模式下每一步的开始 / 结束事件实时落入 `auth` 类别日志。

**试跑**：配方编辑器的「试跑当前 tab」经 `TEST_RECIPE` 消息执行，只跑导航 / 填充 / 等待，点击与脚本被拒绝，逐行回填命中状态；试登录（`TRIAL_LOGIN`）则在后台按 spec 跑一次真实请求，默认不写会话。

**帧收敛**：拾取器只在子 frame 记录 `frameUrl`（主 frame 的身份由 tab 保证）；执行器匹配顺序为 `frameId` → `origin + pathname`，SPA 路由或 query 变化不再误报 `FRAME_NOT_FOUND`，两者都不命中仍报错、不静默回退。

**验证码识别**：`/验证码|captcha|slider/i` 扫描**可见叶子文本**，排除可点击入口（tab / 按钮 / `cursor:pointer`）与隐藏面板。命中 → `CAPTCHA_REQUIRED`。

**自动定位与可选锁定**：默认标准三步使用 `{ auto: "login" }`，登录时由 `runSpec` 复用同一扫描器解析，无需先打开高级配置。只有同 frame 三项齐全且 Target 全唯一才执行；同 frame 多表单、多 frame、缺项或歧义均不猜测。首个自动算子前 `noPassword` 最多刷新重试一次，运行结果只存于本次 `RunState`。

环境 URL 下的「识别并锁定登录表单」是可选优化；新建保存先在 1500ms 内只读准备，基础保存成功后才由后台重读配置、重扫页面并条件回写当前环境。镜像只脱镜当前环境，不改策略库或其它镜像。trace 以 `auto → Target` / `resolution` 记录来源，不记录填充值、Cookie 或 token。

---

## 4. 支持的场景

### 4.1 选择账号登录

| # | 场景 | 触发方式 | 行为 |
|---|------|----------|------|
| 1 | 点击扩展图标打开 Popup | 点击浏览器扩展图标 | 打开 Popup.vue，展示账号列表 |
| 2 | 快捷键打开 Content Script 面板 | `Alt+Shift+A` (无选中文本) | 在页面内注入浮动面板 SwitcherPanel.vue |
| 3 | 内容脚本面板点击账号 | 点击账号卡片 | 向 background 发送 `SWITCH_ACCOUNT` 消息 |
| 4 | Popup 面板点击账号 | 点击账号卡片 | 向 background 发送 `SWITCH_ACCOUNT` 消息 |
| 5 | 最近使用 | 自动记录 | 最近使用过的账号置顶（最多 20 条） |
| 6 | 搜索过滤 | 输入关键词 | 按名称/用户名搜索 |
| 7 | 角色筛选 | 点击角色 Chip | 按角色过滤账号列表 |
| 8 | 键盘导航 | `↑/↓` 选择 + `Enter` 确认 | 全键盘操作 |

### 4.2 快捷登录

| # | 场景 | 触发方式 | 行为 |
|---|------|----------|------|
| 1 | Popup 快捷登录 Tab | 粘贴文本 + 点击「登录并跳转」/ `Ctrl+Enter` | 解析文本，执行登录并跳转 |
| 2 | Content Script 快捷登录 Tab | 粘贴文本 + 点击「登录并跳转」/ `Ctrl+Enter` | 同上（快捷键面板中） |
| 3 | 快捷键选中文字 | `Alt+Shift+A` (有选中文本) | 解析选中文本，新标签页快捷登录 |
| 4 | 右键菜单快捷登录 | 选中文本 → 右键 → 「快捷登录」 | 同上，新标签页快捷登录 |
| 5 | Bug 复现跳转 | 文本含 URL 且环境配置了 `debugRedirect` | 登录成功后自动进入反馈的 Bug 页面 |
| 6 | 无 URL 模式 | 文本不含 URL + 配置了 `quickLoginDefaultDomain` | 使用默认域名作为目标 |
| 7 | 默认密码快进 | 文本含 URL + 账号（无密码）+ 环境配置了 `defaultPassword` | 自动填充环境的默认密码执行登录 |

### 4.3 快捷登录支持的文本格式

| 格式示例 | 说明 |
|----------|------|
| `http://example.com\nadmin/123456` | URL 换行 账号/密码 |
| `http://example.com admin:123456` | 空格分隔 URL 和 账号:密码 |
| `admin/123456` | 纯 账号/密码（无 URL，使用默认域名） |
| `admin 123456` | 空格分隔 账号 密码 |
| `admin\n123456` | 两行：账号 \n 密码 |
| `admin\n123456\nhttp://example.com` | 凭证在前 URL 在后 |
| `localhost:8888\nadmin/123456` | 无协议 URL |
| `http://example.com\nadmin` | URL + 账号（使用环境默认密码） |
| `http://example.com admin` | 空格分隔 URL + 账号（使用环境默认密码） |

分隔符支持：`/`、`:`、空白字符。密码可包含空格。

### 4.4 快捷登录密码优先级

快捷登录支持三种输入场景，密码来源按以下优先级自动填充：

| # | 场景 | URL | 账号 | 密码 | 密码来源 |
|---|------|-----|------|------|----------|
| 1 | 完整信息 | 存在 | 存在 | 存在 | 直接使用文本中的密码 |
| 2 | URL + 账号 | 存在 | 存在 | 不存在 | ① URL 匹配环境的 `defaultPassword` → ② 全局默认密码 |
| 3 | 纯账号 | 不存在 | 存在 | 存在 | ① 当前 Tab URL 匹配环境的 `defaultPassword` → ② 全局默认密码 |

**场景 1 — 完整信息**
- 输入格式如 `http://example.com\nadmin/123456`
- 直接使用解析出的密码，不走默认密码查找

**场景 2 — URL + 账号（无密码）**
- 输入格式如 `http://example.com\nadmin`
- 通过 `matchDomain` 匹配 URL 对应的环境配置
- 优先使用匹配环境的 `defaultPassword`，未配置则 fallback 到全局默认密码
- 两者都为空时提示错误

**场景 3 — 纯账号（无 URL）**
- 输入格式如 `admin/123456`
- 使用当前 Tab 页面的 URL 匹配环境配置
- 优先使用当前页面环境的 `defaultPassword`，未匹配或未配置则 fallback 到全局默认密码
- 两者都为空时提示错误

> 实现位置：`SwitcherPanel.vue` `handleQuickLogin()` 中的密码解析逻辑（约 L281-L295）

```typescript
// 密码优先级：用户输入 > 环境 defaultPassword > 全局默认密码
const password = parsed.password || envPassword || globalDefaultPassword.value || undefined;
```

---

## 5. 完整请求流程

### 5.1 选择账号登录流程 (SWITCH_ACCOUNT)

```
用户点击账号卡片
    │
    ▼
[Popup.vue / SwitcherPanel.vue]
    │ sendBgMessage('SWITCH_ACCOUNT', { account, domain })（类型化协议，见 shared/messages.ts）
    ▼
[background.ts] → 路由到 account-switch background handler
    │
    ▼
[background-handler.ts] handleSwitchAccount(account, origin, sender)
    │
    ├── 1. prepareLogin()（login-session.ts）— 登录 prelude
    │   ├── 从 chrome.storage.local 读取配置 devtools-account-switch
    │   ├── matchDomain(origin) 匹配 DomainConfig
    │   │   └── 未找到 → ENV_NOT_MATCHED
    │   ├── 按执行 tab 申请登录锁（同 tab 并发 → LOGIN_BUSY）
    │   ├── readSpecFromConfig(domainConfig) → LoginSpec
    │   │   └── 未配置 → NO_STRATEGY；旧扩展 key → STRATEGY_NOT_FOUND
    │   └── 构建 AuthContext { tabId, origin, domainConfig, credentials, debugBuffer }
    │
    ├── 2. runLoginSpec(spec, ctx)（spec/login-run.ts）
    │   │  runSpec 按 ops[] 顺序执行；轨迹进 debugBuffer
    │   │
    │   ├── clear.cookies   — 按 auth 声明清理（可含父域）
    │   ├── clear.storage   — local / session 两区
    │   ├── crypto.encrypt  — RSA 加密密码 → xstr
    │   ├── payload.build   — 拼装请求体 / 签名入参
    │   ├── digest          — SHA-256 签名
    │   ├── http.execute    — 发登录请求（POST {origin}/base/user/login）
    │   ├── auth.write      — 按 auth 声明写 cookie + localStorage
    │   └── success 信号判定 — 命中即成功；failure 命中优先中止
    │
    └── 3. session.logFinal(result) — 成功/失败都落调试日志
```

### 5.2 快捷登录流程 (QUICK_LOGIN)

```
用户在输入框粘贴文本 / 快捷键选中文字 / 右键菜单
    │
    ▼
[parse-text.ts] parseLoginText(text, defaultDomain)
    │ 解析: URL + 账号 + 密码?
    │ 返回: { url, username, password?, hasUrl }
    ▼
[Popup.vue / SwitcherPanel.vue] handleQuickLogin()
    │ 若 password 为空:
    │   根据 URL 匹配环境 → 获取 domainConfig.defaultPassword
    │   password = parsed.password || env.defaultPassword
    │   若两者都为空 → 提示错误
    │ sendBgMessage('QUICK_LOGIN', { url, username, password, hasUrl, debugRedirect })（类型化协议，见 shared/messages.ts）
    ▼
[background.ts] → 路由到 account-switch background handler
    │
    ▼
[background-handler.ts] handleQuickLogin(targetUrl, username, password, hasUrl, sender, debugRedirect)
    │
    ├── 1. prepareLogin()（同 5.1；解析 targetUrl / debugRedirect）
    │   └── debugRedirect 存在：redirectOrigin = origin，保留 pathname+search+hash
    │
    ├── 2. runLoginSpec(spec, ctx) — 与 5.1 完全同一条执行路径
    │
    └── 3. 跳转处理 (injectAndNavigate / setupAuthTab):
        │
        ├── 分支 A: 有 debugRedirect (Bug 复现跳转模式)
        │   ├── chrome.tabs.create({ url: redirectOrigin })
        │   ├── 等待新 tab 加载完成
        │   ├── 注入 token 到新 tab 的 localStorage（跨 origin）
        │   └── chrome.tabs.update(newTabId, { url: fullRedirectUrl })
        │
        ├── 分支 B: 无 debugRedirect，当前 tab 模式 (Popup/SwitcherPanel 快捷登录)
        │   ├── 注入 token 到当前 tab
        │   └── hasUrl ? 导航到 targetUrl : 刷新
        │
        └── 分支 C: handleQuickLoginInNewTab (快捷键/右键菜单触发)
            ├── prelude 预建 tab（active: false）→ 等待加载 → 登录（redirect origin 优先）
            └── setupAuthTab：同 URL 不导航 → 恢复快照 / 注入 token → 后台 reload → 激活
                    （刷新在不可见时完成，用户看不到中间态白屏；ADR-0012 D18）
```

> 注入失败必须显性化：`injectAndNavigate` 会关闭本次新建的 tab 并返回
> `INJECT_AUTH_FAILED`，绝不静默导航成「假登录」。

### 5.3 通用 API 登录

API 登录由 `http.request`、`crypto.digest`、`crypto.encrypt`、`map` 等通用算子
编排。端点、请求字段、签名规则、成功信号和会话写入均由用户导入或编辑的
LoginSpec 决定；请求和响应轨迹默认脱敏。虚构示例见
`docs/login-specs/operators.md`，通用执行细节见 `spec/run.ts`。

---

## 6. 认证存储机制

Cookie 名称、storage 键名、写入值与清理范围都由 LoginSpec 的 `auth.write` 和
`clear.*` 声明决定，没有特定站点的固定会话键。

Cookie 设置为 **host-only**（不设置 `domain` 字段），无前导点，仅作用于目标 hostname。

**按声明分流（ADR-0012 D6/D8 / ADR-0015 D7）**：

| 声明 | Cookie 清理 | storage 清理 | 跨 origin |
|------|-------------|--------------|-----------|
| `generic`（API / 引擎会话） | 按 `clear.*` 声明 | 按 `clear.*` 声明 | `auth.write` 在声明的 origin 写；目标 origin 由 `injectAuth` 注入 |
| `generic`（页面自管） | 默认精确 host 全部（`cookieClearIncludeParent` 可含父域） | 不清（避免误删站点设置） | 不写入 |
| `generic`（快照） | `auth.capture` 按三态范围捕获 → `auth.restore` 在目标 origin 恢复 | 同左 | capture → 目标 origin restore → reload |

清理与写入都由 `ops[]` 里的算子按声明顺序执行，没有独立的管线阶段。

跨 origin 写入顺序是不变量：**建 tab → 等加载 → 恢复快照 → 注入 token → reload**（`login-tab-flow.ts` 头注释）。在错误 origin 上恢复会抛 `INJECT_AUTH_FAILED`，不静默成功。

复用 prelude 已加载的 tab 时（新 tab 快捷登录），顺序仍是上面这条，但有两处收窄（ADR-0012 D18）：地址与目标一致时**跳过 `tabs.update`**（同 URL 重导航是多余的整页加载，且会提前把白屏暴露给用户）；`reload` 用 `reloadTabAndWait` 在后台完成后再 `active: true`。刷新等待超时按「直接激活」降级，只有 tab 被关闭才判失败。

---

## 7. 文件结构

```
entrypoints/tools/account-switch/
├── types.ts                      # 类型定义 (Account, DomainConfig, TokenData, AuthContext)
├── background-handler.ts         # 消息处理 (SWITCH_ACCOUNT / QUICK_LOGIN / TRIAL_LOGIN / TEST_RECIPE / SCAN_LOGIN_FORM)
├── login-session.ts              # 三条入口共享的 prelude / 会话日志 / 登录锁
├── login-tab-flow.ts             # tab 编排：建 tab / 注入 / 快照恢复 / 导航意图执行
├── Popup.vue                     # 扩展图标弹出面板
├── SwitcherPanel.vue             # Content Script 快捷键面板 (Alt+Shift+A)
├── Config.vue                    # 选项页配置管理
├── config/
│   ├── DomainsPanel.vue          # 环境编辑（登录方式 + 登录声明）
│   ├── SpecEditor.vue            # 登录声明编辑器（算子 / 校验 / 试跑 / 拾取入口）
│   ├── TargetField.vue           # 定位输入组件（kind + 拾取 + 候选胶囊 + 命中提示）
│   ├── recipe-editor-model.ts    # 旧配方编辑器纯函数模型（TargetField 复用）
│   ├── login-form-scan.ts        # 配置层兼容出口（实现归 strategies/login-form-scan.ts）
│   ├── LoginFormLocator.vue      # URL 下可选识别锁定与状态展示
│   └── target-picker.ts          # 定位拾取器（候选列表 + 元素元信息 / 交互四态）
├── EnvIndicator.ts               # 环境指示器 (页面右下角标签)
├── spec/
│   ├── types.ts                  # LoginSpec 数据模型 / 算子判别联合
│   ├── validate.ts               # 保存期静态校验 R1–R7
│   ├── migrate.ts                # v1 recipe / 旧扁平参数 → v2 声明
│   ├── run.ts                    # runSpec()：唯一执行器
│   ├── auto-login.ts             # 自动形状 / 旧默认兼容 / 无损锁定
│   ├── login-run.ts              # 生产接线：runSpec + 调试缓冲 + 日志信封
│   ├── trial.ts                  # 试登录（默认零副作用）
│   ├── session.ts                # clear.* / auth.* 会话算子
│   ├── snapshot.ts               # 快照算子
│   ├── http.ts / transform.ts    # 请求与数据变换算子
│   ├── template.ts / namespace.ts # 模板解析与输入命名空间
│   ├── package.ts                # 登录策略包（dt-login-config/v1）导入导出
│   ├── editor.ts                 # 编辑器纯逻辑（默认模板 / 投影 / 算子工厂）
│   └── redact.ts                 # 日志脱敏（白名单 / 黑名单）
├── strategies/
│   ├── login-form-scan.ts        # 手动与运行时共用的只读扫描 / 唯一解析
│   ├── generic-recipe.ts         # DOM 子集类型（Target / FrameScope / SettleCondition）与旧配方模型
│   ├── generic-runner.ts         # 仅保留 interpolateTemplate（旧配方试跑用）
│   ├── generic-dom.ts            # 跨 frame DOM 动作 / shadow root 深查询
│   ├── generic-target.ts         # Target → 页面内定位
│   ├── generic-settle.ts         # settle / failWhen 轮询
│   └── generic-dry-run.ts        # 旧配方试跑（步骤白名单）
└── utils/
    ├── auth-snapshot.ts          # 认证快照 capture / clear / restore
    ├── host-cookies.ts           # 按 host（可选含父域）清理 cookie
    ├── error-codes.ts            # 统一错误码 + buildErrorDetail
    ├── debug-log.ts              # 调试缓冲区 / 日志 adapter
    ├── env.ts                    # 域名匹配 + 环境检测 (matchDomain, getCurrentOrigin)
    └── parse-text.ts             # 快捷登录文本解析
```

## 8. 关键消息流

| 消息类型 | 发送方 | 接收方 | Handler | 关键参数 |
|----------|--------|--------|---------|----------|
| `SWITCH_ACCOUNT` | Popup / SwitcherPanel | background.ts | `handleSwitchAccount` | account, domain |
| `QUICK_LOGIN` | Popup / SwitcherPanel | background.ts | `handleQuickLogin` | url, username, password, hasUrl, debugRedirect |
| `QUICK_LOGIN_NEW_TAB` | background.ts (快捷键/右键菜单) | background.ts | `handleQuickLoginInNewTab` | url, username, password, hasUrl, debugRedirect |
| `TRIAL_LOGIN` | 选项页登录声明编辑器 | background.ts | `handleTrialLogin` | spec, origin, username, password, writeSession? → 信号 / 是否发出请求 / 是否写会话 |
| `TEST_RECIPE` | 选项页配方编辑器（旧 recipe） | background.ts | `handleTestRecipe` | tabId, origin, recipe, only? → 逐步骤命中状态（`only` 为单步试跑下标） |
| `SCAN_LOGIN_FORM` | 选项页配方编辑器 | background.ts | `handleScanLoginForm` | tabId, origin → 命中 frame 的用户名 / 密码 / 提交候选（只读） |
| `OPEN_ACCOUNT_SWITCHER` | background.ts | Content Script | 打开面板 | — |

---

## 9. 配置存储

| Storage Key | 内容 | 格式 |
|-------------|------|------|
| `devtools-account-switch` | 完整账号切换配置（含 `strategies` 登录策略库与 `envBadge` 指示器配置） | `AccountSwitchConfig` |

> 历史 key（`devtools-account-recent`、`devtools-meta`、`devtools-account-switch-debug-logs`、
> `devtools-account-switch-extension-src`、`devtools-account-switch-installed-extensions`、
> `devtools-ext-*`、`devtools-zentao-bridge`、`devtools-env-indicator`）已废弃：
> 启动期由 `utils/remove-extension-market-migration.ts` 与
> `shared/legacy-storage-cleanup.ts` 清理，且不再进入「全部工具设置」导出。
