# ADR 0004: 第二轮深化决策 —— Extension Service、Login Session 与五个 module 收口

- **日期**: 2026-08-14
- **状态**: 已实施（D7 → D4 → D2 → D1 → D6 → D3 → D5 全部落地，各有独立 commit）
- **背景**: ADR-0003 落地后的全量代码架构审查(~30.6k 行，4 路并行探查),产出 7 个 deepening 候选，逐棵决策树与负责人确认。术语遵循 `CONTEXT.md` 与 deep-module 词汇。执行形态沿用 ADR-0003 先例：专项深化轮 + 独立可回滚 commit 序列（对 ADR-0002「严格伴随式」的第二次有理偏离，记档）。

## 决策清单

### D1. Extension Service:ext-engine 唯一出口(Strong)

- **事实**: `background-handler.ts:515-862` import 10 个 ext-engine 内部函数，既是 message adapter 又是生命周期编排器；「安装/更新扩展」概念跨 8 个文件(~400 行编排);扩展 UI 直读 3 个内部 module(`getInstalledExtensions`/`readExtensionSettings`/`getExtensionSource` + 例外的 `setExtensionEnabled` 直写);「加载 ExtensionSource」有三份近似实现(`git-loader` 有重试/校验、`builtin-loader` 无校验无大小限制、两个 Vue 组件内逐字复制的目录遍历)。
- **决策**: 新建 `ext-engine/extension-service.ts` facade,interface = install · update · uninstall · reload · enable · list + readSettings · getSource。**双轨调用**:变更维持走 Message Protocol(注册表/沙箱在 background 内存),options 页读取直调 facade(与 ADR-0003「查询消息类型废弃、直读存储」决策一致，只是收敛为直读 1 个 facade)。`setExtensionEnabled` 收编进 service。三个 source loader 收编为内部 adapter，共享「manifest 校验 + 文件集装配」管道;builtin 路径顺带补校验与大小限制;本地目录遍历下沉为 `readLocalExtension(dirHandle)` lib,Vue 组件只保留 `showDirectoryPicker` 调用。`extensionOpLock` 收进 service 内部,`keyed-lock.ts` 删除。
- **测试**: service seam 单测(stub storage/network adapter),补 ADR-0002 记录的引擎测试空白。
- **被否决**: UI 读写全部走消息——推翻 ADR-0003 已落地的废弃决策，新增 3-4 个查询消息类型换不来收益。

### D2. login-session.ts:prelude + AuthSession 合一(Strong)

- **事实**: 三条登录入口(`background-handler.ts:104-195, 245-378, 386-513`)各自重排同段 prelude(lock→config→domain→strategy→ctx,~270 行重复);`AuthSession` 只被 handler 使用却寄居 `debug-log.ts:209-292`;`login-lock.ts`(39 行)单消费者、`keyed-lock.ts`(49 行)单实例，deletion test 均通过。
- **决策**: 新建 `login-session.ts`:按 tab 登录互斥锁(内化 login-lock)+ 配置/domain/策略解析(含「未配置策略」显式报错)+ ctx 构建 + AuthSession 生命周期(从 debug-log.ts 迁入,debug-log 回归纯日志存储)。三条 handler 缩为 `prepare → 各自尾部 → finalize`。删 `login-lock.ts`(`LOGIN_BUSY_ERROR` 挪 `error-codes.ts`)、删 `keyed-lock.ts`(随 D1 收编);两个 lock 的既有测试改写到新 seam。
- **维持**: ADR-0003 D4——两条 quick-login 尾部机制不合井，本决策只收 prelude。

### D3. json-format:四 lib module 下沉(Strong)

- **事实**: `json-format/App.vue`(1688 行)困着树节点 CRUD(451-687)、搜索(366-449)、pathToLanguage(691-784)、doFormat 编排(236-307)、错误 Decoration(103-140);最深的 `json-formatter.ts`(449)/`json-utils.ts`(282) 零测试;`lintJson` 是 `parseJsonError` 的严格子集且单消费者。
- **决策**: 抽 `tools/json-formatter/lib/` 四 module——json-tree / json-search / json-path / format-pipeline，纯函数接口，全配单测;删 `lintJson` 统一走 `parseJsonError`;错误 Decoration 抽成 `shared/lib` 的 CodeMirror 扩展工厂(Editor Factory 邻居,json-diff 后续可复用)。
- **明确不做**: `json-formatter.ts`/`json-utils.ts` 全量测试回填——记 backlog，不为本轮目标。

### D4. 导航意图:Login Strategy interface 收窄(Worth exploring)

- **事实**: `generic.ts:322-327` 与旧内置 API 策略在 afterLogin 直接 `chrome.tabs.update/reload`;`auth-flow.ts:248-260` 用 `instanceof ExtensionStrategy` 特判防 onAfterLogin 双发——但 `ctx.extensionHandlers` **全仓库无赋值点**(types.ts:98 声明、auth-flow 读取、从未写入),该分支与 instanceof 守卫均为死代码。
- **决策**: afterLogin 改为返回声明式导航意图 `{action:'navigate',url} | {action:'reload'} | {action:'none'}`;ctx 增加 `currentTabUrl`(由调用方注入,旧 API 策略的 redirect 参数判断纯化);`login-tab-flow.ts` 加 `applyNavigationIntent` 统一执行(tab 变更唯一 owner)。删除 `ctx.extensionHandlers` 分支、instanceof 特判与类型字段;`ExtensionStrategy` 保持自行触发扩展事件(沙箱契约，非导航)。
- **收益**: 策略单测不再 stub chrome.tabs;「实现接口即可」契约恢复。

### D5. 日志统一:logger 唯一存储 + DevLogsViewer 唯一查看器(Worth exploring)

- **事实**: 「登录日志」两套 interface(DebugLogEntry vs LogEntry+AuthExtraData)、两个存储 module、两个查看器共 2257 行。关键发现:logger 的 `auth` 类别**零生产写入方**,DevLogsViewer 的 auth 渲染(~400 行,265-299/539-592)渲染永不到来的数据——一次做了一半的迁移。
- **决策**: 完成半成品迁移。`debug-log.ts` 的 `logEntry()` 改为 adapter:DebugLogEntry 写入 logger `auth` 类别，步骤/请求响应进 `extra`;`DebugBuffer`/`DebugAuthContext`(在途形状)保留。DevLogsViewer 成唯一查看器;删 `DebugLogViewer.vue`(806 行),account-switch 调试入口改为内嵌/跳转。旧存储 key 数据放弃迁移(内部工具)。DebugLogViewer 的 unmount 清空行为直接丢弃。
- **被否决**: 反向统一(删 logger auth 类别)——永远保留两个存储两个查看器。

### D6. Account View Model(Worth exploring)

- **事实**: Config.vue 与 SwitcherPanel 各实现一遍三段过滤、密码回退优先级、角色色;SwitcherPanel 的 `role?` 兼容归一化(adapter)放错位置;ROLE_COLORS 双份。
- **决策**: 新建 `tools/account-switch/account-view.ts` 纯函数 module:`normalizeAccount` / `filterAccounts` / `resolvePassword` / `roleColor`。Config.vue 的 matrix/list 视图与设置卡片拆分**不进本轮**,保持伴随式。

### D7. 绕行 seam 收编清单(Speculative)

- **决策**: ① 5 处内联 `navigator.clipboard` 迁移到 `shared/clipboard.ts`(它有 execCommand 降级，内联调用反而丢了降级);② image-base64 自实现拖拽(40 行)换 `attachFileDrop`;③ 抽 `shared/content-theme.ts`(read/listen/apply `data-dt-dark`),两个 content script 共用;④ `content/index.ts:114` 裸 onMessage 纳入 ContentMessageMap 类型 seam。
- **明确不做**: json-page-format 的 vanilla toast(10 行，非 Vue 栈);Dt* 组件在 account-switch UI 的采用(伴随式)。

## 执行顺序

1. **D7**(4 个独立小 commit,清场)
2. **D4** —— 登录域第一刀，最小
3. **D2** —— handler 登录半边收口
4. **D1** —— handler 扩展半边收口，本轮最大块
5. **D6** —— 登录域 UI 侧收尾
6. **D3** —— 独立域
7. **D5** —— 独立域

D2/D4/D6 + D1 落地后跑一轮 ADR-0002 附录 A 登录 + 扩展引擎手测矩阵(只跑一轮);D3/D5/D7 各自域内验证。全程 `npm run check` + 既有测试套件保绿，新 seam 配新测试。

## 明确不做

- json-formatter / json-utils 全量测试回填(backlog)。
- json-page-format vanilla toast;Dt* 专项采用;Config.vue 组件拆分专项(均伴随式)。
- 存储分层合并(维持 ADR-0003 D5「合法分层，不收」)。
- UI 读取改走消息(维持 ADR-0003 废弃决策)。
