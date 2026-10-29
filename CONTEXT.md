# CONTEXT.md — ShadeKit 领域词汇表

架构评审与重构中沉淀的领域语言。新 module / seam 命名应先查此表。

## 核心概念

- **Tool（工具）** — 扩展的功能单元，在 `shared/tool-definitions.ts` 的 `allTools` 注册表中声明。现有 6 个:account-switch(含环境指示器)、json-formatter、json-diff、image-base64、code-beautify、mock-data。env-indicator 已并入 account-switch,见「已废弃」。
- **Registry（注册表）** — `allTools`,工具能力的唯一声明处:popup 入口、标签页、content script 面板、配置区、background handlers、默认配置。
- **Background Router（后台路由器）** — `background.ts` 中唯一的 `chrome.runtime.onMessage` 监听。**按消息 type 跨所有工具的 backgroundHandlers 路由**(2026-08-14 决策:不按 toolId 路由;启动期校验 type 唯一性,冲突即 throw)。legacy toolId 兜底已废弃。
- **Message Protocol（消息协议）** — `shared/messages.ts` 的 `BackgroundMessages` 判别联合:每个消息 type 声明 payload 与 response 形状。调用方经 `sendBgMessage(type, payload)` 发送,编译期强制;handler 签名按 type 收窄,禁止 `msg: any`。
- **核心消息** — 不属于任何工具的 background 自身消息(如 `OPEN_TOOL_TAB` 标签页复用),同样声明在 Message Protocol 中但不进 Registry。
- **Login Strategy（登录策略）** — 用 `LoginSpec` 声明一次登录，由 `spec/run.ts` 的 `runSpec` 统一执行；通用页面登录内置在 `spec/editor.ts`，其他策略由用户导入策略库。策略不保存单次登录的可变状态，运行数据在每次调用的 `AuthContext` 中流转。历史 `LoginStrategy` 接口、注册表与扩展策略均已移除（ADR-0014/0015）。
- **Editor Factory(编辑器工厂)** — `shared/lib/codemirror-editor.ts` 的 `createCodeEditor(opts)`(2026-08-14 决策):三个标签页工具(json-format / json-diff / code-beautify)共享的 CodeMirror 装配 module。主题同步(theme-changed 监听 + reconfigure)藏在内部;返回 `{ view, getText, setText, setLanguage, scrollToLine, focus, destroy }` handle,`view` 为逃生舱(仅接口未覆盖的罕见场景)。拖拽文件载入是独立 helper `attachFileDrop`,不进 factory。**增补(2026-08-18,第 5 轮评审)**:语言恒走内部 Compartment(`language` 为初始槽位,`setLanguage` 运行时切换);`scrollToLine`(0-based,光标置行首 + scrollIntoView,越界静默)与 `readonly` 选项收口调用方装配;双编辑器滚动同步为独立 helper `shared/lib/codemirror-scroll-sync.ts` 的 `syncScroll(a, b)`(返回 `{ suppress, detach }`,差异导航期间用 suppress 压制)。
- **Diff Markers(差异标记)** — `tools/json-diff/lib/diff-markers.ts`(2026-08-18 决策):json-diff 专属的差异 Decoration module。`createDiffMarkers()` 返回 `{ extension, set(editor, markers, side), clear(editor) }`;extension 经 `extraExtensions` 传入 Editor Factory。契约:`set` 按 side 过滤、行号越界静默跳过、该侧 0 条时 no-op(清空必须显式 `clear`)。
- **Login Tab Flow(登录 tab 编排)** — `tools/account-switch/login-tab-flow.ts`(2026-08-14 决策):两条 quick-login 路径共享的 tab 生命周期 module,四个函数:`parseDebugRedirect`、`resolvePostLoginUrl`(纯函数,测试面)、`setupAuthTab`、`injectAndNavigate`(拥有「注入失败必须关 tab 回滚、绝不静默导航」不变量)。两条路径尾部机制不同(inject-then-navigate vs create-at-url+reload),不做单入口合并。**增补(ADR-0004 D4)**:`applyNavigationIntent` 统一执行导航意图,tab 变更的唯一 owner。**增补(ADR-0012 D18,2026-10-23)**:`setupAuthTab` 复用 prelude 已加载的 tab 时,同 URL 不再 `tabs.update`(多余整页加载 = 白屏根因),刷新改用 `reloadTabAndWait` 在后台完成后再 `active: true`;D7 的写入顺序不变。
- **Login Session(登录会话)** — `tools/account-switch/login-session.ts`(2026-08-14 决策,ADR-0004 D2):三条登录入口共享的 prelude + 会话日志 module。拥有按 tab 登录互斥、config/domain/策略解析、ctx 构建、AuthSession 生命周期。handler 只剩 `prepare → 尾部 → finalize`。
- **Navigation Intent(导航意图)** — (ADR-0004 D4)Login Strategy `afterLogin` 的返回值:`{action:'navigate',url} | {action:'reload'} | {action:'none'}`。策略只做决策,执行归 Login Tab Flow;策略不再触碰 `chrome.tabs`。**收窄(ADR-0012 D10)**:`runAuthFlow` 的 `afterLogin` 选项分 `"execute" | "collect" | "skip"`——只有 `SWITCH_ACCOUNT` 走 `"execute"`;两条 quick-login 走 `"collect"`(策略仍可决策,intent 交 `injectAndNavigate` 作无明确目标时的 fallback),导航执行权始终归 Login Tab Flow,避免双 reload / 双开 tab。
- **Recipe(配方)** — `tools/account-switch/strategies/generic-recipe.ts`(2026-10-20 决策,ADR-0012 D1/D2):generic 策略的唯一事实源,`{ version, steps[], settle, auth, failWhen?, limits? }`。存放在 `DomainConfig.strategyConfig.recipe`,由 `runRecipe()` 按数据执行;旧的 8 个扁平 `strategyParams` 经 `migrateLegacyParams` 单向上转。执行器经 `onStep` 上报 start/end 事件,产出 `RecipeStepTrace[]`(序号/操作/目标/状态/耗时/错误码):失败时随 `LoginError.recipeSteps` 进入 debug 缓冲区,`buildErrorDetail()` 逐条列出。_Avoid_: 继续在代码里硬编码登录阶段。
- **Target(元素定位描述)** — (ADR-0012 D3)配方中定位页面元素的判别联合:`string`(=CSS) / `{css}` / `{label}` / `{name}` / `{placeholder}` / `{text}`。页面内按 `id/name → aria-label → label → placeholder → text → 唯一属性` 解析,多个可见命中报 `AMBIGUOUS_TARGET`,不静默取首个。
- **Settle Condition(成功判定)** — (ADR-0012 D4/D5)`{formGone|urlChanged|url|selector|cookie|storage|fixed|any|all}` 联合;默认 `any[formGone, urlChanged]` 零配置可用;与 `failWhen` 并列轮询,失败命中即早退。取代 `successType` / `successValue` 扁平参数与「固定等待等于不等待」的坏语义。
- **Auth Snapshot(认证快照)** — `tools/account-switch/utils/auth-snapshot.ts`(2026-10-20 决策,ADR-0012 D6/D7):引擎级 `capture / clear / restore`,策略只声明 `AuthSpec`(`{mode:'page'}` 或 `{mode:'snapshot', cookies, cookiesClear, localStorage, sessionStorage}`)。**不变量**:storage 是 origin 作用域的,恢复顺序固定为 `create tab @ targetOrigin → waitForTabLoaded → clear → set → reload`,归 Login Tab Flow 执行,策略不得自行挑选 tab 写入。**接线**:capture 在 `runAuthFlow` 的 login 步之后、于登录 origin 的就地 tab 上执行,结果经 `AuthFlowResult.capturedAuth` 交给 `setupAuthTab` / `injectAndNavigate`;restore 只在这两个函数的注入目标 tab 上进行,顺序为 clear → restore → setAuth → reload(在错误 origin 上 restore 抛 `INJECT_AUTH_FAILED`)。声明了快照规格的策略,`clearCookies` 步直接按 `cookiesClear` 分流,未声明的策略仍走 `getCookiesToRemove()` 白名单。
- **Account View Model(账号视图模型)** — `tools/account-switch/account-view.ts`(2026-08-14 决策,ADR-0004 D6):账号领域规则的唯一 owner,纯函数:`normalizeAccount`(旧数据 role→roles 归一化)、`filterAccounts`、`resolvePassword`(账号→环境默认→全局默认)、`roleColor`(ROLE_COLORS 单源)。**增补(2026-08-18)**:`resolveEnvironment`(origin → 环境匹配,返回 domain key + env)、`parseAccountsFromText`(快速添加:解析 + 环境匹配 + 密码回退 + 去重;id 生成与保存留在调用方)。Config.vue、SwitcherPanel 与 background 选中快捷登录三处共用。
- **content-theme** — `shared/content-theme.ts`(2026-08-14 决策,ADR-0004 D7):content script 侧主题 adapter(read/listen/apply `data-dt-dark`),`content/` 与 `json-page-format.content/` 共用,不再各自直读 `devtools-theme`。
- **Log Viewer** — `options/components/DevLogsViewer.vue`(ADR-0004 D5)为唯一日志查看器;`shared/logger.ts` 为唯一日志存储,登录会话追踪经 debug-log 的 `logEntry()` adapter 写入 `auth` 类别。**增补(ADR-0012 issue 14)**:dev 模式下方可在会话日志中实时看到配方步骤事件(`extra.action = RECIPE_STEP_START / RECIPE_STEP_END`,含 op/target/状态/耗时/错误码),长流程进行中即可定位卡在第几步;非 dev 模式只写失败摘要。
- **Config Kit(配置页套件)** — `entrypoints/shared/config/`(2026-08-18 决策,ADR-0007):选项页配置表单的声明式组装层。组件:`DtConfigHeader`(标题+自动保存状态)、`DtConfigItem`(Setting Item 行容器)、`DtSegmented`(分段单选,替代原生 radio)、`DtToggle`(开关,替代原生 checkbox)、`DtNumberField`、`DtConfigActions`;外加 `useToolConfig` composable 收口加载/合并/保存。Config.vue 只组装 Setting Item,禁止手写裸 radio/checkbox 模板与逐控件 `@change` 保存。
- **Setting Item(设置项)** — 一行配置的规范结构:label + 控件 + hint,由 `DtConfigItem` 渲染;是选项页 Config.vue 的唯一构建单元。
- **Auto-save(自动保存)** — 选项页配置的保存范式(ADR-0007):`useToolConfig` 内部 watch + 防抖 + `updateConfig` 增量合并,页内零保存代码;成功反馈为「✓ 已保存」轻提示(不弹 toast),失败才 toast。
- **批量生成(Batch Generate)** — mock-data 的主模式:字段列表 × 条数 → 结构化数据集(JSON/CSV/SQL 等),结果区支持卡片/表格/源码三视图。
- **快速取数(Quick Take)** — mock-data 的第二模式:只要单值(一个身份证、一个项目名)时,点类型即产出一批候选值,点击即复制;与批量生成共享右侧结果区。
- **候选值(Candidate Values)** — 快速取数的产物:同一类型的一次性去重值列表(默认 6 条,上限 20),用一批换一批,不持久化。
- **Environment(环境)** — 账号切换中的一条环境记录:`origin`(唯一键)+ 显示信息(名称、类型 chip、指示器开关)+ 登录策略引用(`loginMethod`)+ 账号绑定(多对多,默认 1 环境 1 账号)。环境是「登录策略 + 凭据」的绑定点(ADR-0017 D2),自身不含凭据。
- **LoginSpec(登录策略)** — 见上文「Login Strategy」与 `docs/AI.md`「LoginSpec v2：唯一登录模型」。一份 LoginSpec 完整描述「怎么登录」:**可分享**,是生成 Skill 的产出物;分发载体是登录策略包(`dt-login-config/v1`),敏感变量(`vars[].secret`)不得入包(ADR-0015 D9)。
- **Credential(凭据)** — 账号(用户名/密码/角色/环境绑定)与默认密码,**永不公开分享**:不进登录策略包;「账号备份」「全部工具设置」导出及 ADR-0016 所述 WebDAV 同步按设计包含凭据，只用于本人迁移/自有设备同步。
- **模式作用域顶栏(Mode-scoped Toolbar)** — (2026-08-18 决策,ADR-0008)工具页顶栏不是全局的,归属当前模式:控件随模式变形(条数↔候选条数、生成↔换一批)或隐藏(模板/格式/预设),快捷键语义与主按钮始终一致。

## 已废弃(勿再引入)

- (ADR-0017 起)`env-indicator` 作为独立工具:不再是 tool id,不再有侧栏项与配置页;环境指示器降为环境列表的一个视图,配置并入 `AccountSwitchConfig.envBadge`,显示名为「环境与账号」。

- 消息里的 `toolId` 字段(2026-08-14 起由按 type 路由取代)。
- `background.ts` 的 legacy 消息兜底分支(SWITCH_ACCOUNT / QUICK_LOGIN / OPEN_TOOL_TAB)。
- (ADR-0006 起)**整个插件市场系统**:ext-engine/、ExtensionMarket UI、扩展消息协议、扩展存储、ExtensionStrategy(2026-08-17 移除,见 ADR-0006)。登录现由 LoginSpec 与策略库承载。
- (ADR-0004 起)`login-lock.ts` / `keyed-lock.ts`(互斥分别内化进 Login Session);`lintJson`(统一走 `parseJsonError`);`DebugLogViewer.vue`(DevLogsViewer 为唯一查看器);策略 `afterLogin` 内直接调用 `chrome.tabs`(改为返回 Navigation Intent)。
- (ADR-0012 起)generic 的 `buildFlow()` 固定 6 阶段、`successType="timeout"` 分支、`executeLoginScript` 返回 JSON 字符串的契约;`PrepareLoginInput.execTabId: number`(改为 `execTarget` 判别联合);generic 把令牌写进 `strategyParams` 的做法(改为 `strategyConfig.recipe`)。
