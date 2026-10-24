# ADR-0013: 通用登录 —— 拾取器闭环与配方填写体验

- **日期**: 2026-10-21
- **状态**: 已接受，全部批次已落地（0 / 1 / 2 / 3）
- **背景**: ADR-0012 落地了配方（Recipe）与 `Target` 判别联合，并把拾取器（D14）作为配置门槛的解法。实际使用暴露的是**闭环缺失**而非能力缺失：拾取完不切回配置页、失败被吞成“取消”、悬停时看不到将生成什么定位。于此同时，空配方要求用户先理解“登录 = 填两个框 + 点一次”这个模型，才是真正的配置门槛。本文细化 `docs/generic-login-picker-ux.md` 的设计，并锁定分批范围。
- **范围**: `tools/account-switch/config/`（`target-picker.ts` / `RecipeEditor.vue` / `recipe-editor-model.ts`）与配套的 `strategies/generic-*`、`shared/messages.ts`。
- **关联**: ADR-0012（D3 Target / D12 跨 frame / D14 拾取器 / D15 不分发）；ADR-0007（配置页套件）。

---

## 决策清单

### D1. 拾取结果四态，失败不再伪装成取消

```ts
type PickResult =
  | { status: "picked"; target: Target; frameId?: number; frameUrl?: string }
  | { status: "cancelled" }   // 仅用户 Esc
  | { status: "lost"; message: string }
  | { status: "error"; code: "NO_TAB" | "INJECT_FAILED" | "TIMEOUT"; message: string };
```

- **决策**: `cancelled: boolean` 拆为四态；“无可拾取标签页”“注入失败”“页面跳转导致会话丢失”“超时”各自可辨识。
- **现状问题**: `target-picker.ts` 的三种失败路径都返回 `cancelled: true`，`RecipeEditor.vue` 对 `cancelled` 直接 return → 用户点一下拾取，什么都不会发生。
- **被否决**: 保留布尔 `cancelled` + 附加 `error?` 字段 —— 调用方仍要判 `cancelled && !error`，与四态是同一信息量的两种写法，但类型系统帮不上忙。

### D2. 拾取结束切回来源标签页

- **决策**: `startTargetPicker` 的 `finally` 中，在 `stop` 之后把来源 tab 置 active（并聚焦其窗口）；tab 已关闭时静默跳过。
- **被否决**: 让用户手动切回 —— 拾取是不可见操作，停在不相关页面等于丢失上下文。

### D3. 页面内悬停预览浮层

- **决策**: `pickerInPage` 的 `mouseover` 除 `outline` 外再渲染一个 `pointer-events: none` 的浮层，显示「将使用的定位」与「命中 N 个可见元素」；命中数 > 1 时给歧义警告。
- **被否决**: 只高亮（现状，无法预知结果）；扩展侧 popup 预览（跨窗口定位抖动，且扩展窗口会抢焦点）。
- **约束**: 浮层文本必须用 `textContent` 写入，禁止 `innerHTML`（页面文案不可信）。

### D4. 候选列表 + 命中计数

- **决策**: 拾取产出**有序候选数组**（id → name → aria → label → placeholder → text → CSS 路径），每项带当前文档命中数，UI 以胶囊形式让用户改选。
- **被否决**: 只返回首个唯一候选（现状）—— `#username` 与 `label「用户名」` 的稳定性差异明显，用户无权选择。
- **实现约束**: `pickerInPage` 与模块级 `pickTargetFromElement` 是两份同源实现（页面内函数不能引用模块级标识符），保留两份，补一致性测试防漂移。

### D5. `TargetField.vue` 覆盖全部 Target 输入点

- **决策**: 抽出共享组件（kind 下拉 + 值输入 + 拾取 + 候选 + 命中提示），替换 6 处：fill、click、waitFor「元素出现」、成功判定 selector、失败判定 selector、extract DOM key。
- **被否决**: 逐处复制定位输入框 —— 现状只有 fill / click 有拾取按钮，其余四处是裸 CSS 手填，与“拾取器降低门槛”的目标矛盾。

### D6. 拾取即建议填充值

- **决策**: 拾取结果携带受限元信息（tag / type / role / contentEditable）；`type=password` → 空值自动填 `{password}`，首个用户名字段 → `{username}`；元素类型与步骤 op 不匹配时给黄色警告但不拦截。
- **被否决**: 强行类型校验 —— 有些站点用 `div[contenteditable]` 当输入、用 `div` 当按钮。

### D7. frame 记录的收敛

- **决策**: 主 frame（`frameId === 0`）不记录 `frameUrl`；子 frame 的匹配顺序改为 frameId → origin+pathname 精确比较；两者都不命中仍报 `FRAME_NOT_FOUND`，不静默回退全 frame 搜索。
- **现状问题**: 主 frame 也记录 `frameUrl` 且按全串精确比较，SPA 路由或 query 变化即误报 frame 丢失。
- **被否决**: 全部改为 origin 比较 —— 同 origin 多 iframe 会串。

### D8. 一键识别登录表单

- **决策**: 新增只读消息 `SCAN_LOGIN_FORM`，在所有 frame 内启发式识别可见密码框、其前面的用户名输入框、同容器内的提交控件；返回各候选与命中数，**由用户确认后才回填**。
- **被否决**: 自动识别并静默替换配方 —— 启发式识别必然有误判，替换现有步骤是不可逆破坏。

### D9. 简易 / 高级模式是视图投影

- **决策**: 当 `steps` 恰好是「[goto?] + fill{username} + fill{password} + click」且不含 `waitFor`/`extract`/`script` 时，渲染三行简易表单；否则引导进入高级模式。切换是单向的显式操作。
- **被否决**: 新增 `simple: {...}` 配置字段 —— 与 `steps` 形成双事实源，违反 ADR-0012 D1；新增步骤 op —— 同样破坏数据模型，且执行器要为纯视图概念增加分支。

### D10. 变量插入胶囊

- **决策**: `value` 输入框下方列出 `{username}` / `{password}` / `{origin}` / `{apiBase}` / `{debugRedirect}` 可点击胶囊；变量清单从 `buildRecipeVariables` 推导，禁止硬编码文案。密码框的值不含 `{password}` 时提示（不拦截）。
- **被否决**: 继续只写在 placeholder —— `{step.*}` 与跨域相关变量等于隐藏知识。

### D11. 单步试跑与就地修复

- **决策**: `TEST_RECIPE` 增加可选 `only?: number[]`；每行步骤可单独试跑（fill 仍用 `devtools-dryrun` 占位值）；失败行直接给「重新拾取」入口。
- **被否决**: 只能整条配方试跑（现状）—— 改第 3 步要从头跑，且 `FRAME_NOT_FOUND` 的报错文案说“请重新拾取”却无处可点。
- **约束**: `click` / `script` / `extract` 仍不执行，与现有 dry-run 白名单一致。

### D12. 编辑器小交互

- **决策**: 切换 op 时保留 `target` / `frameId` / `frameUrl`；新步骤插入到选中行下方（未选中则追加）；支持复制步骤。
- **被否决**: 拖拽排序 —— 上下移按钮已够用，拖拽的实现与可访问性成本不成比例。

---

## 后果

- **收益**: 拾取成为完整回合（切过去 → 预览 → 拾取 → 切回 → 看到结果）；常见单步登录从“拾取三次 + 理解模型”降到“识别一次 + 确认”；失败信息落到可操作的行内位置。
- **成本**: 新增 1 个组件（`TargetField.vue`）、1 个模块（`login-form-scan.ts`）、1 条消息（`SCAN_LOGIN_FORM`）；`target-picker.ts` 与 `RecipeEditor.vue` 有结构性改写。
- **兼容**: `Recipe` / `Target` 结构不变；已存配方零改动；主 frame 的旧 `frameUrl` 记录在放宽比较后自然命中；`TEST_RECIPE` 新字段可选。
- **无需新权限**: 沿用 `scripting` + `host_permissions`。

## 明确不做（本 ADR）

- 录制回放、配方导入导出、内置模板库（ADR-0012 D15 / D16 的边界）。
- `chrome.debugger` / CDP 真实事件拾取（ADR-0012 D14 已否决，仅作为遇风控时的可选增强）。
- 自动识别后静默替换已有配方。
- 在 `TargetField` 中内联元素截图或 DOM 树预览（收益低、注入成本高）。
- 拖拽排序。

## 实施批次

| 批次 | 内容 | 决策 |
|------|------|------|
| 0 | 四态结果、回切来源 tab、悬停浮层、注入失败提示 | D1 / D2 / D3 |
| 1 | 候选列表、`TargetField` 覆盖、类型校验 | D4 / D5 / D6 |
| 2 | 识别登录表单、简易/高级模式、变量胶囊 | D8 / D9 / D10 |
| 3 | 单步试跑、frame 收敛、编辑器小交互 | D7 / D11 / D12 |

批次 0 独立可发布：它修的是每次配置都会撞上的问题，且不动数据模型。

### 批次 3 落地说明

- **D7**：`findPicked` 对 `frameId === 0` 不再返回 `frameUrl`；`runDomAction` 的
  `inScope` 改为 frameId 相等 → `origin + pathname` 相等（query / hash 变化不再误判
  `FRAME_NOT_FOUND`），都没命中仍报 `frameMissing`。
- **D11**：`TEST_RECIPE` 增加可选 `only?: number[]`，`runRecipeDryRun` 末参透传；
  `selectSteps` 负责升序去重与越界过滤，空数组 / 全部非法等价于整条试跑。
  编辑器每行一个「试跑本步」，结果区按行渲染，失败行给「重新拾取」（就地点击该行
  `TargetField` 的拾取按钮），底部汇总命中 / 跳过 / 未命中。
- **D12**：`changeStepOp` 在 fill ↔ click 之间保留 `target` / `frameId` / `frameUrl`；
  步骤序号按钮改为选中开关，新步骤插入到选中行下方（未选中则追加），行操作新增
  「复制步骤」（`duplicateStep`，深拷贝后插到本行下方）。

### D4 补充：排除框架自动生成的 id（v1.1.4 线上回归）

- **问题**: 某使用 Element Plus 的登录页中，输入框是
  `<input id="el-id-9759-21" placeholder="请输入手机号">`。这类 id 由框架的全局
  计数器在渲染时生成，刷新或重新进入路由就变成另一串数字。它在**当前文档**里
  唯一，于是 `preferredCandidate` 把它当作最稳候选推荐，配方保存后执行必然
  `ELEMENT_NOT_FOUND`。
- **决策**: `volatile-id.ts` 提供 `isVolatileId` / `containsVolatileId`，覆盖
  Element Plus（`el-id-\d+(-\d+)?`）、React 18 `:r1:`、Radix `«r1»` 与常见
  UI 库前缀，外加「前缀 + ≥5 位数字」的通用兜底（阈值 5 位以保留 `section2024`
  这类语义 id）。候选生成与 `cssPathOf` / `pathOf` 都跳过这类 id，**路径也不拿
  它当锚点**，改由 `nth-of-type` 保证唯一。
- **存量配方**: `collectRecipeErrors` 对写了自动 id 的步骤给行内提示「请重新拾取」；
  只提示不拦截保存（语法合法，且用户可能有意为之）。
- **约束**: 两个页面内注入函数（`pickerInPage` / `scanLoginFormInPage`）不能引用
  模块级标识符，各自内联一份同源实现，一致性由 `tests/target-picker.test.ts` 的
  一致性用例固化。
- **被否决**: 运行时「自动 id 失效后按其它属性回退」—— 执行器的定位是精确匹配，
  静默回退会让失败延后到更难解释的位置。

## 验证

- 单元：`tests/target-picker.test.ts`（状态机、浮层、`startTargetPicker` 编排与回切）
- 手工：按 `docs/generic-login-picker-ux.md` §7.2 准备本地虚构页面验收
- 全程 `npm run check` + `npm test` + `npm run lint` 保绿
