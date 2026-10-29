# ShadeKit · AI 核心设计上下文

> 本文是 `docs/` 中唯一的核心设计汇总，面向修改本仓库的 AI/工程师。
> 历史 ADR、重复术语表和过程稿已删除；**代码与测试是行为的最终事实源**，本文记录不可随意打破的架构约束。
> 日期：2026-10-29。标注「未实现 / 草案」的内容不是当前产品能力。

## 1. 阅读顺序与修改原则

1. 先读本文件，再读将修改的模块及其测试；不要凭本文猜测实现细节。
2. 新模块/字段优先复用现有注册表、消息协议、存储管线和共享组件，不建立第二套事实源。
3. 修改登录行为时，必须保持 `LoginSpec`、策略库、tab 编排、敏感信息边界的不变量。
4. 删除旧路径时同步迁移所有调用方、测试和链接；不要保留无生产调用方的兼容壳。
5. 真实账号、密码、token、内部地址和私有登录策略包不得提交到公开仓库。

常用验证命令：`npm run check`、`npm run lint`、`npm test`、`npm run build`。演示站验证：`npm run test:demo`。

## 2. 当前产品与入口

- 技术栈：WXT + Vue 3 Composition API + TypeScript strict；UnoCSS，content script 使用 SCSS；持久化使用 `chrome.storage.local`。
- 当前 6 个工具：`account-switch`（环境与账号，含环境角标）、`json-formatter`、`json-diff`、`image-base64`、`code-beautify`、`mock-data`。
- 主入口：工具栏 Popup；JSON/图片/代码/模拟数据工具可打开独立扩展标签页。
- `Alt+Shift+A`：无选中文本时在页面内打开账号切换面板；有选中文本时尝试快捷登录。受限页面必须明确提示失败，不得静默忽略。
- 右键菜单仅保留选中文本 → JSON 格式化、JSON 对比、快捷登录。
- 常驻 Dock 已移除；不要再注入全站浮动 Dock。页面内 `SwitcherPanel` 是账号切换功能本体，因为登录必须在目标页面上下文执行。
- 独立 `env-indicator` 工具已合并进 `account-switch`；角标默认关闭，配置为 `AccountSwitchConfig.envBadge`。
- 标签页工具默认 `allowMultiple: false`：复用同工具标签页时不得清空用户已有内容。标签页输入不做 Draft 持久化，形态是「用完即走」。

## 3. 扩展架构与存储

### 3.1 注册表、路由、消息

- `entrypoints/shared/tool-definitions.ts` 的 `allTools` 是工具能力唯一声明处：Popup、独立标签页、content script、配置区、后台 handler、默认配置。
- `entrypoints/shared/messages.ts` 是消息协议唯一事实源；`BackgroundMessages` / `ContentMessages` 用判别联合声明 type、payload、response。
- `entrypoints/background.ts` 与 `shared/message-router.ts` 按消息 **type 全局路由**，启动时检查 type 唯一性并 fail fast。不要重新引入消息 `toolId` 或 legacy 兜底分支。
- `OPEN_TOOL_TAB` 是 background 核心消息；工具 handler 走 Registry。调用方使用 `sendBgMessage` / `sendContentMessage`，禁止 `msg: any`。
- background 专用依赖保持动态 import，避免被打进 Popup/options/content bundle。

### 3.2 配置与共享状态

- 工具配置 key：`devtools-{toolId}`，由 `shared/tool-config.ts` 的 `keyFor()` 生成。
- 共享 key：`devtools-state`（工具开关）、`devtools-theme`（主题）、`devtools-logs`（日志）。日志不是可导出的工具配置。
- `getConfig(toolId, defaults?)` 只做顶层浅合并；没有存储值时仍返回 `undefined`，defaults 不伪造「已配置」状态。
- 普通保存优先 `updateConfig()` / `updateConfigTransaction()`：Web Locks 跨上下文串行化「读最新 → 合并最小 patch → 写回」。整体替换仅限确需覆盖的导入场景。
- 「全部工具设置」由 `shared/config-transfer.ts` 按注册表白名单导出：所有注册工具 + `state` + `theme` + `__version`。不要按 `devtools-` 前缀全量导出/回灌。
- 当前 `CONFIG_VERSION = 2`。配置结构变更要同步迁移链和导入/导出测试。
- 主题通过 `data-dt-dark` 属性控制，不用 `@media` 作为组件暗色判断；扩展页使用 `shared/dark-mode.css`，Vue scoped 样式用 `[data-dt-dark] .class` 覆盖。

### 3.3 共享模块边界

- CodeMirror 装配统一走 `shared/lib/codemirror-editor.ts` 的 `createCodeEditor()`；拖拽载入走 `attachFileDrop()`，不要在各工具复制主题监听和编辑器生命周期。
- 配置页标准表单项使用 `shared/config/` Config Kit：`DtConfigHeader`、`DtConfigItem`、`DtSegmented`、`DtToggle`、`DtNumberField`、`DtConfigActions`、`useToolConfig`。Config.vue 组装 Setting Item，不写重复的逐控件保存逻辑。
- 账号领域纯函数在 `tools/account-switch/account-view.ts`；环境/账号导入视图模型在 `account-env-view.ts`。
- 日志唯一存储是 `shared/logger.ts`，唯一查看器是 `options/components/DevLogsViewer.vue`；登录日志写入 `auth` 类别。
- 多模式工具的顶栏必须声明控件归属；主按钮与快捷键语义随当前模式一致，不出现「视觉全局、语义单模式」的控件。

## 4. 环境、凭据与登录策略

### 4.1 三个对象

- **环境** `DomainConfig`：以 origin 为 key，保存名称、tags、调试跳转、默认密码、环境变量覆盖和策略绑定。环境是「策略 + 凭据」的绑定点。
- **凭据** `Account`：用户名、明文密码、角色、环境绑定；账号备份和全部工具设置可包含它们，但只能用于本人迁移/同步。
- **登录策略** `LoginSpec`：描述如何登录，可作为 `dt-login-config/v1` 策略包分享；账号绑定、真实凭据、secret 变量和 `script` 不得进入策略包。

默认产品路径是 1 环境 1 账号；多对多绑定仍支持。密码回退顺序由账号视图模型统一处理，不要在 UI/background 各写一份。

### 4.2 策略库：引用 + 镜像

实现：`spec/strategy-library.ts`、`spec/migrate.ts`、`spec/strategy-presets.ts`。

- 库位于同一个 `devtools-account-switch` key 的 `AccountSwitchConfig.strategies`，形状为 `id → { name, spec, createdAt, updatedAt }`。不要另开 storage key，否则备份、同步和原子写入会分叉。
- 环境用 `DomainConfig.strategyId` 绑定库条目。绑定且没有 `strategyConfig.spec` 时是**镜像**：运行时实时读库，不保存副本，库编辑立即影响全部镜像环境。
- 环境另存 `strategyConfig.spec` 后是**脱镜/私有声明**，覆盖库条目；「重置镜像」只删除这个私有声明并保留绑定。
- 解绑只摘 `strategyId`；删除库条目只删除条目并解绑，不增减环境。镜像环境随后回到未配置，脱镜环境保留私有声明。
- 导入策略包默认只入库；只有用户显式选择时才同时创建环境。策略和环境在同一配置 patch 中落盘。
- 环境差异写 `DomainConfig.vars`，优先级：**非空环境覆盖 > `spec.vars[].default`**。不要把导入值烘进共享 spec。
- 存量未绑定环境的内联 spec 保持只读兼容，不自动搬入策略库；悬空 `strategyId` 按未绑定处理。
- `loginMethod` 仅是模板/显示 id，用于新建和日志；**绝不参与执行分派**。

## 5. LoginSpec v2：唯一登录模型

事实源：`spec/types.ts`；校验：`spec/validate.ts`；迁移：`spec/migrate.ts`；生产执行：`spec/run.ts` 的 `runSpec()`；生产接线：`spec/login-run.ts`。

旧 `LoginStrategy`、策略注册表、固定六阶段 `runAuthFlow`、独立 `runRecipe` 和第二套步骤引擎已删除。内置 generic 与用户声明同构，走同一校验器和执行器。

### 5.1 顶层形状

```ts
interface LoginSpec {
  version: 2;
  template?: string;                 // 显示/新建用途，不分派
  vars?: Array<{ name: string; title?: string; default?: string; secret?: boolean }>;
  aux?: { nonce?: "auto"; timestamp?: "auto" };
  ops: SpecOp[];                     // 唯一流程事实源，按顺序执行
  success: SuccessSignal[];          // 至少一条；顶层 AND
  failure?: SettleCondition[];       // 任一命中即失败，失败优先
  auth: { mode: "engine" | "page"; /* cookies/storage 写入声明 */ };
  limits?: { requestMs?: number; stepMs?: number; settleMs?: number };
  log?: { reveal?: string[] };        // 日志白名单；黑名单优先
}
```

`Recipe` 只是 DOM 算子子集的旧模型/类型视图，不是与 `ops[]` 并列的第二份流程数据。编辑器可投影响应式视图，但保存仍写同一份 spec。

### 5.2 引用、绑定与默认值

- `{name}`：输入命名空间，摊平包含内置输入、`vars`、已声明 `aux` 和账号字段；内置为 `username`、`password`、`origin`、`targetUrl`、`debugRedirect`。不要新增 `vars.` 前缀语法。
- `$name` / `$path.to.field`：前序算子的 `as` 绑定，支持点路径和数组下标；同一 spec 的 `as` 唯一。
- 转义：`{{` → `{`、`}}` → `}`、`$$` → `$`。未解析引用是错误：保存期 `CONFIG_INVALID`，运行期 `TEMPLATE_UNRESOLVED`，不得原样发送。
- 对象引用按无空格 `JSON.stringify` 序列化；整串恰为一个引用时，数据算子可保留对象/数字类型。
- `aux.nonce = "auto"` 用 `crypto.getRandomValues` 生成随机 nonce；`aux.timestamp = "auto"` 使用当前毫秒时间戳。测试注入固定值以断言请求字节。
- 绑定产出算子：`http.execute`、`digest`、`crypto.encrypt`、`payload.build`、`map`、`auth.capture`、`extract`、`script`；`auth.restore` 只消费快照。
- 默认超时：`requestMs=15000`（HTTP）、`stepMs=5000`（fill/click/extract/script）、`settleMs=10000`（页面轮询及 goto 缺省）。不要恢复 `pageLoadMs`。

### 5.3 17 个算子及关键语义

| 类别 | 算子 | 必须保持的语义 |
|---|---|---|
| 清理 | `clear.cookies`、`clear.storage` | `AuthRange` 三态为 all / none / 键名数组；按声明顺序执行；Cookie/Storage 是不同状态区 |
| 导航 | `goto` | 支持 `waitForLoad`、`waitForTarget`、`timeoutMs`、条件 `when`；`when` 为假记 skipped |
| HTTP | `http.execute` | body 仅 `{json}` / `{raw}` / `{ref}`；默认 GET、2xx、JSON；绑定响应体，不绑定响应头 |
| 请求改写 | `apply.set` | 只作用于其后最近的 `http.execute`，写 header/body/query；raw body 不可改写 |
| 数据 | `digest`、`crypto.encrypt` | SHA-1/SHA-256；RSA PKCS#1 v1.5/OAEP，RSA 输出 base64 |
| 数据 | `payload.build`、`map` | payload 字符串模式与对象模式互斥；map 严格 `===`，无命中需 default |
| 会话 | `auth.write` | 从 `spec.auth` 写 Cookie/Storage；`mode:"page"` 时是空操作 |
| 快照 | `auth.capture`、`auth.restore` | 登录 origin 捕获，goto 后在目标 origin 恢复；restore 不产出绑定 |
| DOM | `fill`、`click`、`waitFor` | 使用 Target/FrameScope/SettleCondition；click 可声明找不到时 skip |
| 读取 | `extract` | source 为 local/session/dom/url/cookie；不再提供 local→session 隐式回退 |
| 逃生舱 | `script` | 默认 MAIN world；`code` 不做模板插值；仅本地/经审阅内置声明可用 |

补充约束：

- `http.execute` 可重复；HTTP 2xx 不等于业务成功。JSON/ref 请求体按声明 key 序无空格序列化；GET 不带 body。
- `apply.set` 的 body 点路径可创建中间对象；不得允许 `__proto__` 等危险路径造成原型污染。
- `payload.build`：字符串模式每个 part 无 `key` 且声明 `join`；对象模式每个 part 有 `key` 且无 `join`。normalize 支持 trim/upper/lower/numericString/base64/base64url。
- `script` 入口接收只读 bindings 副本，返回值整体绑定；失败用 `throw`，不要恢复 `{success}` 返回值协议。ISOLATED 不是安全边界。

### 5.4 Target、页面条件与自动定位

- `Target` 是 CSS 字符串或 `{css}` / `{ariaLabel}` / `{label}` / `{name}` / `{placeholder}` / `{text}`；fill/click 可附 `frameId` / `frameUrl`。
- 文本匹配先去全部空白，可见精确匹配优先，无可用精确匹配才退回子串；多个可见命中报 `AMBIGUOUS_TARGET`，不得静默取第一个。
- 跨 frame 使用 allFrames，支持 open shadow root 深查询；frame 先按 id，再按 origin + pathname。失配报 `FRAME_NOT_FOUND`，不得回退到任意 frame。
- 框架易变 id（Element Plus、React、Radix 等）不能作为稳定候选或 CSS 路径锚点；不要在运行时静默改成另一套定位。
- `SettleCondition`：`formGone`、`urlChanged`、`url`、`selector`、`cookie`、`storage`、`fixed`、`any`、`all`。
- `SuccessSignal`：`response`、`token`、`page`、`anyOf`。顶层 success 数组是 AND；需要 OR 必须显式 `anyOf`。failure 与验证码检测在同轮询周期优先。
- `{auto:"login"}` 只允许标准 `fill{username} → fill{password} → click` 整组使用，可带 goto 和 clear/auth 辅助算子。扫描必须同 frame 三项齐全且唯一；多表单、多 frame、缺项、歧义均拒绝猜测。
- 自动解析只缓存于本次运行，不自动写回共享策略；手动锁定只脱镜当前环境。首个自动算子前无密码框时最多刷新一次，不得在任意失败后来回刷新。

### 5.5 保存期 R1–R7

| 规则 | 不变量 |
|---|---|
| R1 成功先行 | engine 的 `auth.write` / `auth.capture` 位于成功信号所需绑定之后；page 信号还要求位于最后 DOM 交互之后。page mode 只豁免 auth.write |
| R2 数据流可达 | `$x`、`from:"x"` 和 auth 写入值只能引用当前位置之前已产出的绑定 |
| R3 跨 origin 写入 | `targetUrl` / `debugRedirect` 导航与 auth 写入/快照必须满足 capture → goto → restore；不得先写会话再跨 origin |
| R4 输入已声明 | `{name}` 必须在内置、vars 或 aux 命名空间 |
| R5 绑定唯一 | 同一 spec 的 `as` 不重复 |
| R6 算子前置 | apply.set 后有 HTTP；body.ref 来自对象 payload；restore 引用前序 capture；payload 两模式不混用 |
| R7 成功信号有效 | success 非空，递归 anyOf 也不能为空 |

### 5.6 会话与 tab 编排不变量

- 对已有会话重复切换时，`auth.write` 太晚会阻止不了旧 Cookie 随登录请求发出。按目标系统证据，在首个登录请求/页面导航前用 `clear.cookies` / `clear.storage` 清认证键；不要无证据地默认全清，尤其不要误删 CSRF/挑战 Cookie。
- Storage 是 origin 作用域。跨 origin 顺序固定为：**捕获登录 origin → 创建/导航到目标 origin 并等待加载 → 清同批键 → 写 Cookie/Storage → reload**。写错 origin 必须报 `INJECT_AUTH_FAILED`。
- tab 变更收口在 `login-tab-flow.ts`；spec 决定声明式动作，编排层执行。不要在策略/算子中另开一套 tab 生命周期。
- 复用 tab 时同 URL 不做多余导航；后台 reload 完成后再 activate。登录过程中新建的 tab 失败时必须关闭回滚，不得静默导航造成假成功。
- 普通账号切换成功后由 `refreshAfterSwitch()` 处理 `?redirect=` 或原地刷新；刷新失败只记日志，不推翻已完成的会话写入。
- 落地 URL 推导优先级：`debugRedirect` > `targetUrl` > `lastGotoUrl` > `origin`；不要恢复基于 `apiBase` 的 `/api` 猜测。
- 试登录 `spec/trial.ts` 默认只执行 HTTP/数据算子和数据成功信号，不执行 goto、页面算子或 auth.write，不接触当前 tab；只有显式 `writeSession` 才写会话。

## 6. 配置 UI 与页面注入

- 登录编辑器只有简易 / 高级 / 原始 JSON 三种视图，全部投影同一份 `ops[]`。简易模式只改标准三步，其他算子原样保留；不得增加 `simple` 存储字段。
- `TargetField.vue` 统一 Target 输入、拾取、候选和命中提示。拾取结果区分 picked/cancelled/lost/error；失败不能伪装成用户取消，结束后回切来源 tab。
- 表单扫描只读：不点击、不提交、不写存储。识别结果必须经用户确认或明确的锁定流程，不得静默替换高级多步声明。
- 注入页面的函数必须自包含，不能引用模块级标识符；页面文案写 UI 用 `textContent`，禁止把不可信文本传给 `innerHTML`。
- 扩展拾取器不使用 `chrome.debugger` / CDP；不恢复录制回放、插件市场或另一套配方执行器。

## 7. 安全、隐私与导入导出

- 账号密码在扩展 `chrome.storage.local` 中是明文；UI 和文档不得暗示已加密。公开示例只能使用虚构数据。
- **登录策略包** `dt-login-config/v1`：可分享，只含声明、环境和非敏感 requiredVars；不含账号绑定、密码/token、secret、`script`。
- **账号备份**：账号切换整份配置，含明文凭据，只用于本人迁移。
- **全部工具设置**：跨工具整包，含明文凭据，只用于本人迁移；按注册表白名单过滤。
- 策略包导入/导出都逐算子拒绝 `script`；高于当前支持的 spec/package 版本要明确拒绝，不猜测降级。
- `requiredVars` 必须是对应 `spec.vars` 的子集；包级与环境级保持同步。包校验不能替代内层 LoginSpec 校验。
- 日志对 password/passwd/pwd/token/refresh_token/authorization/cookie/set-cookie/secret/x-*-token 做结构化脱敏；黑名单优先于 `log.reveal`。`sign` 可保留用于排障，但不能借 reveal 泄露秘密。
- 扩展只负责登录和写会话，不自动续期、不监听 401 刷新 token。expiry 单位必须显式声明，不启发式猜测。

## 8. 已接受但未实现：WebDAV 同步设计

当前仓库没有 `entrypoints/tools/webdav-sync/`；不要把以下设计描述成现有功能。

- 自托管 WebDAV，单文件 `/devtools/config.enc`；载荷沿用注册表白名单，排除日志、同步工具自身配置/备份和迁移标记。
- 信封：PBKDF2-SHA256（初始设计 210000 次）+ AES-256-GCM；payload 与 verifier 使用独立随机 IV，salt/IV 每次写入更新。
- WebDAV Basic 密码、同步 passphrase、业务密码职责不同。passphrase 不落盘，且必须足够强、不同于 WebDAV 密码；它是服务器无法解密假设的承重墙。
- 上传冲突检测使用 LOCK → PROPFIND/ETag 预检 → PUT → UNLOCK；不能假设服务端支持 If-Match CAS。423 表示其他设备正在同步。
- 下载覆盖本地前保留最近一份本地备份；P0 是整包覆盖 + 用户选边，不做字段级合并、实时同步或版本历史。

## 9. 草案：ShadeKit Desktop（未实现）

当前没有 `engine/` 或 `desktop/` 实现。以下是已验证过部分假设的设计方向，不是修改扩展时可依赖的现有 API。

- 目标形态：Tauri 2 + Vue/TS 共享登录引擎；Rust 只负责进程、字节转发、HTTP 和系统钥匙串。不要为了桌面端重写一套 Rust 登录语义。
- 引擎宿主缝应是由引擎定义的 `HostBridge` 意图接口，而不是模拟完整 `chrome.*`；扩展和桌面端分别实现，靠类型和契约测试防止漂移。
- Chrome/Edge 走 CDP，优先 `--remote-debugging-pipe`；Firefox 走内置 WebDriver BiDi，不使用已移除的 Firefox CDP，也不引入 geckodriver。
- 每账号隔离使用 Chromium BrowserContext / Firefox userContext；不要拿同一浏览器实例共享的 incognito 会话当账号隔离。
- 桌面 `http.execute` 需经 Rust 绕过 WebView CORS，并将原始 Set-Cookie 回灌当前浏览器上下文；reqwest 不隐式维护 Cookie Jar。
- 配置分离：扩展兼容的 `shadekit-config.json` 与桌面专属 `client.json`；MVP 单向导入、不双向同步。密码应放系统钥匙串，service 固定为 `dev.shadekit.desktop`。
- 不接管用户默认浏览器 profile；受管 profile 是干净环境。桌面 UI 不共享扩展 Vue 组件，环境角标和窗口标题用于区分并存账号。
- P0 spike 脚本保留在 `docs/spikes/0020-p0a-chrome/`。已验证 macOS 上 Chrome/Edge/Firefox 基本链路；Windows/Linux、pipe 跨平台、后台节流和 10+ 上下文仍未验证。

关键协议经验：CDP 要显式启用 auto-attach、target discovery、Page/lifecycle events；browser 级 Cookie 使用 Storage 域，删除可写过期的空值；跨源 iframe 是 OOPIF，需要单独 attach。Firefox 从 profile 的 `WebDriverBiDiServer.json` 发现端口，复用 profile 前删除旧文件，连接后先 `session.new`；URL 应现场读取，不能依赖滞后的 tab URL 缓存。

## 10. 禁止重新引入的旧设计

- 常驻 Dock、独立 `env-indicator` 工具、插件市场 / ext-engine / 第三方登录扩展沙箱。
- 消息 `toolId` 路由、legacy background 兜底、`msg: any`。
- `LoginStrategy` / `registerStrategy` / `runAuthFlow` 六阶段管线、与 `runSpec` 并列的 Recipe 执行器。
- `api-form`、`cookiePolicy`、`navigate` 旧算子名、`successType:"timeout"`、`pageLoadMs`。
- 未解析模板原样发送、extract 的 local→session 静默回退、多命中静默取第一个、frame 失配全局搜索。
- 策略库独立 storage key、绑定即复制 spec、把环境变量烘进共享声明、按 `loginMethod` 执行分派。
- 把 `script`、secret 或凭据放进登录策略包；把日志/缓存按前缀纳入全部工具设置。
- 新快捷键、扩张右键菜单、标签页 Draft 持久化；没有真实需求时不新增 OAuth/OIDC、secret store、HMAC/AES、令牌续期等投机能力。

## 11. 保留的配套资料

- `docs/readme-demo/README.md`：虚构演示站、真实扩展截图和 GIF 的复现步骤；`capture.mjs` / `server.mjs` 是仍在测试脚本中使用的工具。
- `docs/store/README.md`：商店素材尺寸与重新生成方式；`docs/store/` 和 `docs/images/` 是发布素材，不属于待清理的过程文档。
- `docs/skills/authoring-shadekit-login-specs/`：可独立分发的登录策略 authoring Skill，含完整快照参考、校验/模拟脚本和 fixtures。其文档服务于该 Skill 的独立运行，不是历史 ADR 的副本。
- `docs/spikes/0020-p0a-chrome/`：桌面方案的可复跑实验代码；不参与扩展构建，不能当作当前桌面实现。
