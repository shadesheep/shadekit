# ADR-0015: LoginSpec 规范补全（修订 ADR-0014）

- **日期**: 2026-10-22
- **状态**: 已接受（含 7 项起草连带决议，见 D13，需实施前确认）
- **背景**: ADR-0014 确立了「一份声明、一个执行器、一套词汇」的方向，但评审发现三处规范缺口：D3 的四条校验规则无法覆盖跨 origin 场景、D4 的 `$name` 没有定义「谁产出什么」、D6 的「已声明信号全部成立」会卡死纯 API 登录；另有 D5 的 `sameSite` 默认值会破坏 D14 的金标准、D1 与 D13 对 `StrategyDefinition` 的结论互相矛盾。经 6 轮 48 项决策评审，本文补齐可实现的规范，并逐条指明对 0014 的修订。**0014 原文不修改**；两文冲突处以本文为准。
- **范围**: 与 0014 相同（`entrypoints/tools/account-switch/`、`entrypoints/shared/tool-config.ts`、`docs/glossary.md`），不涉及其他工具。
- **关联**: ADR-0003 D1（测试 seam）、ADR-0004 D2/D4（会话与导航意图）、ADR-0005 D5（随机数）、ADR-0012（Recipe / D6 / D7 / D15）、ADR-0013 D9（视图投影）、ADR-0014（被修订）。
- **效力**: 0014 的 D1 / D2 / D8 / D9 / D10 / D11 / D12 / D14 继续有效；D3 / D4 / D5 / D6 / D7 / D13 由本文替代或补充（对照见文末附录 C）。

---

## 术语补充

以下术语已同步进 `docs/glossary.md`：

| 词 | 含义 |
|---|---|
| **绑定表 `bindings`** | 一次登录运行期间全部算子产出值的命名空间，以 `$<as>` 引用。取代 `tokenData` / `rawResponse`。 |
| **清理算子 `clear.*`** | 会话清理的唯一声明处，按出现顺序执行。清理范围不再属于认证声明。 |
| **导航算子 `goto`** | 唯一的页面导航声明。`navigate` 是同一概念的旧名。 |
| **快照算子 `auth.capture` / `auth.restore`** | 在登录 origin 捕获会话、在目标 origin 的当前文档恢复。取代 `mode: "snapshot"`。 |
| **模板 `SpecTemplate`** | `{ id, title, description, create(): LoginSpec }`；`loginMethod` 存其 `id`，只用于新建与日志显示，不参与执行。 |
| **日志白名单 `log.reveal`** | spec 声明的「允许原样出现在调试日志里的绑定名」。 |

---

## D1. 算子全集（SpecOp）

**决策**: `LoginSpec.ops[]` 的元素是以下判别联合。所有 `Ref` 类型字段都参与模板解析（D4），唯一例外是 `script.code`。

```ts
type Ref = string;                    // 可含 {name} 与 $binding
type AuthRange = "all" | "none" | string[];
type NormalizeRule =
  | "trim" | "upper" | "lower"
  | "numericString"               // 去掉非数字字符（含小数后缀），保留前导负号
  | "base64" | "base64url";       // 两种 base64 变体互转

type SpecOp =
  // —— 会话清理 ——
  | { op: "clear.cookies"; range: AuthRange; includeParent?: boolean }
  | { op: "clear.storage"; area: "local" | "session"; range: AuthRange }

  // —— 导航 ——
  | {
      op: "goto";
      url: Ref;
      waitForLoad?: boolean;
      timeoutMs?: number;
      when?: Ref;              // 值为假时跳过本算子（见下「条件导航」）
    }

  // —— HTTP（可重复出现）——
  | {
      op: "http.execute";
      url: Ref;
      method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";  // 默认 GET
      headers?: Record<string, Ref>;
      body?:
        | { json: Record<string, unknown> }   // 无空格序列化，key 顺序 = 声明顺序
        | { raw: Ref }
        | { ref: string };                    // 引用一个对象绑定，同样无空格序列化
      parse?: "json" | "text";                // 默认 json
      expectStatus?: "2xx" | number[];        // 默认 "2xx"；不匹配报 LOGIN_FAILED
      as: string;                             // 绑定解析后的响应体
    }

  // —— 数据变换 ——
  | {
      op: "digest";
      algorithm: "sha1" | "sha256";
      input: Ref;
      inputEncoding?: "utf8" | "ascii" | "latin1";       // 默认 utf8
      outputEncoding?: "hex" | "base64" | "base64url";   // 默认 hex
      upperCase?: boolean;                                // 默认 false
      as: string;
    }
  | {
      op: "crypto.encrypt";
      algorithm: "rsa-pkcs1v15" | "rsa-oaep";
      publicKey: Ref;
      input: Ref;
      as: string;                              // 输出固定 base64（jsencrypt 决定）
    }
  | {
      op: "payload.build";
      parts: Array<{ key?: string; value: Ref; normalize?: NormalizeRule[] }>;
      join?: string;                           // 见下：字符串模式必填，对象模式必须缺省
      as: string;
    }
  | {
      op: "map";
      input: Ref;
      cases: Array<{ equals: string | number | boolean; value: Ref }>;
      default?: Ref;
      as: string;
    }
  | { op: "apply.set"; target: "header" | "body" | "query"; key: string; value: Ref }

  // —— 会话写入 ——
  | { op: "auth.write" }                       // 无参：内容全部来自 spec.auth
  | {
      op: "auth.capture";
      cookies?: AuthRange;
      localStorage?: AuthRange;
      sessionStorage?: AuthRange;
      as: string;                              // 默认 "snapshot"
    }
  | { op: "auth.restore"; snapshot: string }   // 消费 auth.capture 的 as；范围随快照

  // —— DOM 子集（Recipe 的类型视图）——
  | ({ op: "fill"; target: Target; value: Ref; clearFirst?: boolean } & FrameScope)
  | ({ op: "click"; target: Target; onNotFound?: "fail" | "skip" } & FrameScope)
  | { op: "waitFor"; when: SettleCondition; timeoutMs?: number }
  | {
      op: "extract";
      source: "local" | "session" | "dom" | "url" | "cookie";
      key?: string;
      parse?: "raw" | "jsonValue";             // 默认 raw
      as: string;
    }
  | { op: "script"; code: string; world?: "MAIN" | "ISOLATED"; as: string };
```

**`payload.build` 的两种模式**（互斥，违反即 `CONFIG_INVALID`）：

- **字符串模式**：每个 part 都不带 `key`，`join` 必填（可为空串）。按顺序归一化后以 `join` 连接。例如 `nonce + timestamp + body` 的签名原文即 `join: ""`。
- **对象模式**：每个 part 都带 `key`，`join` 必须缺省。产出有序对象，供 `http.execute.body.ref` 引用或作为 `digest.input` 的被序列化对象。

**`apply.set` 的作用目标**：最近的一个**后续** `http.execute`。`header` / `query` 写入该请求；`body` 要求该请求的 body 为 `{ json }` 或引用对象绑定的 `{ ref }`，按 `key` 的点路径写入（`{ json }` 就地修改，`{ ref }` 修改被引用的对象）。之后没有 `http.execute` 即 `CONFIG_INVALID`。

**`script` 的契约**：

- `code` **不参与模板解析**（不做插值、不做 `{{` / `}}` / `$$` 转义、不校验引用）。
- 引擎注入的入口形如 `(bindings) => { ... }`，`bindings` 是 `$<as>` 的只读副本；返回值整体绑定为 `$<as>`。
- 失败通过 `throw` 表达，引擎归一为 `LOGIN_REJECTED`；不再识别返回值里的 `success` 字段。
- `world` 默认 `MAIN`（保持存量行为）。**`ISOLATED` 不是安全边界**，只表示不需要页面 `window` 变量。

**`extract` 的来源**（五个成员）：`local` / `session` / `dom` / `url` / `cookie`。取消旧 `storage` 源的「先 local 再 session」静默回退。`cookie` 源经 `chrome.cookies.getAll({ name })` 读取当前登录 origin 的 cookie，取第一个匹配的 `value`（`httpOnly` 同样可读）。

**`extract` 各来源的 `key` 语义**：

| source | `key` 含义 | 缺省时 |
|---|---|---|
| `local` / `session` | storage 的键名 | 必填（`CONFIG_INVALID`） |
| `dom` | `Target` 的 CSS 选择器部分；取文本内容或输入框当前值 | 必填 |
| `cookie` | cookie 名 | 必填 |
| `url` | **query 参数名**，取当前 tab URL 的该参数值（已 URL 解码） | 缺省取**整个 URL** |

**条件导航（`goto.when`）**：`when` 引用为假（`""` / `0` / `false` / `null` / `undefined`）时跳过该算子，轨迹记为 `skipped`（不记 error）。用于表达「有 `redirect` 就跳过去，否则交给落地 URL 推导」这类分支——旧 API 登录的 `afterLogin` 正是此形态。

- **被否决**：新增通用的 `if` / `branch` 算子、或引入表达式求值。前者会让 `ops[]` 从线性序列变成图，R1–R3 的顺序校验要重写；后者违反 D9 红线 1。
- **边界**：`when` 只做「跳过 / 不跳过」，没有 `else` 分支；需要互斥两条路径时写两个 `when` 相反的 `goto`。
- **与落地 URL 推导的关系**：`goto.when` 只在 spec 内部表达分支；`login-tab-flow` 的落地 URL 推导（`debugRedirect` > `targetUrl` > `lastGotoUrl` > `origin`）仍然兜底——`goto` 被跳过时 `lastGotoUrl` 不更新，推导自然退到下一优先级。

---

## D2. LoginSpec 形状

```ts
interface SpecVar {
  name: string;          // 进入输入命名空间，引用形式 {name}
  title?: string;
  default?: string;      // 非敏感默认值
}

interface SpecLimits {
  requestMs?: number;    // 默认 15000，仅 http.execute
  stepMs?: number;       // 默认 5000，仅单次 DOM 交互（fill/click/extract/script）
  settleMs?: number;     // 默认 10000，页面条件轮询上限；也是 goto.timeoutMs 的缺省值
}

interface LoginSpec {
  version: 2;
  template?: string;                     // 仅新建与日志可读性，引擎不据此分派
  vars?: SpecVar[];
  aux?: { nonce?: "auto"; timestamp?: "auto" };  // 声明由引擎生成的输入
  ops: SpecOp[];
  success: SuccessSignal[];              // 至少一条（D5）
  failure?: SettleCondition[];           // 任一命中即中止
  auth: AuthSpec;                        // D7
  limits?: SpecLimits;
  log?: { reveal?: string[] };           // 允许原样进日志的绑定名
}
```

**`aux` 的语义**：声明后，`nonce` / `timestamp` 进入输入命名空间，可在任意 `Ref` 中以 `{nonce}` / `{timestamp}` 引用，也自动参与签名类的字符串拼接。

- `nonce`：8 位十进制随机数（`crypto.getRandomValues`）+ 毫秒时间戳，替代旧 API 策略的 `Math.random()`（同时满足 ADR-0005 D5）。
- `timestamp`：`Date.now()`。
- 测试通过上下文注入固定值，以获得可断言的请求（D14 金标准）。

---

## D3. 校验规则（替代 ADR-0014 D3 的四条）

违反任一条即 `CONFIG_INVALID`，**保存与导入均拦截**，错误定位到具体算子下标。

- **R1 成功先行**：`auth.write` / `auth.capture` 必须位于所有被 `success` 信号引用的绑定产出算子之后；若 `success` 含 `page` 信号，还必须位于最后一个 DOM 交互算子（`fill` / `click` / `script` / `waitFor` / `goto`）之后。
- **R2 数据流可达**：引用 `$x` 或 `from: "x"` 的算子必须位于产出 `x` 的算子之后；`goto.when` 的引用同样适用。
- **R3 跨 origin 写入**：`goto` 不得位于 `auth.write` 之前；`auth.restore` 必须位于一次 `goto` 之后，且其快照由更早的 `auth.capture` 产出。
- **R4 输入已声明**：`{name}` 必须是内置输入（`username` / `password` / `origin` / `apiBase` / `targetUrl` / `debugRedirect`）或 `spec.vars` / `spec.aux` 中已声明的名字。
- **R5 绑定唯一**：同一 spec 内 `as` 不得重复。
- **R6 算子前置**：`apply.set` 之后必须存在 `http.execute`；`auth.restore.snapshot` 必须引用一个 `auth.capture` 的 `as`；`http.execute.body.ref` 必须引用对象模式的 `payload.build` 产出。
- **R7 成功信号**：`success` 至少一条。

**`auth.mode: "page"` 时**：`auth.write` 是空操作（安全开关），R1 / R3 对它不适用；其余规则不变。

**为什么 R1 要覆盖 `auth.capture`**：捕获的是「登录成功之后」的会话；提前捕获会把登录前残留的 cookie 带到目标 origin，这与 D8 的清理目标相反。

---

## D4. 引用、转义与未解析

- `{name}` — 输入命名空间：内置（`username` / `password` / `origin` / `apiBase` / `targetUrl` / `debugRedirect`）+ `spec.vars` + `spec.aux`。**命名空间已摊平**，不存在 `vars.` 前缀。
- `$name` — 绑定表取值，支持点路径（`$resp.data.token`、`$list.0.name`）。
- 转义：`{{` → `{`，`}}` → `}`，`$$` → `$`。
- **未解析即错误**：保存期 `CONFIG_INVALID`，运行期 `TEMPLATE_UNRESOLVED`。不再保留 `interpolateTemplate` 的「未命中保留原样」（`generic-runner.ts:59-76`）。
- **引用解析为对象时**：一律 `JSON.stringify` 无空格序列化（与 `http.execute.body.json` 同一规则），供签名与 body 复用。
- **`script.code` 豁免**：不做插值、不做转义、不校验引用（见 D1）。

---

## D5. 成功信号与失败信号（替代 ADR-0014 D6）

```ts
type SuccessSignal =
  | { response: { from: string; path: string; equals?: unknown } }  // 不写 equals = 路径为真
  | { token: { from: string; path: string } }                       // 取到非空值
  | { page: SettleCondition }
  | { anyOf: SuccessSignal[] };
```

- 数组即 **AND**：全部成立才算成功。
- 需要「任一」时，在数组里放一个 `{ anyOf: [...] }` 元素。
- `failure: SettleCondition[]` 与 `success` 顶层并列，数组即 **OR**；轮询周期内**失败优先**（沿用 ADR-0012 D4），命中即 `LOGIN_REJECTED`。
- 全部信号已声明但未满足 → `SUCCESS_CONDITION_UNMET`（**不新增** `SUCCESS_SIGNAL_UNMET`；错误消息区分「响应路径未满足」与「页面条件未满足」）。
- 验证码识别（`CAPTCHA_REQUIRED`）挂在页面轮询阶段，与 `failure` 同周期检查。

**与 0014 的差异**：0014 的「已声明即隐式 AND、且没有「任一」的表达手段」被取代；`settle` 顶层字段删除，改由 `success` 中的 `page` 信号承载。

---

## D6. 超时（替代 ADR-0014 D7 的字段部分）

| 字段 | 默认 | 约束对象 |
|---|---|---|
| `limits.requestMs` | 15000 | `http.execute` 单次请求 |
| `limits.stepMs` | 5000 | 单次 DOM 交互（`fill` / `click` / `extract` / `script`） |
| `limits.settleMs` | 10000 | 页面条件轮询；`goto.timeoutMs` 的缺省值 |

- `pageLoadMs` 删除（与 `goto.timeoutMs` 长期同名不同义）。
- 超时错误码：HTTP → `REQUEST_TIMEOUT`（复用 `fetch-timeout.ts`），算子 → `STEP_TIMEOUT`（新增）。
- `stepMs` 不再约束 `http.execute`：DOM 5s 与 HTTP 15s 的合理值差三倍，这正是 0014 D7 拒绝单一全局超时的理由。

---

## D7. 认证声明（替代 ADR-0014 D5）

```ts
interface CookieWrite {
  name: string;
  value: Ref;
  domain?: string;    // 缺省 = host-only
  path?: string;      // 默认 "/"
  secure?: boolean | "auto";   // 默认 "auto"：https → true
  httpOnly?: boolean;          // 默认 false
  sameSite?: "unspecified" | "lax" | "strict" | "no_restriction";  // 默认 "unspecified"
  expiresFrom?: {
    from: string; path: string;
    unit: "epochMs" | "epochS" | "iso" | "relativeSeconds";        // 默认 epochMs
  };
}

interface StorageWrite { key: string; value: Ref }

type AuthSpec = {
  mode: "engine" | "page";
  cookiesWrite?: CookieWrite[];
  localStorageWrite?: StorageWrite[];
  sessionStorageWrite?: StorageWrite[];
};
```

- **`mode: "engine"`**：`auth.write` 按上述声明写入。
- **`mode: "page"`**：引擎不写任何会话（`auth.write` 为空操作）。
- **清理不在 `AuthSpec` 里**：归 `clear.*` 算子（D3 第 1 轮决策）。
- **跨 origin 恢复不在 `AuthSpec` 里**：归 `auth.capture` / `auth.restore`。
- **`sameSite` 默认 `"unspecified"`**：当前 `setCookie`（`auth-storage.ts:75-82`）不写 SameSite 属性，金标准要求 byte 级一致，不能把默认值改成 `lax`。
- **`httpOnly` 可写**：`chrome.cookies.set` 的 `SetDetails` 支持 `httpOnly`（`auth-snapshot.ts:233` 已在恢复时使用）。0014 D5「`httpOnly` 无法由扩展设置」的判断有误，本文更正。
- **`expiresFrom` 的 `from`**：绑定名；`path` 为点路径。取不到或单位无法解析 → `CONFIG_INVALID`（保存期可静态判定的部分）/ `LOGIN_REJECTED`（运行期）。
- **storage 写入必须在目标 origin 的文档内**：`auth.write` 与 `auth.restore` 执行时若当前 tab 的 origin 与 `ctx.origin` 不一致且声明了 storage 写入，报 `INJECT_AUTH_FAILED`（延续 ADR-0012 D7 的硬约束，不静默写错 origin）。

---

## D8. 日志与脱敏（ADR-0014 D9 必改项的实现规范）

- **删除** `auth-flow.ts:240-244` 的 `xstr` 硬编码抽取。
- **新增** `spec.log.reveal: string[]`（绑定名，不含 `$`）。引擎把命中值放入 `DebugLogEntry.request.revealed: Record<string, string>`，`DevLogsViewer.vue` 相应地渲染（替代 `encryptedPassword`）。
- **敏感字段黑名单**（优先级高于白名单，命中即替换为 `***`）：
  `password` / `passwd` / `pwd` / `token` / `refresh_token` / `authorization` / `cookie` / `set-cookie` / `secret` / `x-*-token`。
  **`sign` 不在黑名单**：它是一次性请求签名（绑定 nonce），是排查签名失败的主要线索。
- **脱敏方式**：对 `request.headers` / `request.body` / `response.body` 做**结构化遍历**——可解析为 JSON 的逐字段处理，否则整串替换。
- **保留期不变**：30 天 / 1MB（`logger.ts:91-95`）。
- **`DebugLogEntry` 字段变更**：删除 `steps: AuthStep[]`，保留 `ops: SpecOpTrace[]`（原 `recipeSteps` 升格）；`domain.loginMethod` **保留字段名**，值改为 `SpecTemplate.id`。

---

## D9. 配置包（ADR-0014 D11 的补充）

- 格式 `dt-login-config/v1` 不变。
- **`requiredVars` ⊆ `spec.vars`**：保存 spec 时校验一次，**导入配置包时再校验一次**（包内的 spec 与 `requiredVars` 可能跨版本编辑过而不一致）。
- **`script` 检查按每条 op 遍历**：导出时若任一 `op.op === "script"`，拒绝并报「第 N 步（`script`）包含可执行代码，不能随配置包分发」；导入时同样遍历，命中即 `CONFIG_INVALID`。不做 spec 级标记。
- **版本**：`spec.version > CURRENT` 明确拒绝；`migrateSpec(v) → v+1` 顺序迁移链，纯函数、可单测。
- **入口**：配置包的导出/导入放在**环境详情/编辑区**（绑定单个 domain）。现有全局「导出配置」保留，但改名为「备份整份配置（含账号密码）」并加二次确认（`Config.vue:422-430`）。

---

## D10. 迁移

| 现状 | 目标 | 说明 |
|---|---|---|
| `Recipe.version: 1` | `LoginSpec.version: 2` | 迁移链 1 → 2 一次性转换 |
| `recipe.steps[]` | `spec.ops[]` | `goto` / `fill` / `click` / `waitFor` / `extract` / `script` 一一对应 |
| `recipe.settle` | `success: [{ page: settle }]` | |
| `recipe.failWhen` | `failure: [failWhen]` | |
| `recipe.auth.mode: "snapshot"` | `auth.capture` + `goto` + `auth.restore` | 范围取自原 `cookies` / `localStorage` / `sessionStorage` |
| `recipe.auth.mode: "page"` | `auth.mode: "page"` | |
| `recipe.limits.pageLoadMs` | 删除 | `goto.timeoutMs` 缺省 `settleMs` |
| `strategyParams.publicKey` | `spec.vars` + 环境配置值 | 域值存 `DomainConfig.vars` |
| `AuthStep[]` 日志 `steps` | `ops: SpecOpTrace[]` | 历史日志不迁移（内部工具） |
| `script.code`（模板字符串） | 函数形态 `(bindings) => …` | **不参与模板解析**，存量脚本需改写 |
| `extract.as` 缺省 | `as: "extract"` | 迁移时补默认 |
| `script.as` 缺省 | `as: "script"` | 迁移时补默认 |
| legacy `authSource: "cookie"` | `extract { source: "cookie" }` | 修掉 `generic-recipe.ts:344-352` 把 cookie 误映射成 storage 的既有缺陷 |
| legacy `extract.source: "storage"` | `source: "local"` | 发迁移告警：原实现有 local→session 静默回退，若目标键在 session 中需手改为 `session` |

**存量行为不变的部分**：已有配方的算子序列、`failWhen` 优先级、验证码识别、跨 frame 定位、拾取器与编辑器交互。

**存量行为收紧的部分**（须写入迁移说明）：

1. 未解析引用从「原样发送」变为保存期报错（0014 D4 已声明，本文落地）。
2. `extract` 不再静默回退 storage；同名键跨两个 storage 的配方需显式选择。
3. `script` 从「字符串模板 + `{success}` 约定」变为「函数 + `throw`」。

---

## D11. UI 投影（ADR-0014 D13 的补充）

- **单一 spec 编辑器、三层视图**不变：简易（DOM 三步投影）/ 高级（算子列表）/ 原始 JSON。
- **`simpleShapeOf` 的新判定**：先剔除 `clear.*` 与 `auth.write`，剩余算子必须恰为 `[goto?] + fill{username} + fill{password} + click`；且整个 spec 不含 `http.execute` / `crypto.encrypt` / `digest` / `payload.build` / `map` / `apply.set` / `auth.capture` / `auth.restore` / `extract` / `waitFor` / `script`。不满足则引导进高级模式。
- **简易模式只读写那四个算子**，其余算子原样保留（投影必须无损）。
- **新建 spec 的默认模板**（`SpecTemplate.create()` 的标准形态）：

```
clear.cookies(range: "all")
clear.storage(area: "local", range: "all")
goto({origin}/login)
fill{username} ← {username}
fill{password} ← {password}
click(提交按钮)
auth.write
success: [{ page: { any: [formGone, urlChanged] } }]
auth: { mode: "engine" }
```

> ⚠️ 默认模板会清空 localStorage。存量配方迁移时**不添加** `clear.storage`（保持原行为）；只有新建 spec 使用该默认。这是刻意的不对称，须在接入指南里说明。

- `loginMethod` 降为 `SpecTemplate.id`（如 `generic` / 自定义策略 id），类型注释写死「不参与执行」。
- `SettingDefinition` 动态表单路径关闭；`debugRedirect` / `defaultPassword` / `cookieClearIncludeParent` 仍走现有 Setting Item 表单。

---

## D12. 引擎与测试 seam

```ts
runSpec(spec: LoginSpec, ctx: AuthContext, options?: RunSpecOptions): Promise<RunSpecResult>
```

- **唯一执行 seam**。`runAuthFlow` / `LoginStrategy` / `registerStrategy` / `getStrategyDefinitions` 全部删除。
- `AuthContext` 保留名字，删除 `tokenData` / `rawResponse`，新增：
  `bindings: Record<string, unknown>`、`targetUrl?: string`、`debugRedirect?: string`。
- `RunSpecResult`：`{ success, bindings, trace: SpecOpTrace[], lastGotoUrl?, error?, errorCode? }`。
- **`goto` 的执行点仍是 `login-tab-flow.applyNavigationIntent`**：算子只是调用方，「tab 变更收口在一个 module」的不变量保留（ADR-0004 D4）。
- **尾部收缩**：`setupAuthTab` 不再调用 `clearAuth` / `setAuth`（写入已在算子内完成），只保留「复用已建 tab → 确保落地 URL → reload」；`injectAndNavigate` 删除注入段，只保留「注入失败关 tab 回滚」的不变量与导航。
- **落地 URL 推导**（替代 `resolvePostLoginUrl` 的 `/api` 回退）：`debugRedirect` > `targetUrl` > `lastGotoUrl` > `origin`。`apiBase` 不再参与推导，只作为输入变量供 spec 拼路径。
- **账号切换的尾部刷新**（`SWITCH_ACCOUNT`，issue 12 线上回归修复）：
  - **事实**：ADR-0012 D10 的 `afterLogin: "execute"` 由账号切换入口使用，旧 API 登录无 `?redirect=` 时返回 `{ action: "reload" }`、generic 无 `debugRedirect` 时同。issue 12 删除 `auth-flow.ts` 时一并删掉了该阶段，`handleSwitchAccount` 只跑 `runLoginSpec` 就返回成功；旧 API 声明以 `auth.write` 收尾、不含 `goto`，于是「登录成功但页面不刷新」，SPA 仍用旧会话。快捷登录两条路径不受影响——它们的尾部仍有 `injectAndNavigate` / `setupAuthTab` 的 reload。
  - **决策**：账号切换的尾部动作收口到 `login-tab-flow.refreshAfterSwitch(tabId, origin)`，在 `handleSwitchAccount` 成功分支调用：当前地址带 `?redirect=` 时按登录 origin 拼绝对地址后导航（保留旧 `afterLogin` 的回跳约定），否则 `tabs.reload`。刷新失败只记日志、**不把已成功的登录判成失败**（会话已落库，手动刷新即可恢复）。
  - **不写进 spec**：不为刷新追加尾部 `goto`。`debugRedirect` 是快捷登录入口的运行时参数，`?redirect=` 依赖「当前 tab 地址」，两者都不是可序列化的环境输入；写进声明会让同一份策略复用到多环境时行为失真。spec 只负责把会话写进去，页面重启由 tab 编排层承担。
  - **被否决**：复用 `injectAndNavigate` / `setupAuthTab`——它们会二次注入 token、按快捷登录语义新建或导航 tab，与「在用户当前页原地换号」不符；删除该行为不补——即本次回归本身。
  - **遗留**：spec 自行 `goto` 时 `refreshAfterSwitch` 仍会再刷一次。`lastGotoUrl` 现阶段不穿透 `runLoginSpec` 的结果信封（避免扩大兼容层返回面）；当时内置模板均不以 `goto` 收尾，暂不触发。后续若引入带尾部 `goto` 的策略，应把 D12 的 `lastGotoUrl` 推导接到调用方。
- **测试**：以 `runSpec` 为 seam 断言算子组合、请求字节、写入产物与轨迹；校验器 / 迁移链 / 模板解析 / 归一化作为纯函数单测。`tests/stateless-login-strategies.test.ts` 随接口删除；`tests/generic-steps.test.ts` 的步骤引擎用例随第二套执行器删除（`interpolate` 迁入模板模块后由新用例覆盖）。账号切换尾部由 `tests/switch-account-tail.test.ts` 固定：成功必刷新、`?redirect=` 走导航、刷新失败不判失败。

---

## D13. 起草连带决议（需实施前确认）

评审的 48 项决策定案后，起草规范时发现 7 处「前序答案互相碰撞或与事实不符」。以下是为保持规范自洽所做的最小修正，**均不改变已定方向**：

| # | 问题 | 决议 |
|---|---|---|
| C1 | 第 3 轮定了 `success.token`，第 5 轮又删除了 `tokenData`——`token` 失去主语 | `response` / `token` 信号均增加必填 `from`（绑定名）。`token` 等价于「`from` 的 `path` 取到非空值」 |
| C2 | 第 3 轮定了 `payload.build` 的字符串模式，但 API 登录需要「可被签名的请求体对象」 | `parts` 增加可选 `key`；无 `join` 且每项带 `key` 时为对象模式，与字符串模式互斥 |
| C3 | 第 2 轮 Q2(a) 的措辞「`goto` 不得位于 `auth.write` / `auth.restore` 之前」把快照流程写反了（恢复必须在 `goto` 之后） | 修正为 R3：`goto` 不得在 `auth.write` 之前；`auth.restore` 必须在 `goto` 之后 |
| C4 | `apply.set` 没有说明作用于哪个请求 | 作用于其后最近的一个 `http.execute`；其后没有则 `CONFIG_INVALID` |
| C5 | 0014 D5 称「`httpOnly` 无法由扩展设置」，与 `chrome.cookies.SetDetails` 及 `auth-snapshot.ts:233` 不符 | `CookieWrite` 支持 `httpOnly`，默认 `false`（保持旧 API 登录行为） |
| C6 | 第 2 轮 Q7 称「显式四源」，实际枚举了五个成员 | 以五个为准：`local` / `session` / `dom` / `url` / `cookie` |
| C7 | 跨 origin 的 `goto` 目标无法在 spec 中表达（0014 D4 的输入命名空间没有它） | 输入命名空间增加 `targetUrl` 与 `debugRedirect`（后者现有代码已在用） |

---

## 后果

- **收益**：登录只剩一种形态；API 登录、加密、签名、DOM 流程共享同一个执行器与同一套校验、日志、错误码；站点登录从不可配置的宿主代码变成可参考、可复制、可 diff 的声明；用户可通过配置包接入新系统而无需改码。
- **成本**：一次不可拆的引擎替换；19 个 import 了登录引擎模块的测试文件改到新 seam；`DomainsPanel.vue` 的 17 处 `loginMethod` 分支收敛；`RecipeEditor.vue`（2144 行）的模式投影适配算子数组；存量 `script` 配方需要改写。
- **风险**：
  1. R3 与 R1 让「先写会话再跳转」成为硬约束，若某系统的会话必须在目标 origin 由页面脚本生成，只能退化为 `mode: "page"` + 自定义算子。
  2. 默认模板清空 localStorage（见 D11 警告），新建 spec 的用户可能丢失站点偏好；迁移配方不受影响。
  3. `payload.build` 的两种模式是同一算子的两个语义，编辑器需要在切换时明确提示，否则容易写出混合形态（校验会拦截，但体验有成本）。
  4. 旧 API 声明若在语言读取上使用 `script`（`map` 之外的兜底），金标准会有一块盲区；本规范用 `extract(parse: jsonValue)` + `map` 消除该盲区，**金标准要求全链路无 `script`**。

---

## 附录 A. 改造后的能力矩阵

| 形态 | 覆盖方式 |
|---|---|
| 纯 JSON API 登录（token） | `http.execute` + `success.token` + `auth.write` |
| 纯 cookie API 登录（无 token） | `http.execute` + `success.response` + `auth.write`（`cookiesWrite`） |
| 请求体加密 | `crypto.encrypt` → `payload.build`（对象模式）→ `http.execute.body.ref` |
| 请求签名（header） | `payload.build`（字符串模式）→ `digest` → `http.execute.headers` 引用 |
| 请求签名（body 内字段） | `payload.build`（对象）→ `digest` → `apply.set(body)` → `http.execute` |
| 两段式登录（先取 CSRF 再提交） | 重复 `http.execute` + `extract` / `success` 引用首个响应 |
| 页面表单登录 | DOM 算子 + `success.page` |
| 页面读取前置值（含 JSON 编码） | `extract(local/session/dom/url/cookie, parse)` |
| 多语言请求头 | `extract(local, jsonValue)` → `map` |
| 跨 origin 调试跳转 | `auth.capture` → `goto` → `auth.restore` |
| 无 token 且页面自管会话 | `auth.mode: "page"`（或省略 `auth.write`） |
| 自定义协议（双向认证等） | `registerLoginOp` 注册新算子 |

## 附录 B. 系统边界

**不做（本期）**：OAuth / OIDC / PKCE / `chrome.identity`；令牌续期与后台 401 刷新；秘密管理（secret store）、HMAC / AES 等密钥类算子、SM3 / SM2；录制回放、插件市场、`chrome.debugger` / CDP；验证码与人工多因子（仅识别并报 `CAPTCHA_REQUIRED`）；跨域第三方 Set-Cookie（降级为页面模式或 DOM 流程）；非 http(s) origin；MD5（WebCrypto 不支持，且无已确认目标）；时间重排类归一化（同上）。

**边界上的明确规则**：

- `http.execute` 可重复，但**不支持公私钥交换 / 多轮手签 / 双向认证**——这类需求只能写自定义算子。
- `script` 是唯一任意代码算子：本地可建可编，**导出配置包拒绝（指明第几步）**，导入含 `script` 的包报 `CONFIG_INVALID`；内置 spec 可含经人工审阅的 `script`，迁移后的声明也要求不含。
- `vars` 只允许非敏感值；`requiredVars.secret: true` 在 v1 直接拒绝。
- 配置包与日志永不含秘密；日志黑名单优先于 `log.reveal` 白名单。

## 附录 C. 对 ADR-0014 的条款对照

| 0014 | 本文 |
|---|---|
| D1 引擎统一 | 保留；`runSpec` 为唯一 seam（D12） |
| D1 算子全集 | 补充 `goto.when` 条件导航与 `extract(url)` 的 query 语义（见 D1） |
| D2 一份数据两个视图 | 保留；投影判定更新（D11） |
| D3 算子数组与四条校验规则 | **替代**为 D1 的算子全集与 D3 的 R1–R7 |
| D4 引用语法 | **补充**：命名空间摊平、`targetUrl` / `debugRedirect`、对象序列化规则、`script` 豁免 |
| D5 认证声明 | **替代**为 D7：删除 `*Clear`、删除 `mode: "snapshot"`、`sameSite` 默认 `unspecified`、`httpOnly` 可写、写入值改为引用 |
| D6 成功信号 | **替代**为 D5：数组即 AND + 显式 `anyOf`、`from` 引用、不新增错误码 |
| D7 结算与超时 | **替代**为 D6：三类超时、删除 `pageLoadMs` |
| D8 加解密算子 | **修订**：删除 MD5、增加 `map`、`payload.build` 双模式、`crypto.encrypt` 输出固定 base64 |
| D9 安全边界 | 保留；日志脱敏细化为 D8 |
| D10 令牌生命周期 | 保留 |
| D11 配置包 | **补充**：校验时机、逐算子 `script` 检查、入口位置（D9） |
| D12 试登录 | 保留；以 `runSpec` 的单算子模式执行 |
| D13 `loginMethod` 与 UI | **补充**：`SpecTemplate`、默认模板、`simpleShapeOf` 新判定（D11） |
| D14 迁移与验收 | **补充**：迁移表（D10）、金标准要求全链路无 `script` |

## 验证

- 新增：spec 校验器（R1–R7 逐条）、迁移链（Recipe v1 → LoginSpec v2，行为等价）、模板解析（`{name}` / `$name` / 三种转义 / 未解析报错 / 对象序列化）、`auth` 写入参数化（含 `sameSite: unspecified` 与 `httpOnly`）、`auth.capture` / `auth.restore` 跨 origin、试登录零副作用（断言未调用 `auth.write` / `goto` / `tabs.*`）、配置包（`script` 拒绝、高版本拒绝、`requiredVars` 校验）、旧 API 登录迁移的金标准（注入固定 nonce/timestamp，请求 URL / headers / body byte 级一致）。
- 删除：`tests/stateless-login-strategies.test.ts`、`tests/generic-steps.test.ts` 的步骤引擎部分。
- 账号切换尾部：`tests/switch-account-tail.test.ts`（成功必刷新 / `?redirect=` 走导航 / 刷新失败不判失败）。
- 其余既有测试原样保绿；`npm run check` + `npm test` 同 PR 保绿。

## 后续修订（2026-10-26）：自动标记校验与刷新上限

- `fill/click.target` 类型为 `Target | { auto: "login" }`；未知 auto、额外字段、组合缺项和非标准声明均为 `CONFIG_INVALID`，其它 Target 位置不接受 auto。
- 只有标准三步整组自动时启用运行时解析。`noPassword` 可在任何填写/点击之前触发一次 `reloadTabAndWait(settleMs)`；incomplete、ambiguous、注入错误、goto 失败和成功条件失败均不触发。
- 独立 authoring validator 由官方校验器生成并保留 `validateLoginSpecSnapshot` 导出别名；自动与旧默认 fixtures 做 parity，版本号不变。
