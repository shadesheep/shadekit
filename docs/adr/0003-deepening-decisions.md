# ADR 0003: 深化重构决策 —— 消息协议、无状态策略与四个 module 收口

- **日期**: 2026-08-14
- **状态**: 已确认，待实施
- **背景**: 例行架构评审（基于近 80 次提交热点 + 三路并行代码探查），产出 6 个 deepening 候选，逐棵决策树与负责人确认。术语遵循 `CONTEXT.md` 与 deep-module 词汇（module / interface / depth / seam / deletion test)。本文档记录决议、理由与被否决的备选，供未来架构评审避免重新争论。

## 决策清单

### D1. 消息路由:按 type 全局路由，废弃 toolId(Strong，含线上 bug 修复)

- **事实**: `background.ts` 的 Background Router 原按 `message.toolId` 查找工具;`ExtensionMarket.vue` / `ExtensionInstallDialog.vue` 发送的 6 类扩展管理消息(`INSTALL_*` ×2、`UNINSTALL`、`UPDATE`、`RELOAD`、`SET_BUILTIN_ENABLED`)不带 toolId,被 router `return false` 丢弃——自 `b0b18c8`(2026-08-12)起功能断裂,而 handler 级测试绕过 router 直调所以全绿(测试跨过的 seam 不是调用方跨过的 seam)。
- **决策**: router 跨所有工具的 `backgroundHandlers` 按消息 type 路由，启动期校验 type 唯一性（冲突即 throw,fail fast)。删除消息中的 `toolId` 字段、3 个 legacy 兜底分支、5 个从未被发送的 registry 消息类型。`QUICK_LOGIN` 归位 registry。`OPEN_TOOL_TAB` 保留为 background 核心消息（不进 registry)。
- **协议**: 新建 `shared/messages.ts`,`BackgroundMessages` 判别联合声明每个 type 的 payload/response；调用方统一经 `sendBgMessage(type, payload)`，编译期强制；handler 签名按 type 收窄，禁止 `msg: any`。
- **测试**: 在 router seam 补 sendMessage round-trip 测试（真实 registry + stub chrome)；现有 handler 测试保留。
- **被否决**: ① 保留 toolId 只补 6 处发送点——冗余元数据是 bug 根因，留着可再犯;② type 优先 + toolId 消歧混合模式——调用方需理解两套规则，interface 更宽。
- **落地**: 3 个独立可回滚 commit（①按 type 路由修复 bug,发送方零改动;②类型化迁移;③router 测试 + 死类型清理）。

### D2. 登录策略无状态化(Strong)

- **事实**: 三个策略为 singleton，却把单次登录的 `_rawResponse`/`_rawTokenData` 挂实例字段;`login-lock` 只按 tabId 互斥，跨 tab 并发互相覆盖（latent 竞态，与 v1.2 已修的 ctx 覆盖同源）。raw 数据本来就一直在 auth-flow 手中（`parseLoginResult(result)` 的 `result`),实例字段只是绕行存储。
- **决策**: `AuthContext` 加 `rawResponse?: unknown` 字段；auth-flow 在两个 parse 点统一赋值;script/extension 路径由策略经 ctx 自写。规则:*谁持有 raw 谁写 ctx,auth-flow 只读一次*。从 `LoginStrategy` 接口删除 `getRawTokenData`（唯一消费者是 auth-flow，接口收窄且消灭时序约定）。
- **明确保留**: `ExtensionStrategy.handlers`/`loadPromise` 是跨登录的沙箱加载缓存（已有互斥），非 per-login 状态，不动，并注释防误删。
- **测试**: 新增跨 tab 并发交错回归测试（deferred 关卡，沿用 `ext-op-serialize.test.ts` 模式）——重构前红、重构后绿，作为本次 deepening 的验收标准。
- **被否决**: `parseLoginResult` 改返回 `{tokenData, raw}`——签名涟漪到全部策略与测试，interface 反而变宽。
- **节奏**: 与 D1 同版本。

### D3. Editor Factory:三工具共享 CodeMirror 装配(Worth exploring)

- **事实**: json-format / json-diff / code-beautify 三处各自拼装 CodeMirror（基础扩展、主题 reconfigure 监听、拖拽载入、Mod-Enter 不一致、拖拽校验各异）;`getPositionFromLineCol` 在 `json-format/App.vue` 逐字重复 `shared/json-error-parser.ts` 已有函数。
- **决策**: 新建 `shared/lib/codemirror-editor.ts`,**语言无关**的 `createCodeEditor({ parent, doc?, language?, extraExtensions?, onChange?, onModEnter? })` 返回 `{ view, getText, setText, focus, destroy }`;`language` 为参数（json() 只是传入值之一）,`view` 暴露为逃生舱。主题同步（theme-changed 监听 + reconfigure + destroy 清理）收进内部。拖拽为独立 helper `attachFileDrop(el, { accept, onText })`，与编辑器解耦（拖拽目标常非编辑器）。
- **被否决**: JSON 专用 `createJsonEditor`——code-beautify 被排除，重复只消灭 2/3。
- **节奏**: 一次抽取 + 三处同步迁移，不做半成品（部分迁移 = 两套模式并存，deletion test 不通过）。这是对 ADR-0002「严格伴随式」的有理偏离，特此记档。jsdom + 真实 CodeMirror 测试（已有 `codemirror-fold-placeholder.test.ts` 先例）。

### D4. Login Tab Flow:quick-login 编排收口(Worth exploring，修正版)

- **事实**: 两条 quick-login 路径的 debugRedirect 解析 18 行逐字重复 ×2;但尾部机制**真实不同**——路径 A 为「注入后导航 + 失败回滚（关新 tab，防假登录）」，路径 B 为「create-at-url + setAuth + reload」。
- **决策**: 新建 `login-tab-flow.ts`，四个函数：`parseDebugRedirect`、`resolvePostLoginUrl`（纯函数，即测试面）、`setupAuthTab`（原样搬家）、`injectAndNavigate`（拥有「注入失败必须关 tab 回滚、绝不静默导航」不变量——该不变量此前仅存在于注释）。只碰两条 quick-login 路径；扩展生命周期半边（健康 locking dispatcher）与 `handleSwitchAccount` 不动。
- **被否决**: 单入口 `withAuthTab`（评审初版设想）——两路径机制不同，合并需 mode 参数，interface 更宽更隐晦。按探查证据修正。
- **节奏**: 与 D2 同版本（登录域集中收尾，ADR-0002 附录 A 登录手测矩阵只跑一轮）。

### D5. 配置读路径收口：收窄版(Worth exploring)

- **事实**: 写路径已深(`safeStorageSet` + `updateConfig` 锁与增量合并）。真实缺口仅二:① 4 处工具配置直读(`SwitcherPanel`、`background-handler`、`EnvIndicator`、`json-page-format.content`)绕过 `getConfig` 的迁移;② `getConfig<T>` 裸 `as T`，新增字段不补齐。`tool-state`/`dev-mode`/`logger` 读自有 key 是合法分层，**不收**。
- **决策**: 4 处直读改走 `getConfig` 并传 defaults;`getConfig(toolId, defaults?)` 加可选第二参，传则顶层浅合并返回完整 T，不传保持现状（不开新函数，避免浅 fork)。schema 校验限定为顶层默认值补齐（解决 ADR-0002「新增字段不自动补齐」)；嵌套深校验（zod 等）不做，记 backlog。（实施补充：存储中无任何配置时仍返回 undefined——defaults 只补字段不造配置，保留调用方「未配置」报错分支。account-switch 读取默认值用结构性空值 `{accounts: [], domains: {}}`，不用注册表含示例数据的 defaultConfig。)
- **被否决**: 抽 `watchConfig` helper——`image-base64` 的 `onChanged` 是唯一监听者，一个 adapter 的 seam 是假 seam。
- **节奏**: 独立小 commit，任意版本捎带。

### D6. 样式层收敛：多数决 + 伴随式(Speculative)

- **事实**: 双份命名按类别各有胜负——按钮 `.dt-btn*` 88 处 vs `.btn-primary` 29 处;toggle `.toggle-switch` 13 处 vs `.dt-toggle` 7 处;`.dt-config-group` 全家 0 使用（纯死 CSS)。两套暗色 token 并存(`design-tokens.css` vs `dark-mode.css --dt-dark-*`)。`options/App.vue` View Transition 分支被 `shouldAnimate = false` 永久关闭（死代码）。`use-theme.ts` 两个监听函数近重复。
- **决策**: ① 组件类按类别多数决：按钮迁向 `.dt-btn*`,toggle 保留 `.toggle-switch`（迁 7 处 `.dt-toggle` 后删定义）;② token 权威归 `design-tokens.css`,`dark-mode.css` 退化为全局元素级覆盖层并引用统一 token，伴随式映射;③ 立即删:`.dt-config-group` 死 CSS、View Transition 死分支，合并 `use-theme` 重复监听;④ 组件 `[data-dt-dark]` 覆盖只伴随式上收，不设目标不排期;⑤ 收敛完成时同步更新 CLAUDE.md「组件规范」节。
- **被否决**: 统一命名运动（全部改成 `.dt-*` 或全部保留旧名）——不服从实际使用量，迁移成本换不来收益。
- **节奏**: 严格伴随式（服从 ADR-0002 优先级末位），唯死代码删除立即执行。

## 执行顺序

1. **D1 commit 1** —— 修复线上 bug（扩展市场 6 类操作）
2. **D2 + D4** —— 登录域同版本，手测矩阵一轮
3. **D1 commit 2/3** —— 类型化 + router 测试
4. **D5** —— 独立捎带
5. **D3** —— 专项小任务
6. **D6** —— 死代码立即，其余伴随式

## 明确不做

- 嵌套配置的 schema 深校验（backlog，待实际事故率证明需要）。
- `watchConfig` 监听 helper（待第二个调用方出现）。
- 样式层一次性重写 / 统一命名运动。
- 单入口 `withAuthTab` 合并两条 quick-login 尾部路径。
