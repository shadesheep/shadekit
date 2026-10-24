# 领域词汇表 (Glossary)

> 本项目统一语言。新增术语按字母序追加,被 ADR 引用时保持定义一致。

## 入口体系

- **Dock**(已移除,见 [ADR 0001](adr/0001-usability-entry-consolidation.md))— 曾注入所有 http/https 页面的常驻浮动入口(`#devtools-dock`)。因遮挡页面与 CSS 污染包袱被移除。
- **页面内面板 (SwitcherPanel)** — `Alt+Shift+A` 在鼠标位置唤出的账号切换面板,经 content script 注入。**功能本体而非入口**:账号切换必须在目标页面上下文执行(填表单、写登录态),不可搬进 popup 或标签页。
- **Popup** — 点击浏览器工具栏图标弹出的工具列表,工具的主入口。
- **标签页工具 (openInTab tool)** — 在独立扩展标签页中打开的工具:JSON 格式化、JSON 对比、图片 Base64、代码美化。
- **快捷登录 (Quick Login)** — 选中包含账号信息的文本后,经 `Alt+Shift+A` 或右键菜单直接解析并登录,不开面板。解析器为 `parse-text.ts`。

## 配置与状态

- **allowMultiple** — 标签页工具的打开策略。`false`(默认,ADR 0001 起)= 复用同工具已有标签页;`true` = 每次新开。复用时**不得清空已有内容**。
- **工具启用状态** — 存于 `chrome.storage.local` 的 `devtools-state` key;被禁用的工具在 popup 中隐藏,空状态需提示存在禁用工具。
- **Draft(不做)** — 工具标签页输入内容的持久化。已明确不做,标签页内容"用完即走"。
- **导入三轴**(ADR-0017 D2)— 账号切换的导入导出按对象分三类,不再混称「配置」:
  - **登录策略包** — LoginSpec 的分发载体(格式 `dt-login-config/v1`),含 ops / success / auth / vars 等登录声明;**可分享**,敏感变量(`vars[].secret`)不得入包。
  - **账号备份** — 账号切换整份配置的备份,含环境 + 凭据(明文密码);**不分享**,只用于本机/本人迁移。
  - **全部工具设置** — 全局导入导出，覆盖所有工具配置，包含账号及明文密码；**不随意分享**，仅用于本人迁移。

## 统一登录声明(ADR 0014 / 0015)

- **登录声明 (LoginSpec)** — 一次登录的完整、可序列化描述,**唯一存储与唯一事实源**。宿主内置登录与用户配置都是 LoginSpec,引擎不区分来源。
- **算子 (op)** — `LoginSpec.ops[]` 中的一项,可序列化、纯声明、由引擎执行。登录没有"阶段"概念,阶段即算子。产出值的算子用 `as` 声明绑定名,后续以 `$<as>` 引用;同一 spec 内绑定名唯一。
- **输入命名空间** — `{name}` 的取值来源:内置输入(username / password / origin / apiBase / targetUrl / debugRedirect)、spec 声明的变量(`vars`)与自动生成值(`aux`)。三者摊平为一个命名空间,重名即保存期报错。
- **清理算子 (clear.*)** — 会话清理的唯一声明处(`clear.cookies` / `clear.storage`),按出现顺序执行。清理范围不再属于认证声明。
- **导航算子 (goto)** — 唯一的页面导航声明。`navigate` 是同一概念的旧名,不再使用。
- **快照算子 (auth.capture / auth.restore)** — 在登录 origin 捕获会话、在目标 origin 的当前文档恢复;恢复前按快照范围清理同一批键。取代旧的三值 `mode: "snapshot"`。
- **内置 spec** — 以声明形式内置在仓库中的 LoginSpec(现仅 `generic`),与用户配置同构,走同一校验器与执行器。
- **本地策略包** — 用户通过受控渠道自行保存、按需导入的 LoginSpec 分发文件，不随扩展打包；公开仓库不附带内部系统的策略包。
- **登录策略包**(旧称「配置包」)— 跨环境/跨用户分发的 LoginSpec 载体,格式 `dt-login-config/v1`。与「账号备份」(含凭据、不分享)、「全部工具设置」(跨工具全局导入导出)是三条不同入口,见「配置与状态」的导入三轴。
- **模板 (SpecTemplate)** — 新建 LoginSpec 时的初始形态来源,`{ id, title, description, create() }`;即 `loginMethod` 的新语义。**只用于生成初稿与日志显示,不参与执行**。
- **成功信号** — LoginSpec 中声明的「怎样算登录成功」(响应路径 / token 路径 / 页面结算条件)。数组即「全部成立」;需要「任一成立」时,在数组中放一个 `anyOf` 组合元素。至少声明一条。
- **日志白名单 (log.reveal)** — spec 声明的「允许原样出现在调试日志里的绑定名」(如加密后的密文);与全局敏感字段黑名单互补,黑名单优先于白名单。
- **失败信号** — 与成功信号并列的 `failure` 声明(页面条件);轮询周期内失败优先,命中即中止登录。
- **认证声明 (AuthSpec)** — 会话的**写入目标与模式**,不含清理(清理归 `clear.*` 算子),也不含跨 origin 捕获与恢复(归 `auth.capture` / `auth.restore`);`engine` 由引擎按写入声明落库、`page` 由页面自管。
- **配方 (Recipe)** — LoginSpec 中 DOM 算子子集的**类型视图**,不是第二份数据。
- **`api-form`(旧名,已废弃)** — 早期草案中"配置驱动的 API 登录策略"。统一后不存在该策略,一律称 LoginSpec。
- **登录策略库 (Strategy Library)** — ADR-0019:以 `AccountSwitchConfig.strategies`(`id → { name, spec, createdAt, updatedAt }`)存放的独立策略。策略是一等对象,导入、编辑、删除都不增减环境记录;与账号/环境同住 `devtools-account-switch` key,因此备份与 WebDAV 同步天然覆盖。
- **策略关联 / 解绑 (strategyId)** — 环境通过 `DomainConfig.strategyId` 引用库条目，默认实时镜像库声明；环境另存私有 `strategyConfig.spec` 后脱离镜像。解绑只摘 `strategyId`，保留私有声明；删除库条目会解除所有绑定，镜像环境随之回到未配置(ADR-0019 D2/D3)。
- **环境级变量覆盖 (DomainConfig.vars)** — ADR-0019 D5:同一份共享策略绑到多个环境时,环境差异(API 地址、公钥等)存在 `vars`,运行期优先级为**环境覆盖 > `spec.vars[].default`**;导入时的 `requiredVars` 填值落在这里,不再烘进共享声明。

## 发布(商店提交)

- **商店发布凭证** — `CLIENT_ID` / `CLIENT_SECRET` / `PRODUCT_ID` 是 Edge Add-ons Publisher API 的发布凭证(`scripts/release.mjs` 映射为 `EDGE_PRODUCT_ID` / `EDGE_CLIENT_ID` / `EDGE_API_KEY`),存于 `.env`;Chrome Web Store v2 侧使用 `CHROME_EXTENSION_ID` / `CHROME_PUBLISHER_ID` + 服务账号(`CHROME_SERVICE_ACCOUNT_JSON`,或 `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` + `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`)。**与登录、账号切换、OAuth 无关**,勿混用名称。

## 原则

- **效率优先 (power-user first)** — 冲突时高频操作的路径最短者优先;新手体验守住"不 confusion、不破坏"底线即可。见 ADR 0001。
- **新手底线** — 任何 UI 元素可见即可懂、可 1 步关闭;装插件 5 分钟内无需问人即可上手。
- **受限页面** — `chrome://`、扩展商店、空白页等 content script 无法注入的页面。此类页面上快捷键操作必须给出失败提示,不得静默忽略。

## 环境与账号

- **环境指示器** — 环境列表的一个视图(ADR-0017 D1):页面角标显示当前环境(本地/测试/生产),默认关闭。不再是独立工具,配置并入 `AccountSwitchConfig.envBadge`(enabled / position / whitelist)。
- **域名配置** — 账号切换中按域名记录的环境信息(name、apiBase、tags 等);旧的 `publicKey` / `apiBase` 扁平策略参数已被 ADR-0015 取代:登录所需变量收敛进 LoginSpec 的 `vars`(`SpecVar[]`,含 name / title / default / secret),UI 上折叠隐藏高级字段。
