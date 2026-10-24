# ADR-0012: Generic 登录重构 —— 配方（Recipe）与认证快照（AuthSnapshot）

- **日期**: 2026-10-20
- **状态**: 已接受，待实施
- **背景**: generic 策略与共享登录管线的痛点分析确认，根因不是「配置项太多」，而是 ① 引擎假设「已有一个正确的 tab」② 认证生命周期为空 ③ 判定与反馈太弱。本次决策把 generic 从「硬编码 6 阶段的策略」改造为「配方 + 认证快照」两件引擎能力，并锁定技术选型。
- **范围**: `entrypoints/tools/account-switch/` 下的 `strategies/generic*`、`auth-flow.ts`、`login-session.ts`、`login-tab-flow.ts`、`background-handler.ts`、`utils/auth-storage.ts`、`config/DomainsPanel.vue`；旧内置 API 策略仅做协同性修改（见 D17）。
- **关联**: ADR-0003（引擎收口）、ADR-0004（D2 Login Session / D4 Navigation Intent）、ADR-0006（不恢复插件市场）。

---

## 决策清单

### D1. 流程模型：持久化 Recipe，替代硬编码 6 阶段

- **决策**: 引入 `Recipe = { version, steps[], settle, auth, failWhen?, limits? }`，由引擎 `runRecipe()` 按数据执行。`GenericStrategy.buildFlow()` 删除。
- **被否决**: ① 继续硬编码 6 阶段（多步登录结构上无解，P1-14）；② 直接上录制回放（录制器 80% 的价值来自「步骤数组 + 选择器生成」，先做步骤数组，避免为录制重写两次）。
- **后果**: `Recipe` 成为 generic 的唯一事实源；录制器与模板库后续复用同一回放引擎。

### D2. 配方存放位置：`DomainConfig.strategyConfig`

- **决策**: 新增可选字段 `DomainConfig.strategyConfig?: { recipe?: Recipe }`。读取时做 `normalizeRecipe`，非法配方保存时拦截、运行时再兜一层明确错误。
- **被否决**: 塞进 `strategyParams`。该字段是扁平 `Record<string, unknown>`，`DomainsPanel.vue` 按 key 逐个渲染表单，嵌套对象会污染渲染器且无法做结构校验。
- **迁移**: `migrateLegacyParams(strategyParams)` 把既有 8 个扁平参数一次性转成 `Recipe`；`strategyParams` 对 generic 保留只读兼容，UI 不再渲染。

### D3. 元素定位：`Target` 判别联合

```ts
type Target =
  | string                      // 简写 = CSS 选择器（向后兼容）
  | { css: string } | { label: string } | { name: string }
  | { placeholder: string } | { text: string };
```

- **决策**: 页面内执行自包含解析器（可序列化，禁止闭包引用外部变量），优先级 `id/name → aria-label → label 文本 → placeholder → text → 唯一属性组合 → nth-of-type`。
- **被否决**: 只支持 CSS 选择器——这是配置门槛的根源（P2-15），也是录制器价值的 80%。
- **歧义处理**: 多个可见命中时报 `AMBIGUOUS_TARGET`，不静默取第一个。
- **`text` 的匹配口径**（v1.1.4 线上回归）: 比较前去掉**全部空白**（`登 录` 与 `登录` 互认），且
  **精确优先**——有可见的完全相等命中就只用它；一个精确命中都没有（或精确命中全部不可见）时
  才退回子串包含。
  - **Why**: 某登录弹窗有三个页签（`密码登录` / `CA登录` / `短信登录`）与提交
    按钮 `登录`，子串匹配得到 4 个可见元素 → `AMBIGUOUS_TARGET`。页签是导航入口，按钮才是目标，
    这个区分信息本来就在文本里。
  - **退回条件是「精确命中全部不可见」而不是「没有精确命中」**: PC / 移动双布局并存、只显示一套
    的站点里，隐藏那套的按钮文案往往才是精确的；直接报 `ELEMENT_NOT_FOUND` 会误伤。
  - **被否决**: 引入 XPath。`//button[normalize-space(.)='登录']` 解决的是「精确匹配」，不由 XPath
    提供；而 `document.evaluate` 不穿透 shadow root（与 D12 冲突），拾取器也无法稳定生成 XPath
    （把门槛还给用户），且要改 `Target` 联合、三份同源页面内实现与全部 UI。
  - **约束**: 执行器 `byText` 与拾取器 / 识别器的 `countOf` 必须同口径，否则候选胶囊显示「命中
    4 个」而执行成功。一致性由 `tests/generic-target.test.ts`、`tests/target-picker.test.ts` 固化。

### D4. 成功判定：`SettleCondition` + 零配置默认

```ts
type SettleCondition =
  | { type: "formGone" } | { type: "urlChanged" } | { type: "url"; glob: string }
  | { type: "selector"; target: Target } | { type: "cookie"; name: string }
  | { type: "storage"; area: "local" | "session"; key: string }
  | { type: "fixed"; ms: number }
  | { type: "any"; of: SettleCondition[] } | { type: "all"; of: SettleCondition[] };
```

- **决策**: 默认 `{ type: "any", of: [{ type: "formGone" }, { type: "urlChanged" }] }`，用户不填任何东西即可工作；`failWhen` 每个轮询周期与 `settle` 并列检查，命中即早退为 `LOGIN_REJECTED`。
- **被否决**: 「成功判定值」条件必填（P0-2 只是把崩溃变成校验，没解决用户不知道填什么）；仅靠延长超时（P1-12 根因）。
- **验证码**: 内置 `/验证码|captcha|slider/i` 文案识别 → `CAPTCHA_REQUIRED`，`failWhen` 可另行配置选择器。
  扫描口径为**可见叶子文本**：自身与祖先可见、不含元素子节点、且不是可点击入口
  （`a` / `button` / `summary` / `role=button|tab|link` / `cursor:pointer`）。
  - **Why**: 早期用整页 `innerText`，把「邮箱验证码」这类切换标签和隐藏面板里的
    备用表单算成命中。某登录页默认停在账号密码页，但同级 tab
    始终可见，导致**登录成功后仍报 `CAPTCHA_REQUIRED`**。
  - **被否决**: 只看 `.captcha` 之类的类名约定 —— 各站文案千差万别，类名不可枚举。

### D5. 固定等待并入 `waitFor`

- **决策**: 删除 `successType: "timeout"` 分支（现状 `checkWaitCondition` 直接 `return true`，语义是坏的，P0-3），改为步骤 `{ op: "waitFor", when: { type: "fixed", ms } }`，真实 `sleep`。
- **后果**: 「goto 后等 N 毫秒再填」语义明确；不再存在「选了固定等待等于不等待」。

### D6. 认证态：引擎级 `auth-snapshot.ts`

```ts
type AuthSpec =
  | { mode: "page" }
  | { mode: "snapshot"; cookies?: "all" | "none" | string[];
      cookiesClear?: "all" | "none" | string[];
      localStorage?: "all" | string[]; sessionStorage?: "all" | string[] };
```

- **决策**: 新建 `utils/auth-snapshot.ts` 提供 `capture / clear / restore`，generic 只声明 `AuthSpec`；引擎按 `mode` 调用。`LoginStrategy.getCookiesToRemove()` 保留为既有策略的兼容入口，`AuthSpec` 优先。
- **被否决**: 让 generic 自己实现 `injectAuth`——P0-4 的根因是策略层不该拥有 token 生命周期。
- **后果**: 旧 API 策略后续可选迁移到同一组原语，但不在本 ADR 强制范围内。

### D7. 跨 origin 写 storage 的顺序是管线不变量

- **决策**: localStorage/sessionStorage 是 origin 作用域的，必须在对目标 origin 的文档内写入。固化为：

```
create tab @ targetOrigin → waitForTabLoaded → clear → set storage → reload
```

该序列归属 `login-tab-flow`，generic 不得在自己的 `injectAuth(tabId)` 里就地写。
- **被否决**: 策略自行挑选 tab 写入——写进 login origin 的 storage 等于没写。
- **后果**: 写入 `login-tab-flow.ts` 的头注释与 `CONTEXT.md`，作为后续策略的硬约束。

### D8. Cookie 清理：`cookiesClear` 三态

- **决策**: `"all"` = 清除精确 host 的全部 cookie（可选含父域，UI 明示风险）；`"none"` = 不清；`string[]` = 白名单。默认 `"all"`（仅精确 host）。
- **被否决**: 维持 `getCookiesToRemove()` 白名单作为 generic 的唯一清理方式——generic 没有已知 auth key 列表，白名单等于不清（P0-6）。

### D9. 执行 tab：`execTarget` 判别联合，建 tab 在 ctx 之前

```ts
type ExecTarget = { kind: "existing"; tabId: number } | { kind: "new"; url: string };
```

- **决策**: `prepareLogin` 入参 `execTabId: number` 改为 `execTarget: ExecTarget`；`kind: "new"` 时**先创建 tab（`active: false`）并等待加载，再构建 ctx**。新 tab 同时加入登录互斥锁的键集合。
- **不变量**: 登录过程中创建的 tab，在流程失败时必须关闭（与 `injectAndNavigate` 的「注入失败关 tab 回滚」同族）。
- **复用**: 新 tab 路径的尾部 `setupAuthTab` 改为**复用**已创建的 tab（navigate + reload），不再二次 `tabs.create`，顺带修掉双 tab。
- **被否决**: 在 `handleNavigate` 内懒建 tab——`clearCookies`/`clearStorage` 等前置步骤仍会跑在错误上下文（review 原文已判定）；`ensureTab` 懒加载会让 ctx.tabId 变成可空类型，污染全链路。

### D10. `afterLogin` 的执行权按入口切换

- **决策**: `runAuthFlow(ctx, strategy, { afterLogin?: "execute" | "collect" | "skip" })`，默认 `"execute"` 保持既有语义。
  - `"execute"`（`SWITCH_ACCOUNT`）：引擎照旧调用 `afterLogin` 并 `applyNavigationIntent`。
  - `"collect"`（两条 quick-login）：引擎调用 `afterLogin` 但**不执行**，把 `NavigationIntent` 挂在返回值的 `navigationIntent` 上；handler 交给 `injectAndNavigate` 作为「无明确目标 URL 时的 fallback」。
  - `"skip"`：完全不调用。
- **被否决**: 简单布尔 `runAfterLogin` —— 会让旧 API 策略的 `?redirect=` 引导在 `hasUrl === false` 的快捷登录下丢失（该场景此前由 `afterLogin` 导航生效，尾部仅补一次 reload）。
- **被否决**: 各策略自行判断入口——双 reload / 双开 tab 是管线问题（P0-5）。
- **后果**: 导航的唯一执行点仍是 `login-tab-flow`；策略的「去哪」决策被保留而不是丢弃。
- **后续（issue 12 / ADR-0015 D12）**: `runAuthFlow` 与 `afterLogin` 阶段已随单一 spec 执行器删除。账号切换的等价行为由 `login-tab-flow.refreshAfterSwitch` 承接（`?redirect=` 优先、否则原地刷新）；快捷登录的「收集但不执行」语义由尾部 `injectAndNavigate` / `setupAuthTab` 的落地推导承接。本条的「按入口区分尾部动作」意图不变，载体已换。

### D11. 步骤脚本契约：返回结构化对象

- **决策**: `executeLoginScript` 返回 `{ success: boolean; tokenData?: TokenData; error?: string }`；失败时抛 `LoginError` 以保留 `errorCode`。`parseLoginResult` 只做解包，不再靠 JSON 字符串反解。
- **事实**: 现状返回 `{ success: true, tokenData: <extract 输出> }` 后由 `parseLoginResult` 原样透传，导致 `ctx.tokenData` 多套一层壳，`loginResult.data` 恒真，提取失败不可观测。
- **被否决**: 维持字符串契约——错误信息与 errorCode 在序列化边界丢失。

### D12. iframe / Shadow DOM

- **决策**: 所有 DOM 步骤使用 `executeScript({ target: { tabId, allFrames: true } })`，按 frame 返回命中结果，取第一个「可见且唯一」的命中；Shadow DOM 走递归 `open` shadowRoot 深查询。
- **被否决**: 只处理主文档（P1-9 永远找不到元素）。

### D13. 可观测性

- **决策**: `DebugLogEntry` 新增 `recipeSteps?: RecipeStepTrace[]`（`op / index / target / duration / status / errorCode`）；新增错误码 `ELEMENT_NOT_FOUND`、`AMBIGUOUS_TARGET`、`FRAME_NOT_FOUND`、`SUCCESS_CONDITION_UNMET`、`LOGIN_REJECTED`、`SELECTOR_INVALID`。
- **被否决**: 只扩展现有 6 个 `AuthStep`——定位不到「第几步哪个选择器失败」（P2-17/18）。

### D14. 选择器拾取器

- **决策**: options 页注入 hover 高亮 + 点击拾取（普通 `executeScript`，不用 CDP），产物是 `Target` 而非裸 CSS 字符串，并记录 `frameId`。
- **被否决**: `chrome.debugger` / CDP 真实事件——常驻调试黄条对日常开发工具成本过高，仅作为遇到 `isTrusted` 校验时的可选增强（不在本 ADR 范围）。

### D15. 配方分发

- **决策**: v1 不做导入导出、不做市场、不做用户自录制。
- **理由**: ADR-0006 已移除插件市场；`script` 步骤是 MAIN world 任意 JS，配方可分享 = 任意代码执行。内部作者工具产出的配方经人工审阅后**内置**分发。

### D16. 长期方向

- **决策**: 少量固定环境 → 做配方库；确需覆盖任意站点 → 再上录制器，复用同一套 `Recipe` 回放引擎。
- **被否决**: 先做录制器再定义数据模型——顺序反了会重写两次。

### D17. 旧 API 策略的协同修改（结论：需要，但只动三处）

- **决策**: 旧 API 策略的登录路径（`buildLogin` 请求）**不变**，需配合管线改造三处：
  1. **`runAfterLogin`**：快速登录入口下 `afterLogin` 不再执行（D10）。这是修复 P0-5「reload 与 injectAuth 抢跑」的直接手段，对旧 API 策略是行为修正而非回归。
  2. **`execTarget`**：新 tab 路径下 ctx.tabId 变为真实 id，`getPageLanguage()` 与 `setAuth()` 的 tab 注入从「静默跳过」变为真实执行——需回归验证；尾部 `setupAuthTab` 复用同一 tab，禁止二次 `create`。
  3. **Cookie 清理**：保持原有清理白名单不变；`AuthSpec` 只对 generic 生效，引擎按策略是否声明 `AuthSpec` 分流。
- **明确不做**: 把旧 API 策略迁移到 `auth-snapshot`（可选后续优化，收益是删掉一份重复的 cookie/storage 写入代码，但会扩大本轮回归面）。

---

### D18. 复用 tab 的尾部：同 URL 不导航，激活延后到刷新之后（v1.1.4 线上回归）

- **事实**: D9 把尾部 `setupAuthTab` 从「新建 tab」机械替换为「复用 tab」，但把 D7 的序列一并搬了过来：`tabs.update({ url: createUrl, active: true })` → `clear` → `setAuth` → `reload`。D7 的序列成立的前提是「tab 还没到目标 URL」；D9 之后 tab 由 prelude 建在同一个 URL 上并已加载完成，于是：
  1. `update(:同 URL)` 是一次多余的整页加载，且它同时把 tab 切到前台——用户第一次看见这个 tab 就是这次白屏；
  2. `clearAuth` 把 `runAuthFlow` 刚在同一文档写好的 storage 删掉再写一遍（纯重复劳动）；
  3. `reload` 再整页加载一次。重型 SPA两次冷启动叠加即「先白屏一下」。
- **决策**: 复用路径（传入 `execTab`）改为：
  ```
  (URL 不同时才 update + wait) → clear → restore → setAuth → reload(后台) → activate
  ```
  - **同 URL 不导航**：地址相同即跳过 `tabs.update`；地址不同（debugRedirect 换 origin、页面 boot 时自行跳走）仍导航。用 `pendingUrl || url` 精确比较，宁可多导航一次也不写错 origin。
  - **不带 `active`**：导航/激活是「给用户看」的动作，不再和加载绑定。
  - **激活延后**：刷新改为 `reloadTabAndWait`（监听先于 `reload()` 注册，只认刷新后的 `complete`），完成后才 `tabs.update({ active: true })`。
- **不变**: D7 的**写入顺序**与「storage 必须在目标 origin 文档内写」不变量原样保留；新建 tab 路径（未传 `execTab`）行为完全不变。`clear` / `setAuth` 保留——generic 快照模式的 `steps` 不含 `clearStorage`，这里是它唯一的清理点。
- **失败语义**: 刷新等待超时 / 受限页面**不判登录失败**（刷新已发起，页面慢不该把成功判死），到点直接激活；仅 tab 被关闭（`TAB_CLOSED`）向上抛，由 handler 走既有回滚。
- **被否决**: 删除 `reload` —— SPA 在注入前已完成 boot，不重启读不到新 token；`reload` 是唯一必要的刷新，只是不该被用户看见。

---

## 后果

- **收益**: generic 支持多步登录；成功判定零配置可用且失败可区分；跨 origin 调试跳转真正成立；换号不再残留旧会话；调试日志可定位到配方步骤。
- **成本**: 新增 3 个 module（`generic-recipe` / `generic-target` / `auth-snapshot`）与 1 个组件（`RecipeEditor`）；`DomainsPanel` 的 generic 分支重写。
- **兼容**: 既有 generic 配置经 `migrateLegacyParams` 自动转 Recipe，行为对齐当前 6 阶段语义；旧 API 登录配置零改动。

## 明确不做（本轮）

- 录制回放器、配方导入导出、插件市场。
- `chrome.debugger` / CDP 真实事件。
- tab 级多账号同时在线（SessionShift 路线，与需求无关）。
- 旧 API 策略迁移到 `auth-snapshot`。

## 验证

- 单元：`tests/generic-recipe.test.ts`（迁移矩阵）、`tests/generic-target.test.ts`、`tests/auth-snapshot.test.ts`、`tests/generic-strategy.test.ts`（重写为配方执行）、`tests/login-session.test.ts`（execTarget 两态）、`tests/login-tab-flow.test.ts`（复用 tab + 失败关闭）、`tests/auth-flow.test.ts`（runAfterLogin 开关）。
- 手测：使用本地虚构页面覆盖三条登录入口、会话恢复与失败反馈。
- 全程 `npm run check` + `npm test` 保绿。
