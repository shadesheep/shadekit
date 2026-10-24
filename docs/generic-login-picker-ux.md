# 通用登录 · 选择器拾取器与填写体验优化（设计稿）

- **日期**: 2026-10-21
- **状态**: 已实施（批次 0 / 1 / 2 / 3 全部落地）
- **范围**: `entrypoints/tools/account-switch/config/`（`RecipeEditor.vue` / `recipe-editor-model.ts` / `target-picker.ts`）与配套的 `strategies/generic-*`
- **结论一句话**: 拾取器“能拾到”，但拾完不知道结果、切不回配置页、失败全静默；填写要求用户先理解配方模型。
  两处都不是缺功能，而是缺**闭环**与**默认答案**。
- **关联**: ADR-0012（D3 Target / D12 跨 frame / D14 拾取器 / D15 不分发）；[ADR-0013](./adr/0013-generic-login-picker-ux.md)（本文的决策化落地）；ADR-0007（配置套件）

> 本文细化「拾取器 + 配置校验」的设计，决策与被否决项已固化在
> [ADR-0013](./adr/0013-generic-login-picker-ux.md)，实施批次见该 ADR 末节。

---

## 1. 现状审计

### 1.1 拾取器

| # | 问题 | 证据 | 用户观感 |
|---|------|------|----------|
| P-1 | 拾取结束不切回配置页 | `target-picker.ts:394-401` 只把目标页置为 active，`RecipeEditor.vue:151-170` 结束后无恢复 | 点完元素后停在目标页，看不到结果，手动切回 |
| P-2 | 失败被吞成「取消」 | `RecipeEditor.vue:159` 对 `cancelled` 直接 return；而 `target-picker.ts:390`（无可拾取标签页）、`:435`（超时）都以 `cancelled: true` 返回 | 点了没反应，没有任何提示 |
| P-3 | 注入失败静默轮询 60 秒 | `target-picker.ts:328-339` 捕获异常返回 `[]` → 轮询循环永远看不到状态 → 60 秒后报「拾取超时」 | 受限页面（chrome://、PDF、商店页）上干等一分钟 |
| P-4 | 「未开始」与「Esc 取消」不可区分 | `target-picker.ts:161-163`：无会话时返回 `cancelled` | 页面导航/刷新导致会话丢失，被误报为用户取消 |
| P-5 | 悬停只有高亮，没有预览 | `target-picker.ts:267-275` 只设置 `outline` | 点之前不知道会生成 `#id` 还是 `nth-of-type` 路径，也不知道会命中几个 |
| P-6 | 只产出一个候选 | `pickTargetFromElement` / `describe` 按优先级返回首个可用 | `#username`、`name=user`、`label「用户名」` 稳定性不同，用户没得选 |
| P-7 | 只覆盖 fill / click | `RecipeEditor.vue:309`、`:341`；`waitFor`（`:358-382`）、成功判定（`:462-477`）、失败判定（`:491-507`）、`extract` DOM key（`:396-402`）全是裸输入框 | 同一套 `Target` 语义，四处要手写 CSS |
| P-8 | 主 frame 也记录 `frameUrl` | `RecipeEditor.vue:162-166` 无条件写入；`generic-dom.ts:75` 用 `url === scope.frameUrl` 精确比较 | SPA 路由 / query 变化后报 `FRAME_NOT_FOUND`，提示「请重新拾取」却无处重拾 |
| P-9 | 拾取不校验元素类型 | 无 | 给「点击」拾取 `<div>`、给「填充」拾取 `<button>` 都能保存，执行时才炸 |

### 1.2 填写

| # | 问题 | 证据 | 用户观感 |
|---|------|------|----------|
| F-1 | 空配方三个空定位 | `recipe-editor-model.ts:499-510` | 用户必须自己推出「登录 = 填两个框 + 点一次」 |
| F-2 | 变量是隐藏知识 | `{username}` / `{password}` 只写在 placeholder；`{origin}` / `{apiBase}` / `{debugRedirect}` / `{step.*}` 完全不可见（`generic-runner.ts:58-87`） | 只会照抄，遇到跨域/多步就卡住 |
| F-3 | 试跑是整条配方 | `RecipeEditor.vue:197-221`；`click` 永远 `skipped`（`generic-dry-run.ts:29`、`:106-110`） | 改第 3 步要从头跑，且拿不到点击是否命中 |
| F-4 | 切换 op 丢内容 | `RecipeEditor.vue:117-119` 整步替换为 `createStep(op)` | 手滑选错 op，已填定位全没 |
| F-5 | 插入位置隐式 | `RecipeEditor.vue:114` 固定插在倒数第二步 | 无法预测，多步登录时反复上下移 |
| F-6 | 不能复制步骤 | 无 | 两步登录里「同种 fill 再来一次」是高频操作 |

---

## 2. 设计目标与约束

**目标**

1. 拾取一次 = 一个完整回合：切过去 → 看到将得到什么 → 点一下 → 切回来 → 看到结果与命中情况。
2. 常见单步登录表单，用户**只需点两次**（识别表单 → 确认），不需要理解 `Recipe`。
3. 任何失败都必须落到**行内、可操作**的位置（重拾 / 重跑本步），而不是只留一句 Toast。

**约束（来自 ADR-0012，不得突破）**

- 不使用 `chrome.debugger` / CDP（D14 已否决）。
- 不做录制回放、不做配方导入导出（D15、D16）。
- `Recipe` 仍是唯一事实源；新增的「简易模式」只能是**视图投影**，不得引入第二套存储结构。
- `pickerInPage` / `domActionInPage` 之类的注入函数必须自包含（禁止闭包引用模块级标识符）。

---

## 3. 拾取器设计

### D1. `PickResult` 改为四态

```ts
export type PickResult =
  | { status: "picked"; target: Target; candidates: TargetCandidate[];
      frameId?: number; frameUrl?: string; meta: ElementMeta }
  | { status: "cancelled" }            // 用户 Esc
  | { status: "lost"; message: string } // 页面导航 / 会话被替换
  | { status: "error"; message: string; code: PickErrorCode };
```

- 页面内状态由 `"active" | "picked" | "cancelled"` 扩展为 `"active" | "picked" | "cancelled" | "idle"`，
  `idle` 表示「没有会话」（`target-picker.ts:161-163` 目前返回 `cancelled`，即 P-4 的根因）。
- `error.code`：`NO_TAB` / `INJECT_FAILED` / `TIMEOUT`。`INJECT_FAILED` 直接把页面的注入异常
  透出（P-3），并提示「该页面不允许注入脚本，请换一个标签页或手动填写定位」。
- 轮询循环中若连续 3 次拿到 `idle`，提前判 `lost`，不再等满 60 秒。
- 页面内加自超时（30s）把状态置为 `cancelled`，避免扩展侧与页面侧都健在却永远轮询。

### D2. 切回来源标签页

`startTargetPicker` 增加 `ownTabId` 的实际使用（目前只用于排序排除）：

- 进入前记录 `ownTabId` 与 `ownWindowId`；
- `finally` 中 `tabs.update(ownTabId, { active: true })` + `windows.update(ownWindowId, { focused: true })`；
- 若配置页已被关闭（`tabs.update` 抛错），静默跳过。

同时把来源页 id 暴露给调用方，供「试跑」复用同一套聚焦/回切逻辑。

### D3. 悬停预览浮层（页面内）

`onOver` 里除 `outline` 外，渲染一个 `position: fixed; pointer-events: none` 的浮层：

```
┌───────────────────────────────┐
│ input#username                │
│ 将使用：#username（唯一）      │
│ 同 form 内另有 2 个候选        │
│ Esc 取消                       │
└───────────────────────────────┘
```

- 浮层节点挂在 `document.documentElement` 上，带最高 `z-index`，`pointer-events: none`（不干扰拾取）。
- 命中数在悬停时实时算（`document.querySelectorAll(selector).length`），超过 1 时文案变黄：
  「命中 3 个，执行时会报歧义」。
- 浮层文本一律用 `textContent` 写入，禁止 `innerHTML`（避免把页面文案当 HTML 解析）。
- 清理时机：`mouseover` 切换、`click`、`Esc`、`stop`、`scroll`（位置会漂）。

### D4. 候选列表

新增页面内函数产出**有序候选**，每个带命中计数：

```ts
interface TargetCandidate {
  target: Target;
  /** 当前文档内命中数 */
  count: number;
  /** 稳定性评级：id > name > aria > label > placeholder > text > cssPath */
  rank: number;
  /** 生成该候选的依据，UI 直接显示 */
  note: string;
}
```

- `pickTargetFromElement` 保留（返回首个**唯一**候选，兼容现有测试与调用），
  内部改为 `pickCandidates(el)[0]?.target ?? null`。
- 「唯一性」不再作为唯一候选的硬门槛：全部候选都非唯一时，仍返回 rank 最高的，
  并附带 `count`，由 UI 标黄提示。
- ⚠️ 现有代码已存在两份同源实现（`target-picker.ts:105-137` 与 `:226-254`），
  因为页面内版本不能引用模块级标识符。本轮**继续保留两份**，但补一条一致性测试
  （见 §7），防止今后单边修改导致拾取与执行语义漂移。

### D5. 拾取入口全覆盖：`TargetField.vue`

抽出共享组件，替换掉 5 处的「kind 下拉 + value 输入」（P-7）：

```
┌─────────────┬────────────────────────┬────────┐
│ CSS 选择器 ▾ │ #username              │ 拾取 ⟳ │
└─────────────┴────────────────────────┴────────┘
候选：[#username 唯一] [name=user 唯一] [label「用户名」 3]
当前定位命中：1 个可见元素
```

Props：`modelValue: Target | null`、`context: "fill" | "click" | "locate"`、`origin?`、`frameScope?`。
Events：`update:modelValue`、`update:frameScope`、`pick(state)`。

使用点：

| 位置 | `context` | 说明 |
|------|-----------|------|
| fill 行 | `fill` | 拾取后按元素类型自动建议填充值（D6） |
| click 行 | `click` | 只接受可交互元素（警告不硬拦） |
| waitFor「元素出现」 | `locate` | 复用同一组件，`modelValue` 映射到 `SettleCondition.selector.target` |
| 成功判定 selector | `locate` | 同上 |
| 失败判定 selector | `locate` | 同上 |
| extract DOM key | `locate` | 值仍是字符串（`Target` 的 CSS 简写），用组件但不写 frame |

`TargetField` 内保留原 kind 下拉，保证「手写 CSS / 手填文本」这条路径不退化。

### D6. 拾取即建议填充值

`PickResult.meta` 携带受限的元信息：`{ tag, type?, role?, contentEditable? }`。

- `type === "password"` → 若 `value` 为空，自动填 `{password}`；
- 该配方中尚无 `{username}` 的 fill → 自动填 `{username}`；
- `context === "click"` 且元素不可交互（非 BUTTON/A/role=button/submit）→ 行内黄条
  「该元素不是可点击控件，仍可保存」；
- `context === "fill"` 且元素不可输入（非 input/textarea/select/contenteditable）→ 同上。

**不自动改写用户已有值**，只在值为空时建议。

### D7. frame 记录的收敛（修 P-8）

- `frameId === 0`（主 frame）**不记录** `frameUrl`。主 frame 的身份由 tab 本身保证，
  记录 URL 只会在 SPA 路由 / query 变化后误判为 `FRAME_NOT_FOUND`。
  （注：识别登录表单回填时采用同一规则——只有 `frameId !== 0` 才写 `frameUrl`；
  拾取器自身的 D7 收敛随批次 3 落地，见 ADR-0013 实施批次。）
- 子 frame 记录 `frameUrl`，但 `generic-dom.ts` 的比较改为「先 frameId，后 origin+pathname」：

```ts
// 伪代码
if (scope.frameId !== undefined && frameId === scope.frameId) return true;
if (scope.frameUrl && url && sameOriginAndPath(url, scope.frameUrl)) return true;
return false;
```

- 两者都命不中时仍报 `FRAME_NOT_FOUND`（不静默回退全 frame 搜索），与 D12 一致。
- 兼容性：旧配方里主 frame 记录的 `frameUrl` 在比较放宽后自然命中，无需迁移。

---

## 4. 填写设计

### D8. 一键识别登录表单（最大收益）

编辑器顶部新增按钮「识别 <环境 URL> 页面上的登录表单」（扫描环境 URL 所在标签页，不是选项页本身），走新消息 `SCAN_LOGIN_FORM`（只读、不点击、
不提交、不写存储）。

页面内扫描算法（自包含函数，`allFrames: true`，按 frame 归并）：

1. 找所有**可见**的 `input[type=password]`；
2. 取其最近的 `form`（没有则取最近的公共容器，最多上溯 4 层）；
3. 同容器内、位于密码框之前、可见的 `input[type=text|email|tel]` 且非隐藏 → 用户名候选；
4. 同容器内可见的提交控件：`button[type=submit]` / `input[type=submit]` /
   `button` 文本匹配 `/登\s*录|login|sign\s*in/i`；
5. 每个元素用与拾取器**同一套**候选生成逻辑产出 `Target` + `count`。

返回：

```ts
interface FormScanResult {
  frameId?: number;
  frameUrl?: string;
  username?: TargetCandidate;
  password?: TargetCandidate;
  submit?: TargetCandidate;
  /** 命中的 frame 数量，>1 时要求用户确认 */
  matches: number;
}
```

UI 行为：

- **单 frame 命中且三项齐全** → 弹出确认卡片（列出三个候选与命中数）→「替换步骤」按钮
  把 `steps` 重置为 `fill{username} / fill{password} / click`，保留 `settle` 与 `auth`。
- **缺项** → 只回填识别到的项，其余保持空，并提示「未识别到提交按钮，请手动拾取」。
- **多 frame 命中** → 列出各 frame 的 URL 让用户选一个（通常 iframe 登录页）。
- **完全未识别** → 提示「未找到标准登录表单，请手动拾取或直接填写」，不写任何数据。
- 已有多步配方时**不做静默替换**：确认卡片明确写「将替换当前 5 个步骤」，需二次确认。

不采用「自动识别 + 自动保存」：登录表单识别是有歧义的启发式，必须留一次人工确认。

### D9. 简易模式 / 高级模式

简易模式是 `Recipe.steps` 的**投影视图**，判定规则（纯函数 `toSimpleForm(recipe)`）：

```
steps 形如：[goto?] + fill(value={username}) + fill(value={password}) + click
且没有 waitFor / extract / script
```

满足时渲染三行；任一条件不满足则**只读展示**并引导「转到高级模式」：

```
用户名  [TargetField]  →  {username}
密码    [TargetField]  →  {password}
登录    [TargetField]
────────────────────────────────
[编辑原始步骤（3 步）]  ← 点击后进入现有编辑器
```

- 切换是**单向的显式操作**：进入高级模式后不自动回落（避免误改把多步配方压平）。
- 简易模式下 `value` 不可编辑（固定为 `{username}` / `{password}`），定位可拾取/手改。
- `goto` 行显示为「登录页 URL」，映射到第一步 `goto`。
- 数据层无新增字段；`recipe-editor-model.ts` 增加 `toSimpleForm` / `fromSimpleForm` 两个纯函数。

被否决的替代方案：

- **另存一份 `simple: {username, password, submit}` 配置** —— 会与 `steps` 形成双事实源，
  违反 ADR-0012 D1。
- **新增步骤 op 类型** —— 同样破坏数据模型，且执行器要为新 op 增加分支。

### D10. 变量插入与明文密码告警

`value` 输入框下方一行变量胶囊，点击插入到光标处：

```
[ {username} ] [ {password} ] [ {origin} ] [ {apiBase} ] [ {debugRedirect} ]
```

- 变量清单从 `buildRecipeVariables`（`generic-runner.ts:78-87`）读取，避免文案漂移；
  `{step.<as>.<field>}` 单独给一行说明，不做胶囊（依赖具体步骤的 `as`）。
- 当 `fill` 的 `value` 非空且不含 `{password}` 且该步骤定位到 `type=password` 的元素时，
  提示「密码建议使用 {password} 变量，避免把明文写入配置」——**提示不拦截**
  （有些测试环境确实用固定串）。

### D11. 单步试跑与就地修复

`TEST_RECIPE` 增加可选 `only?: number[]`（步骤下标），只跑指定步骤，其余不出现：

- 每行步骤右侧加「▶」：只跑本步。`fill` 仍写 `devtools-dryrun`；
  `goto` 会真实导航（沿用现有语义），界面对此给出一次性提示；
  `click` / `script` / `extract` 仍 `skipped`。
- 失败行的错误条右侧直接给「重新拾取」按钮（`TargetField` 已内建），
  解决 `FRAME_NOT_FOUND`「请重新拾取」却无处重拾的问题。
- 整条试跑保留，但在结果汇总里区分「命中 / 跳过 / 未命中」的计数。

### D12. 编辑器小交互

| 改动 | 现状 | 目标 |
|------|------|------|
| 切换 op 保留 `target` | `changeOp` 整步替换（`RecipeEditor.vue:117-119`） | 保留 `target`、`frameId`、`frameUrl`，其余按新 op 重建 |
| 插入位置 | 固定倒数第二步（`:114`） | 选中行下方插入；未选中则追加到末尾 |
| 复制步骤 | 无 | 行操作加「复制」，插入到本行下方 |
| 删除确认 | 直接删 | 删除 `script` 步骤或含自定义定位的步骤时二次确认（可选，P2） |

---

## 5. 组件与消息协议变更

### 5.1 新增 / 修改文件

| 文件 | 变更 |
|------|------|
| `config/TargetField.vue` | 新增。kind + value + 拾取 + 候选 + 命中提示 + 清除 |
| `config/target-picker.ts` | `PickResult` 四态；`pickCandidates`；悬停浮层；回切来源 tab；`meta`；主 frame 不记 `frameUrl` |
| `config/RecipeEditor.vue` | 使用 `TargetField`；简易/高级模式；识别按钮；单步试跑；op 切换保留 target |
| `config/recipe-editor-model.ts` | `toSimpleForm` / `fromSimpleForm`；`VARIABLE_HINTS` |
| `config/login-form-scan.ts` | 新增。页面内扫描 + 扩展侧编排（结构同 `target-picker.ts`） |
| `strategies/generic-dom.ts` | frame 匹配放宽为 frameId → origin+pathname |
| `shared/messages.ts` | `SCAN_LOGIN_FORM`（新）；`TEST_RECIPE` 增加 `only?: number[]` |
| `shared/tool-definitions.ts` | `backgroundHandlers` 增加 `SCAN_LOGIN_FORM` |
| `background-handler.ts` | `handleScanLoginForm`；`handleTestRecipe` 支持 `only` |

### 5.2 消息示例

```ts
SCAN_LOGIN_FORM: {
  payload: { tabId?: number; origin: string };
  response: {
    success: boolean;
    error?: string;
    errorCode?: ErrorCode;
    frames: FormScanResult[];   // 多个 frame 都命中时全部返回，由 UI 选择
  };
};
```

`SCAN_LOGIN_FORM` 不写存储、不点击、不改页面（只在页面内读 DOM），因此不需要锁。

---

## 6. 兼容性

| 面 | 影响 |
|----|------|
| 已存配方 | 无影响。`Target` / `Recipe` 结构不变；`frameUrl` 记录变少，比较变宽，只增不减 |
| 旧 `frameUrl` | 主 frame 的旧记录在放宽比较后照样命中 |
| legacy 扁平参数 | 迁移路径不变（`migrateLegacyParams`） |
| 旧内置 API 登录 | 不涉及 |
| `TEST_RECIPE` | 新增可选字段，旧调用不带 `only` 即整条跑，行为不变 |
| 权限 | 不需要新权限（沿用 `scripting` + `host_permissions`） |

---

## 7. 验收与测试

### 7.1 单元测试

| 用例 | 断言 |
|------|------|
| `pickCandidates` 优先级 | id > name > aria > label > placeholder > text > cssPath，且 `count` 准确 |
| `pickCandidates` 唯一性 | 重复 id 时首项非 id 候选；全部非唯一时仍返回 rank 最高项并带 `count > 1` |
| 拾取器与执行器一致性 | 同一组 fixture 元素上，`pickTargetFromElement` 结果与 `pickerInPage` 的 `describe` 结果逐项相等 |
| `PickResult` 状态机 | `stop` 后 `state` 返回 `idle`；`start` 前 `state` 返回 `idle`；连续 3 次 `idle` → `lost` |
| 注入失败 | `executeScript` 抛错 → `{ status: "error", code: "INJECT_FAILED" }`，不再轮询 |
| 主 frame 不记 frameUrl | 主 frame 拾取结果 `frameUrl === undefined` |
| frame 匹配放宽 | `frameUrl` 带 query 变化、path 相同 → `status: "ok"`；path 不同 → `frameMissing` |
| `toSimpleForm` / `fromSimpleForm` | 三步标准形态往返无损；含 `waitFor` 时 `toSimpleForm` 返回 null |
| 表单扫描 | 单步登录页 → 三项齐全；iframe 登录页 → 命中 frame 正确；验证码页 → 提交按钮仍识别 |
| `runRecipeDryRun(only)` | 只返回指定下标的结果；未指定时行为与现在一致 |
| `changeStepOp` | fill ↔ click 保留 `target` / `frameId` / `frameUrl`；切到非定位 op 不保留 |
| `duplicateStep` | 深拷贝并插到本行下方；越界原样返回 |

现有 `tests/target-picker.test.ts`、`tests/generic-dom.test.ts`、`tests/generic-runner.test.ts`
作为基线，新增用例优先落到 `tests/target-picker.test.ts` 与新增的 `tests/login-form-scan.test.ts`。

### 7.2 手工验收

准备包含单步登录、两步登录和 iframe 表单的本地虚构页面，不使用真实账号或内部系统：

- [ ] 单步登录页：点「识别登录表单」→ 确认卡片三项齐全 → 保存 → 登录成功
- [ ] iframe 登录页：拾取后自动切回配置页；执行时命中 iframe 内元素
- [ ] 两步登录页：识别只回填前两步，简易模式自动落为高级模式（或提示不适用）
- [ ] 拾取时按 Esc → 回到配置页且有「已取消」提示
- [ ] 在 `chrome://extensions` 上点拾取 → 3 秒内提示「该页面不允许注入脚本」
- [ ] 拾取后修改页面 query 再试跑 → 不再出现 `FRAME_NOT_FOUND`
- [ ] 单步试跑第 3 步 → 只显示第 3 步结果（底部汇总写「第 3 步试跑」）
- [ ] 单步试跑失败行 → 「重新拾取」就地拉起拾取器
- [ ] 切换 op（fill → click）→ 已选定位保留
- [ ] 选中第 2 步后点「添加步骤」→ 新步骤出现在第 2 步下方
- [ ] 复制步骤 → 内容相同的新行出现在原行下方

---

## 8. 批次与工作量

| 批次 | 内容 | 预估 |
|------|------|------|
| **0** | D1（四态）+ D2（回切）+ D3（悬停浮层）+ 注入失败提示 | 0.5 天 |
| **1** | D4（候选）+ D5（`TargetField` 覆盖 5 处）+ D6 + D9（类型校验） | 1 天 |
| **2** | D8（识别登录表单）+ D9（简易/高级模式）+ D10（变量胶囊） | 1–1.5 天 |
| **3** | D11（单步试跑）+ D12（小交互）+ D7（frame 收敛） | 1 天 ✅ |

批次 0 独立可发布：它修的是「每次配置都会撞上」的三个问题，且不动数据模型。

---

## 9. 明确不做

- 录制回放、配方导入导出、内置模板库（ADR-0012 D15 / D16 的边界）。
- CDP / `chrome.debugger` 的真实事件拾取。
- 自动识别后静默替换已有配方（必须人工确认）。
- 在 `TargetField` 中内联展示元素截图或 DOM 树预览（收益低、注入成本高）。
- 拖拽排序（上下移按钮够用，拖拽的实现与可访问性成本不成比例）。
