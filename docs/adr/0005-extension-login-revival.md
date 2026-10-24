# ADR 0005: 修活扩展登录垂直链路 —— 判别联合、SW 恢复与活契约

- **日期**: 2026-08-14
- **状态**: 已废弃（2026-08-17，由 ADR-0006 替代）。整个扩展引擎已随插件市场移除，本文档中的决策（判别联合、SW 恢复、声明式导航等）不再适用。保留作为历史决策记录。
- **背景**: 第三轮架构评审（4 路并行探查，37 条发现归并 11 候选）的 Top 候选。事实核查确认：「扩展即登录策略」链路自引入提交 `3fd7e45`（2026-06-12）起**端到端从未工作过**——`buildLogin` 返回 `about:blank` 占位、引擎 fetch 必抛、`parseLoginResult` 恒 null、`ctx.tokenData` 从不设置（setAuth/afterLogin 空转）、策略注册表为纯内存 Map 无 SW 恢复、`initializeBuiltin` 从不注册策略、options 页读自己上下文的注册表导致 UI 选不中扩展策略——共四类断点；且 `stateless-login-strategies.test.ts:202` 以「不断言整体成败」的注释把断裂钉成了规格（ADR-0003 D1 教训的重演：测试跨过的 seam 不是生产跨过的 seam）。原始产品意图是 Git 去中心化扩展管理。经决策树（10 项决策）确认修活。术语遵循 `CONTEXT.md` 与 deep-module 词汇。

## 决策清单

### D1. buildLogin 返回判别联合（Q5）

- **决策**: `buildLogin` 返回 `{ kind:'request', url, options } | { kind:'performed', tokenData }`。引擎（auth-flow）按 `kind` 分支：`request` 维持「fetch → parseLoginResult」；`performed` 跳过 fetch/parse，直接以 `tokenData` 设置 `ctx.tokenData` 驱动后续步骤（补齐第四个断点）。旧内置 API 策略与 generic 改返回 `kind:'request'`。`parseLoginResult` 暂保留为接口必需（performed 路径不调用，注释如实说明）。
- **被否决**: 策略声明 `executionMode` 判别、interface 分裂为 RequestStrategy | PerformingStrategy——类型最纯净，但当前只有一族 performed 策略，为一个 adapter 分裂 interface 是投机容量；第三族策略出现时再升级。
- **被否决**: 引擎嗅探 `performLogin` 方法存在性——与 ADR-0004 D4 删除的 `instanceof ExtensionStrategy` 特判同味。
- **同刀清除**: 沙箱契约删 `onLogout` / `onResolve`（注册即死，从无 fire 点）与 manifest `scripts[].event` / `match` 字段（validateManifest 强制校验但运行时无消费者，loadExtensionScripts 从不按之过滤）。

### D2. SW 启动 eager 恢复策略注册表（Q2）

- **决策**: Extension Service 新增 `restoreStrategies()`：读 installed 注册表 + script-storage，重建全部已启用扩展的策略注册（含 builtin）。background.ts 启动钩子调用（与 `runExtensionStorageMigration` 同位置）；`initializeBuiltin` 同步注册策略。MV3 SW 30s 回收后注册表随启动重建。
- **被否决**: Lazy（prepareLogin 按需 ensure）——login-session 保持「解析即得」心智，不引入隐藏异步依赖；恢复数据全在本地存储，eager 成本极低。

### D3. options 策略下拉直读派生（Q3）

- **决策**: DomainsPanel 认证方式下拉 = 内置策略（getStrategyDefinitions）∪ installed 注册表派生（已安装且已启用的扩展，name/icon 从 manifest 派生）。零新消息类型，维持 ADR-0003/0004 双轨（options 直读 ext-engine 存储）。
- **被否决**: 新增 `LIST_LOGIN_STRATEGIES` 查询消息——ADR-0003 D1 已否决的方向。

### D4. 端到端测试只 stub chrome.*（Q4）

- **决策**: 验收测试加载 `templates/custom-api-login` **真实源码**（真实 manifest + 真实脚本 + 真实 runtime 沙箱 + 真实 runAuthFlow），只 stub chrome.tabs/scripting/storage，断言 prepareLogin → token 回写全链路。红→绿即本轮验收标准。
- **被否决**: 内存 fixture / 替换 executor——fixture 是第二份契约（fixture 能跑 ≠ 真实模板能跑）；runtime 只有一个生产实现，executor seam 是假 seam。

### D5. 补全自定义 API 登录扩展示例（Q6）

- **决策**: 修复 `templates/custom-api-login/src/login.js`：内联 jsencrypt（minified ≈26KB + 登录逻辑 ≈8KB < source-pipeline 50KB/入口限制，沙箱无外部依赖故必须 vendor）；移除 `chrome.tabs.update`（违反沙箱无 chrome.* 约束），导航改走 D6 声明式契约。该扩展与原生 API 策略功能 parity，作为「扩展机制可复现原生策略」的活示例。
- **同刀删除**: `templates/oauth2-login`（多处直用 chrome.tabs.*，沙箱物理不可运行，未注册，纯死重）、`templates/example-basic`（教学价值被真实契约取代）。OAuth 场景待真实需求出现时按 D1/D6 契约重写。

### D6. onAfterLogin 声明式导航映射（Q7）

- **决策**: 扩展 `onAfterLogin` 返回声明式导航数据（`{ navigateTo?: string }`），ExtensionStrategy.afterLogin 将其翻译为 Navigation Intent（ADR-0004 D4），由 Login Tab Flow 执行。**安全约束：只允许 same-origin 相对路径**，绝对 URL / 跨 origin 一律拒绝并记日志。沙箱脚本永远碰不到 chrome.tabs。
- **被否决**: 扩展一律 `{action:'none'}`——模板 manifest 已发布 `autoNavigate` 设置，且「扩展决定登录后去哪」是真实需求（OAuth 回调场景）。

### D7. 卸载悬空引用走登录时报错（Q8）

- **决策**: 卸载/禁用扩展后，domain 配置的 `loginMethod` 悬空引用落入 prepareLogin 既有的「未配置策略」显式报错路径（ADR-0004 D2），报错文案区分「策略已卸载或未启用」。卸载路径不加拦截。
- **被否决**: 卸载时扫描 domain 引用并拦截/降级——给 Extension Service 加 tool 配置的反向依赖，破坏 ADR-0004 D1 依赖方向。

### D8. 契约文档化（Q10）

- **决策**: 写 `docs/extension-development-guide.md` 最小指南（manifest 契约 + 沙箱五类注入 API + onLogin/onAfterLogin + 声明式导航 + settings 声明），修 `templates/README.md` 的 dead link。指南写不明白的地方即 interface 未收干净的地方，作为契约设计的检验手段。

### D9. authStorage 声明式 token 回写（实施中发现的第五断点，Q11 补问确认）

- **事实（实施中发现）**: 即使 D1 补上 `ctx.tokenData`，ExtensionStrategy 的 `setAuth`/`injectAuth` 均未实现，token 永远写不进页面——沙箱碰不到 `chrome.scripting`，这是 grilling 阶段未点破的第五个断点。
- **决策**: manifest 新增可选 `authStorage` 声明：`cookies`（name/value/expiresPath）与 `localStorage`（key/value）；value 规则 `$json`（整个 tokenData）/ `$.path`（路径取值）/ 字面量。ExtensionStrategy 通用实现 `setAuth`/`injectAuth` 按声明回写（`setCookie` + 新增 `injectStorageEntries` 通用 helper）。与 D6 同哲学：**扩展只声明，宿主执行**。`validateManifest` 校验形状。
- **被否决**: onLogin 结果携带 authWrites（运行时数据，校验与文档化更难）；新增 onSetAuth 事件（与删死事件方向相悖）。
- **附带**: jsencrypt.min.js（60KB）超 source-pipeline 50KB 入口限制——不松动既有不变量，改从 jsencrypt 的 jsbn/rsa/base64 模块 esbuild 按需打包 27KB 迷你 vendor（`templates/custom-api-login/src/vendor-rsa.js`），并修复 jsbn rng 在 SW 无 window 时静默退化 Math.random 的隐患（改 crypto.getRandomValues）。正确性由 E2E 交叉验证：node:crypto 生成密钥对 + 完整 jsencrypt 私钥解密请求体。多入口共享 globalThis 的 vendor 挂载模式写入开发指南。

## 落地 commit 序列

1. E2E 红测试（真实模板源码，钉全链路契约）
2. D1 判别联合 + 死事件/死字段清除 + 假测试改钉契约
3. D6 声明式导航映射
4. D2 restoreStrategies + 启动钩子 + builtin 同步注册
5. D5 补全模板 → E2E 转绿（含死模板删除）
6. D3 + D7 UI 派生与报错文案
7. D8 指南 + README 修复

## 验证

全程 `npm run check` + 既有测试套件保绿；E2E 红→绿为验收标准；收尾跑 ADR-0002 附录 A 手测矩阵，首次勾选「扩展策略登录」。

## 明确不做

- LoginStrategy interface 按 executionMode 分裂（待第三族策略出现）。
- onLogout / onResolve 的激活（当前无消费者，删除；真实需求出现时按新契约重设计）。
- OAuth2 登录扩展（模板已删，需求出现时按新契约重写）。
- 卸载时拦截/降级 domain 引用（D7 已否决）。
- 扩展市场的用户可见面调整（维持开发者模式彩蛋入口，本轮不推广）。
