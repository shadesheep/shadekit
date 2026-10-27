# LoginSpec v2 兼容快照

本文件对应 `compatibility.json` 中的 ShadeKit revision。完整结构由内置 `validateLoginSpecSnapshot` 检查；这里提供编写时所需的字段与语义。

## 顶层结构

```ts
interface LoginSpec {
  version: 2;
  template?: string;
  vars?: Array<{ name: string; title?: string; default?: string; secret?: boolean }>;
  aux?: { nonce?: "auto"; timestamp?: "auto" };
  ops: SpecOp[];                 // 至少一个
  success: SuccessSignal[];      // 至少一个有效信号
  failure?: SettleCondition[];
  auth: AuthSpec;
  limits?: { requestMs?: number; stepMs?: number; settleMs?: number };
  log?: { reveal?: string[] };
}

type SuccessSignal =
  | { response: { from: string; path: string; equals?: unknown } }
  | { token: { from: string; path: string } }
  | { page: SettleCondition }
  | { anyOf: SuccessSignal[] };
```

- 顶层 `success[]` 是 **AND**；`anyOf` 是 **OR**。`response.equals` 使用严格相等；省略 equals 时要求值非空。`token` 要求路径值非空。
- 所有算子执行完后才最终判定 success；`auth.write` 可能已先执行，因此 engine 写入必须先经过业务门控。
- `failure[]` 是页面结算条件，任一命中即失败；离线模拟不支持。
- 默认限制：`requestMs=15000`（HTTP）、`stepMs=5000`（DOM）、`settleMs=10000`（页面轮询及 goto）。
- `nonce:auto` 生成 8 位随机数字；`timestamp:auto` 生成毫秒时间戳字符串。

## 模板与绑定

`Ref` 字符串支持：

| 语法 | 含义 |
|---|---|
| `{username}` `{password}` `{origin}` | 内置账号与环境输入 |
| `{targetUrl}` `{debugRedirect}` | 内置目标地址；跨 origin 导航受 R3 约束 |
| `{name}` | `vars` 或已声明 `aux` 输入 |
| `$resp.data.token` | 前序算子的 `as` 绑定及点路径/数组下标 |
| `{{` `}}` `$$` | 字面 `{` `}` `$` |

未解析引用在运行期失败。整串恰为一个引用时，数据算子可保留对象/数字类型；普通模板结果为字符串，对象按无空格 JSON 序列化。

产出绑定的算子：`http.execute`、`digest`、`crypto.encrypt`、`payload.build`、`map`、`auth.capture`、`extract`、`script`。`as` 不可重复。

## 公共页面类型

```ts
type AuthRange = "all" | "none" | string[];
type Target = string | { css: string } | { ariaLabel: string } | { label: string }
  | { name: string } | { placeholder: string } | { text: string };
type AutoLoginTarget = { auto: "login" };
type LoginFormTarget = Target | AutoLoginTarget;
type FrameScope = { frameId?: number; frameUrl?: string };
type SettleCondition =
  | { type: "formGone" } | { type: "urlChanged" }
  | { type: "url"; glob: string }
  | { type: "selector"; target: Target }
  | { type: "cookie"; name: string }
  | { type: "storage"; area: "local" | "session"; key: string }
  | { type: "fixed"; ms: number }
  | { type: "any"; of: SettleCondition[] }
  | { type: "all"; of: SettleCondition[] };
```

页面 URL glob 不渲染 `{origin}` 模板，应写实际匹配的 glob，例如 `*/workspace`。`fill`/`click` 可附加 FrameScope；frame 不匹配不会静默回退。

## 17 个算子

### 清理与导航

```ts
{ op: "clear.cookies"; range: AuthRange; includeParent?: boolean }
{ op: "clear.storage"; area: "local" | "session"; range: AuthRange }
{ op: "goto"; url: Ref; waitForLoad?: boolean; waitForTarget?: Target; timeoutMs?: number; when?: Ref }
```

`goto.waitForLoad` 默认 true；`waitForTarget` 在导航后轮询等待唯一可见的表单目标，超时报告当前地址及重定向 / 本地登录态检查提示；`when` 为 `undefined/null/false/""/0` 时跳过。

### HTTP 与请求改写

```ts
{
  op: "http.execute";
  url: Ref;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"; // 默认 GET
  headers?: Record<string, Ref>;
  body?: { json: Record<string, unknown> } | { raw: Ref } | { ref: string };
  parse?: "json" | "text";             // 默认 json，非 JSON 降级为文本
  expectStatus?: "2xx" | number[];    // 默认 2xx
  as: string;                          // 只绑定响应体，不绑定 headers
}
{ op: "apply.set"; target: "header" | "body" | "query"; key: string; value: Ref }
```

- `body.json` 叶子字符串参与模板解析；`body.ref` 引用对象模式 `payload.build`；`raw` 直接发送字符串。
- GET 不发送 body。JSON/ref 按声明 key 序无空格序列化。
- `apply.set` 作用于其后最近的 `http.execute`，随后清空。body 改写支持点路径，不能用于 raw。
- HTTP 2xx 只代表传输/状态符合预期，不证明业务成功或浏览器会话存在。

### 数据变换

```ts
{
  op: "digest"; algorithm: "sha1" | "sha256"; input: Ref;
  inputEncoding?: "utf8" | "ascii" | "latin1";
  outputEncoding?: "hex" | "base64" | "base64url";
  upperCase?: boolean; as: string;
}
{ op: "crypto.encrypt"; algorithm: "rsa-pkcs1v15" | "rsa-oaep"; publicKey: Ref; input: Ref; as: string }
{
  op: "payload.build";
  parts: Array<{ key?: string; value: Ref; normalize?: Array<
    "trim" | "upper" | "lower" | "numericString" | "base64" | "base64url"
  >> }>;
  join?: string;
  as: string;
}
{ op: "map"; input: Ref; cases: Array<{ equals: string | number | boolean; value: Ref }>; default?: Ref; as: string }
```

- digest 默认 utf8 输入、hex 输出、小写；RSA 输出 base64，OAEP 使用 SHA-256。
- `payload.build` 每个 part 都有 key 时为对象模式且不能写 join；否则为字符串模式，join 默认空串。normalize 按声明顺序执行。
- `map` 严格 `===`；无命中使用 default，无 default 则 `CONFIG_INVALID`。这一异常可在 auth.write 前阻断业务拒绝，但不是理想 `LOGIN_REJECTED`。

### 会话

```ts
{ op: "auth.write" }
{
  op: "auth.capture";
  cookies?: AuthRange; localStorage?: AuthRange; sessionStorage?: AuthRange;
  as: string;
}
{ op: "auth.restore"; snapshot: string } // 不含 $，必须来自前序 auth.capture
```

`auth.capture` 三个范围默认 `none`。快照包含 origin、完整 Cookie 记录及声明范围内的 Storage。restore 先清同名项，再按快照恢复；目标 origin 不符会失败。

```ts
interface AuthSpec {
  mode: "engine" | "page";
  cookiesWrite?: Array<{
    name: string; value: Ref;
    domain?: string;             // 缺省 host-only
    path?: string;               // 默认 /
    secure?: boolean | "auto";  // 默认 auto：https → true
    httpOnly?: boolean;          // 默认 false
    sameSite?: "unspecified" | "lax" | "strict" | "no_restriction";
    expiresFrom?: { from: string; path: string; unit: "epochMs" | "epochS" | "iso" | "relativeSeconds" };
  }>;
  localStorageWrite?: Array<{ key: string; value: Ref }>;
  sessionStorageWrite?: Array<{ key: string; value: Ref }>;
}
```

`mode:"page"` 时 auth.write 是空操作。engine Storage 写入要求当前 tab 位于目标 origin。Cookie expiry 的 epochS/epochMs 是秒/毫秒时间戳，relativeSeconds 相对当前时间。

### DOM 与逃生舱

```ts
{ op: "fill"; target: LoginFormTarget; value: Ref; clearFirst?: boolean; frameId?: number; frameUrl?: string }
{ op: "click"; target: LoginFormTarget; onNotFound?: "fail" | "skip"; frameId?: number; frameUrl?: string }
{ op: "waitFor"; when: SettleCondition; timeoutMs?: number }
{
  op: "extract"; source: "local" | "session" | "dom" | "url" | "cookie";
  key?: string; parse?: "raw" | "jsonValue"; default?: string; as: string;
}
{ op: "script"; code: string; world?: "MAIN" | "ISOLATED"; as: string }
```

- fill 默认先清空；click 默认找不到即失败。
- `{ auto: "login" }` 只允许出现在标准 `fill{username} → fill{password} → click` 的三项 target 上，可带一个 goto 和 clear/auth 辅助算子。缺项、混用、顺序错误、额外 auto 字段或用于 waitFor/extract 都是 `CONFIG_INVALID`。
- 自动运行时复用同一表单扫描，只有同 frame 三项齐全、frame 唯一且三个推荐 Target 均唯一才执行；同 frame 多表单、多 frame、缺项和非唯一都不会猜第一个。扫描结果只在本运行缓存，不自动持久化。
- 首个自动算子前仍无密码框时最多 `reloadTabAndWait(settleMs)` 一次；不完整、歧义、注入失败、填写/点击之后及成功条件失败都不刷新。
- 历史原版默认模板的三个空 target 仅按完整模板精确兼容为自动；自定义/改过的三空定位仍拒绝。保存编辑结果时写显式 auto，不批量迁移 storage。
- extract 的 local/session/cookie/dom 通常需要 key；url 的 key 是 query 参数，缺省取整个 URL。空值有 default 则回退，否则失败。
- script 是不能进入策略包的逃生舱，不得用它规避可表达性或安全限制。

## 保存期 R1–R7

| 规则 | 要求 |
|---|---|
| R1 成功先行 | engine auth.write/auth.capture 位于成功信号绑定产出之后；page 信号还要求位于最后 DOM 交互之后。page mode 只豁免 auth.write。 |
| R2 数据流可达 | `$x` 必须引用前序已产出的绑定；auth 写入值在 auth.write 位置检查。 |
| R3 跨 origin 写入 | targetUrl/debugRedirect 导航与 auth.write/capture/restore 必须按捕获 → 导航 → 恢复排序。 |
| R4 输入已声明 | `{name}` 必须在内置、vars 或 aux 命名空间。 |
| R5 绑定唯一 | 同一 spec 的 `as` 不重复。 |
| R6 算子前置 | apply.set 后有 HTTP；body.ref 来自对象 payload；restore 引用前序 capture；payload 两模式不混用。 |
| R7 成功信号有效 | success 非空，递归 anyOf 也不能为空。 |

## 会话门控范例

```json
{ "op": "map", "input": "$login.code", "cases": [{ "equals": 0, "value": "$login.data" }], "as": "accepted" }
```

配套唯一成功信号：

```json
{ "response": { "from": "login", "path": "code", "equals": 0 } }
```

后续只从 `$accepted.*` 或其安全派生绑定读取会话值及 expiry。直接使用 `$login.data.token` 不符合本 Skill 的质量门禁。
