# ADR 0002: 优化路线图 —— 稳定性攻坚与体验打磨

- **日期**: 2026-08-12
- **状态**: 已确认方向，待分期实施
- **背景**: 例行版本规划 + 技术体检。对代码库四大领域（登录流程、扩展引擎、存储与 Content Script、标签页工具 UX）做了并行体检，全部结论附 `file:line` 证据，可逐项复核。

## 定位与总原则

1. **用户规模**: 自用 + 几个熟人。不投入分发、新手引导、商店上架方向（与 ADR 0001 的「按可发布标准打磨」不冲突：错误提示、可发现性对内部用户同样是净收益）。
2. **深度优先**: 打磨现有 6 个工具，**不加新工具**。新工具想法记入 backlog，不进入本路线图。
3. **优先级**: 稳定性/健壮性 > UX 细节 > 性能（惯性优化）> 架构（**伴随式重构**：不安排专项，改到哪拆到哪）。
4. **稳定性手段**: 组合方案 —— 关键路径补自动化测试 + 统一错误处理/可观测性 + 发版手动 checklist（附录 A）。

## 体检关键发现汇总

### 登录流程（最高优）

- **并发竞态**: 重复点击账号无防重；多个登录流程共享 `ctx`/`debugBuffer` 互相覆盖；快速登录可开多个标签页互相抢占（`background-handler.ts:123-316`、`SwitcherPanel.vue:165`）。
- **无限挂起**: `fetch` 无超时（`background-handler.ts:183`）；`awaitTabLoaded` 无超时，页面被拦截时「正在登录...」永远转圈（`background-handler.ts:329-339`）。
- **静默失败**: QuickLogin 注入 token 失败被吞掉仍报「登录成功」（`background-handler.ts:558-559, 566-568`）；Generic 策略步骤失败的 `{success:false}` JSON 被当作 tokenData 误判成功（`generic.ts:300-308`）。
- **隐式回退**: `loginMethod` 为空时默认走旧内置 API 登录，配置遗漏时用户只看到「登录失败」（`background-handler.ts:109`）。
- **测试空白**: `runAuthFlow`、`generic-steps` 引擎（9 个 handler）、`parse-text.ts`、`auth-storage.ts` 均无测试。

### 扩展引擎

- **并发**: `ExtensionStrategy` 首次加载无互斥锁，并发登录重复执行沙箱（`extension-adapter.ts:88-100`）；同一扩展安装/更新无串行化（`background-handler.ts:738-768, 814-856`）。
- **回滚缺失**: 本地 reload 先注销策略再注册，中间失败策略丢失（`background-handler.ts:1024-1057`）。
- **存储**: 所有 `chrome.storage.local.set` 未捕获配额异常；LRU 淘汰可能误删在用扩展源码（`utils/script-storage.ts:59-69`）。
- **网络**: git API `fetch` 无超时无重试（`git-loader.ts:106-202`）。
- **测试空白**: 扩展引擎 0 测试覆盖。

### 存储与 Content Script

- **非原子写**: `Config.vue:294-307` 与 `tool-state.ts:31-39` 读-改-写，多开 options 页丢修改。
- **无 schema 校验**: `getConfig<T>` 直接 `as T`（`tool-config.ts:59`），新增字段不自动补齐；导入配置无结构校验（`options/App.vue:107-119`）。
- **前缀不统一**: 扩展 storage `ext-` vs `devtools-ext-` 两套前缀，卸载清理留孤儿数据（`runtime.ts:237` vs `ext-engine/storage.ts:17`，清理只清前者 `git-loader.ts:361`）。
- **SPA 不感知**: 无路由监听，env-indicator 切路由后不更新（`content/index.ts`、`EnvIndicator.ts:36-75`）。
- **消息**: popup `sendMessage` 无错误处理（`popup/App.vue:105-115`）；长流程无 keep-alive，service worker 可能中途终止。

### 工具 UX

- **关键 Bug**: image-base64 的 `imageFormat`/`imageQuality` 配置完全未生效（`image-base64/App.vue:67` 固定 `toDataURL()`）。
- **键盘**: json-format、code-beautify 缺 `Mod-Enter`；popup 无键盘导航。
- **反馈**: 除账号切换外所有配置页保存静默无 Toast；image-base64 在线转换无 loading。
- **下载**: json-format 无「下载完整结果」；code-beautify、image-base64 无下载。
- **暗色遗漏**: ToolMarket 描述、options 副标题、json-format/code-beautify placeholder、image-base64 上传区。
- **一致性**: 4 个标签页工具各自维护一套按钮/空态样式。

## 路线图

### v1.2.0 —— 稳定性攻坚

**P0（小工作量、高风险修复，先做）**

| # | 事项 | 方案 | 工作量 |
|---|---|---|---|
| 1 | 登录/页面加载无限挂起 | `fetch` 加 `AbortController`（默认 15s）；`awaitTabLoaded`/`waitForTabLoad` 加超时并清理 listener | 小 |
| 2 | QuickLogin 静默失败 | `injectAuth` 失败改为记录日志并返回失败（`background-handler.ts:558-559, 566-568`） | 小 |
| 3 | Generic 误判成功 | `generic.ts:300` 解析结果含 `success===false`/`error` 时返回 `null` 触发上层抛错 | 小 |
| 4 | 隐式回退旧 API 登录 | `loginMethod` 为空且无策略参数时返回明确错误「未配置登录策略」（`background-handler.ts:109`） | 小 |
| 5 | ExtensionStrategy 加载互斥 | `loadPromise` 缓存，并发 `buildLogin` 复用同一 Promise（`extension-adapter.ts:88-100`） | 小 |
| 6 | reload 原子回滚 | 先保存源码/注册新策略成功后再注销旧策略，失败回滚（`background-handler.ts:1024-1057`） | 小 |
| 7 | 淘汰保护在用扩展 | LRU 淘汰前跳过「已安装且启用」的扩展（`utils/script-storage.ts:59-69`） | 小 |
| 8 | git fetch 超时重试 | 4 个 fetch 函数加 10s 超时 + 1-2 次指数退避（`git-loader.ts`） | 小 |
| 9 | 日志容量清理 | `devtools-logs` 按条数+总字节+30 天年龄三维清理（`logger.ts:117-123`） | 小 |
| 10 | 扩展 storage 前缀统一 | 统一为 `devtools-ext-{extId}-`，卸载时清全部相关前缀 + 删除废弃 key | 小 |

**P1（中工作量，核心加固）**

| # | 事项 | 方案 | 工作量 |
|---|---|---|---|
| 11 | 登录并发互斥 | 基于 tabId 的 `Map<tabId, Promise>` 锁，同 tab 登录完成前拒绝新请求；面板按钮置灰 + loading | 中 |
| 12 | 安装/更新互斥 | 基于 extId 的内存锁串行化 install/update/reload | 中 |
| 13 | 存储配额异常捕获 | 封装 `safeStorageSet`，捕获 QuotaExceeded 并提示清理；替换所有写入点 | 中 |
| 14 | 存储原子写 | `Config.vue` save 与 `tool-state` 改为「读最新 → 只覆盖本字段 → set」增量合并 | 中 |
| 15 | 错误码体系 | 定义 `RSA_ENCRYPT_ERROR`/`NETWORK_ERROR`/`TAB_RESTRICTED`/`CAPTCHA_REQUIRED` 等；Toast 附「复制详情」；非 dev 模式也记最小失败摘要 | 中 |
| 16 | SPA 路由监听 | content script 拦截 `pushState/replaceState` + `popstate/hashchange`，路由变化重新评估 env-indicator 并清理残留 DOM | 中 |
| 17 | 核心路径测试 | `runAuthFlow` 成功/失败/超时、`generic-steps` 各 handler、`parse-text.ts` 格式分支、`manifest.ts` 校验、`script-storage` 淘汰逻辑；沿用 `vi.stubGlobal('chrome', ...)` 模式 | 中 |

**伴随式重构（在 v1.2 改动中顺带进行）**

- 改登录流程时：从 `background-handler.ts`（1124 行）拆出 `auth-flow.ts`（runAuthFlow + 步骤引擎调用）。
- 改账号配置时：从 `Config.vue`（3238 行）拆出环境/域名管理子组件。

### v1.3.0 —— UX 打磨

**P0（小改动、高感知，先做）**

| # | 事项 | 涉及文件 | 工作量 |
|---|---|---|---|
| 1 | json-format / code-beautify 加 `Mod-Enter` 触发格式化 | `json-format/App.vue:159`、`code-beautify/App.vue:64-83` | 小 |
| 2 | json-format 加「下载完整结果」 | `json-format/App.vue:805,1004` | 小 |
| 3 | 选项页所有配置保存后 Toast 反馈 | 5 个工具的 `Config.vue` | 小 |
| 4 | 暗色遗漏修复（ToolMarket 描述、options 副标题、2 处 placeholder、上传区） | `ToolMarket.vue:186`、`options/App.vue:399` 等 | 小 |
| 5 | json-diff 左右面板空态引导 | `json-diff/App.vue:617-640` | 小 |
| 6 | image-base64 在线转换 loading + 拖拽视觉反馈 | `image-base64/App.vue:46-74,221-243` | 小 |
| 7 | 账号配置域名 URL 格式/重复校验 | `account-switch/Config.vue:340-407` | 小 |
| 8 | code-beautify 拖拽文件导入 + 下载结果 | `code-beautify/App.vue:120-176,206` | 小 |

**P1**

| # | 事项 | 涉及文件 | 工作量 |
|---|---|---|---|
| 9 | image-base64 配置生效（`toDataURL(format, quality)`）+ 下载图片/Base64 | `image-base64/App.vue:29-74` | 中 |
| 10 | popup 键盘导航（↑↓/Enter）+ 快捷键未注册时引导「去设置」 | `popup/App.vue:139-179`、`shared/use-command-shortcut.ts` | 中 |
| 11 | 抽共享 `<DtButton>`/`<DtEmptyState>`/`<DtPanel>`，统一 4 个标签页工具样式 | 4 个工具 App.vue + `shared/component-styles.scss` | 中 |
| 12 | code-beautify 行号 gutter 对齐修复（写死 21.6px 问题） | `code-beautify/App.vue:494` | 小 |

### v1.4.0 —— 性能与工程化（惯性优化，无明确痛点驱动）

| # | 事项 | 说明 | 工作量 |
|---|---|---|---|
| 1 | 大 JSON Web Worker 化 | `chunked-json.ts` 的 `setTimeout(0)` 假异步改为真 Worker，加进度条与取消按钮 | 大 |
| 2 | JSON 树渲染虚拟滚动 | `formatJsonToHtml` 全量 DOM 改为虚拟滚动/分页渲染 | 大 |
| 3 | popup 打开 skeleton | 消除首次白闪（`popup/App.vue:59-77` 串行 await） | 小 |
| 4 | `chrome.storage.get(null)` 收敛 | 5 处全量枚举改为按 key 读取 | 中 |
| 5 | service worker keep-alive | 长流程（登录 pipeline、git 安装）加心跳消息防终止 | 中 |

### v2.0 储备（本轮不决策，记档）

- **账号密码明文存储**: ADR 0001 已记档。内部工具可接受；若上架商店是硬伤。备选：OS keychain 代理、主密码加密、或仅存 session 不存密码。
- **完整错误监控/上报**: ADR 0001 D6 明确不做，v2.0 重新评估。
- **Content Script 全面 Shadow DOM**: env-indicator badge、json-page-format 仍为全局 DOM 注入。
- **商店上架前提**: 密码存储、隐私政策、权限审计。

## 明确不做

- 新工具/新功能方向（backlog 记录，不进路线图）。
- 多步引导、遮罩 walkthrough（延续 ADR 0001 D4）。
- 内容持久化（延续 ADR 0001 D7，「用完即走」）。
- 专门的架构重构专项（只做伴随式重构）。
- 分发/上架/推广相关投入。

## 附录 A：发版手动测试 Checklist

每次发版前按矩阵手测（自动化测试覆盖后逐步缩减）：

**登录流程**
- [ ] 自定义 API 策略登录：虚构本地/测试环境 × 不同账号角色
- [ ] Generic 策略登录（如已配置）
- [ ] 扩展策略登录（历史内置模板）
- [ ] 快速登录：面板触发 / `Alt+Shift+A` / 右键选中文本
- [ ] 失败路径：密码错误、网络断开、受限页面触发快捷键
- [ ] 重复点击账号卡片不重复发请求

**扩展引擎**
- [ ] Git 安装（GitHub + Gitee）、本地目录安装
- [ ] 检查更新、执行更新、reload 本地扩展
- [ ] 卸载后 storage 无残留（`devtools-ext-*`、`ext-settings-*`）
- [ ] 存储用量显示正确

**存储与配置**
- [ ] 选项页修改配置 → 刷新后保留
- [ ] 导出全部配置 → 清空 → 导入恢复
- [ ] 多开 options 页同时修改不丢数据

**Content Script**
- [ ] `Alt+Shift+A` 唤出面板；受限页面通知提示
- [ ] env-indicator 在 SPA 路由切换后正确更新
- [ ] Toast 在亮/暗主题下显示正常

**标签页工具**
- [ ] 各工具格式化/对比/转换主流程
- [ ] 大文件（>1MB JSON）不卡死
- [ ] 右键菜单「选中文本 → JSON 格式化/对比」
- [ ] 标签页复用（重复打开不清空内容，ADR 0001 D3）
