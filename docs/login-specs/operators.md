# 账号切换 · LoginSpec 算子参考手册

本文档完整列出账号切换工具 LoginSpec v2 当前支持的 **17 个算子**，作为编写登录声明（`spec.ops[]`）时的权威参考。

- 类型唯一事实源：`entrypoints/tools/account-switch/spec/types.ts`
- 算子中文名唯一事实源：`SPEC_OP_LABELS`（同文件）
- 执行器：`entrypoints/tools/account-switch/spec/run.ts`（`runSpec()`，唯一执行路径）
- 保存期校验：`entrypoints/tools/account-switch/spec/validate.ts`（R1–R7）

## 0. 全局约定

阅读每条算子前，先理解以下贯穿所有算子的公共机制。

### 0.1 模板字符串（Ref）

`Ref` 是带有模板的字符串，两类引用可同时出现在任何 `Ref` 字段中：

| 语法 | 命名空间 | 示例 |
|------|----------|------|
| `{name}` | 输入（内置输入 / `vars[]` / `aux` / 账号字段） | `{username}` `{origin}` `{publicKey}` |
| `$name` / `$path.to.field` | 绑定（前序算子的 `as` 产出，支持点路径与数组下标） | `$resp.data.token` `$loginData` |

字面量转义：`{{` → `{`、`}}` → `}`、`$$` → `$`。

**未解析即错误**：任一引用在运行期未命中即抛 `TEMPLATE_UNRESOLVED`；保存期同样问题为 `CONFIG_INVALID`（R4）。不再有旧版「原样保留」的退路。

### 0.2 内置输入（`BUILTIN_INPUT_NAMES`）

以下输入由执行器摊平进 `{name}` 命名空间，无需声明：

| 输入 | 来源 |
|------|------|
| `{username}` | 当前登录账号的用户名 |
| `{password}` | 当前登录账号的密码 |
| `{origin}` | 当前登录 origin（`https://host[:port]`） |
| `{targetUrl}` | 快捷登录 / Bug 复现传入的目标 URL（跨 origin 导航触发 R3） |
| `{debugRedirect}` | 环境配置的「Bug 复现地址」（跨 origin 导航触发 R3） |

### 0.3 辅助输入（`aux`）

`spec.aux` 声明由引擎生成的输入，生成后视同内置输入：

| 字段 | 含义 |
|------|------|
| `nonce: "auto"` | 每次登录生成随机 8 位数字 nonce |
| `timestamp: "auto"` | 每次登录取当前毫秒时间戳 |

### 0.4 绑定（Binding）

算子若带 `as: "name"`，执行结果写入绑定表，后续算子用 `$name` 或 `$name.path` 引用。**产出绑定的算子**：`http.execute` / `digest` / `crypto.encrypt` / `payload.build` / `map` / `auth.capture` / `extract` / `script`（`auth.restore` 消费快照不产出新绑定）。同一 spec 内 `as` 不得重复（R5）。

### 0.5 定位描述符（Target）

`fill` / `click` / `waitFor.when = selector` 使用统一的目标描述：

```ts
type Target =
  | string                          // CSS 简写
  | { css: string }
  | { ariaLabel: string }
  | { label: string }
  | { name: string }
  | { placeholder: string }
  | { text: string };
```

- `{ text }` 比较前**去掉全部空白**并**精确优先**（可见完全相等命中就只用它，否则退回子串包含），避免「密码登录 / CA登录 / 短信登录 + 登录按钮」这类页签抢命中
- 自动生成的 id（Element Plus / React / Radix 计数器 id）不参与候选与 CSS 路径；改用 `nth-of-type` 保证唯一
- `fill` / `click` 可附加 `FrameScope`（`frameId` / `frameUrl`）；匹配顺序 `frameId` → `origin + pathname`，SPA 路由变化不误报，两者都不命中报 `FRAME_NOT_FOUND`，**不静默回退**全 frame 搜索

### 0.6 结算条件（SettleCondition）

`waitFor.when`、`success[].page`、`failure[]` 共用：

```ts
type SettleCondition =
  | { type: "formGone" }                                // 表单消失
  | { type: "urlChanged" }                              // URL 变化
  | { type: "url"; glob: string }                       // URL 命中 glob
  | { type: "selector"; target: Target }                // 出现某元素
  | { type: "cookie"; name: string }                    // 出现某 cookie
  | { type: "storage"; area: "local" | "session"; key: string }
  | { type: "fixed"; ms: number }                       // 固定等待
  | { type: "any"; of: SettleCondition[] }
  | { type: "all"; of: SettleCondition[] };
```

### 0.7 三态范围（AuthRange）

`clear.*` / `auth.capture` 共用：`"all" | "none" | string[]`——全部 / 不动 / 白名单键名数组。

### 0.8 超时与限制（`spec.limits`）

| 字段 | 默认 | 作用于 |
|------|------|--------|
| `requestMs` | 15000 | `http.execute` 单次请求（超时 `REQUEST_TIMEOUT`） |
| `stepMs` | 5000 | 单次 DOM 交互：`fill` / `click` / `extract` / `script`（超时 `STEP_TIMEOUT`） |
| `settleMs` | 10000 | 页面条件轮询（`waitFor` / 成功信号）；也是 `goto.timeoutMs` 缺省 |

### 0.9 执行轨迹与日志

- 每个算子产出一条 `RecipeStepTrace`：`{ index, op, target?, status: success|error|skipped, duration, errorCode?, error? }`
- `target` 由 `describeOp` 派生（见下表「轨迹描述」列）
- `http.execute` 的请求/响应会按黑名单脱敏后写入 `state.logView`；`spec.log.reveal` 白名单命中的绑定以 `revealed` 单独入日志
- dev 模式下每一步的开始 / 结束事件实时落入 `auth` 类别日志

---

## 1. 会话清理

### 1.1 `clear.cookies`

按 host（可选含父域）清理 cookie。

```json
{ "op": "clear.cookies", "range": "all", "includeParent": false }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `range` | `AuthRange` | ✓ | — | `all` / `none` / 键名数组 |
| `includeParent` | `boolean` | — | `false` | 为 `true` 时连父域一起清；对 `all` 与白名单都生效 |

- `range: "none"` 直接跳过（返回 0）
- 轨迹描述：`all` / `all (+父域)` / 逗号连接的键名

### 1.2 `clear.storage`

在**目标 origin 的当前 tab 文档内**清理 localStorage 或 sessionStorage。

```json
{ "op": "clear.storage", "area": "local", "range": "all" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `area` | `"local" \| "session"` | ✓ | 目标存储区 |
| `range` | `AuthRange` | ✓ | `all` → `store.clear()`；`none` → 跳过；数组 → 逐键 `removeItem` |

- 轨迹描述：`local:all` / `session:key1,key2` 等

---

## 2. 导航

### 2.1 `goto`

跳转当前 tab 到指定 URL。

```json
{ "op": "goto", "url": "{origin}/login", "waitForLoad": true, "waitForTarget": { "placeholder": "请输入手机号" }, "timeoutMs": 8000, "when": "{needsLoginPage}" }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `url` | `Ref` | ✓ | — | 模板字符串 |
| `waitForLoad` | `boolean` | — | `true` | 为 `false` 时不等 `chrome.tabs.onUpdated complete` |
| `waitForTarget` | `Target` | — | — | 导航后轮询等待唯一可见的登录表单目标；复用 `timeoutMs` |
| `timeoutMs` | `number` | — | `limits.settleMs` | 等待加载完成的超时 |
| `when` | `Ref` | — | — | 求值为假（`undefined/null/false/""/0`）时**跳过本算子**，轨迹记 `skipped` |

- URL 引用 `{targetUrl}` / `{debugRedirect}` 会触发 R3「跨 origin 写入」校验：要求其后存在 `auth.restore` 或 `auth.capture` 配套（同 origin 登录页导航不受此约束）
- 失败错误码：导航本身失败 → `errorCodeOf(e)` 归一化；`waitForLoad` 超时 → `TAB_LOAD_TIMEOUT`；`waitForTarget` 超时 → `ELEMENT_NOT_FOUND`，错误包含当前地址及重定向 / 本地登录态检查提示
- 轨迹描述：URL 原文

---

## 3. HTTP

### 3.1 `http.execute`

发起一次 HTTP 请求，结果写入绑定表。

```json
{
  "op": "http.execute",
  "url": "{origin}/base/user/login",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "Accept-Language": "$acceptLanguage",
    "nonce": "{nonce}",
    "sign": "$sign"
  },
  "body": { "ref": "loginData" },
  "parse": "json",
  "expectStatus": "2xx",
  "as": "resp"
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `url` | `Ref` | ✓ | — | 模板字符串 |
| `method` | `GET\|POST\|PUT\|DELETE\|PATCH` | — | `GET` | |
| `headers` | `Record<string, Ref>` | — | — | 值参与模板解析 |
| `body` | 三选一（见下） | — | — | |
| `parse` | `"json" \| "text"` | — | `"json"` | 非 JSON 响应自动降级为原始文本 |
| `expectStatus` | `"2xx" \| number[]` | — | `"2xx"` | 不匹配报 `LOGIN_FAILED` |
| `as` | `string` | ✓ | — | 绑定名（写入解析后的响应体） |

**body 三形态**：

| 形态 | 形状 | 说明 |
|------|------|------|
| 结构化 JSON | `{ "json": { ... } }` | 叶子字符串参与模板解析；按声明 key 序无空格序列化 |
| 原始字符串 | `{ "raw": "$tpl" }` | 直接发字符串；不能承载 `apply.set(body)` 改写 |
| 引用绑定对象 | `{ "ref": "loginData" }` | 深拷贝绑定值后序列化；绑定表不被污染 |

- `GET` / `HEAD` 不带请求体（即使声明了 body 也忽略）
- 超时 `limits.requestMs` → `REQUEST_TIMEOUT`；网络层 TypeError → `NETWORK_ERROR`
- URL 无法解析 → `INVALID_URL`
- 轨迹描述：`POST {origin}/base/user/login`

### 3.2 `apply.set`

**作用于其后最近的一个 `http.execute`**。改写其 header / body / query。

```json
{ "op": "apply.set", "target": "header", "key": "X-Trace", "value": "{traceId}" }
{ "op": "apply.set", "target": "body",   "key": "ext.traceId", "value": "{traceId}" }
{ "op": "apply.set", "target": "query",  "key": "_t", "value": "{timestamp}" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | `"header" \| "body" \| "query"` | ✓ | 改写位置 |
| `key` | `string` | ✓ | header 名 / query 参数名 / body 点路径（中间缺失自动创建为对象） |
| `value` | `Ref` | ✓ | 解析后的字面量值 |

- `header` 改写**覆盖**同名头；`query` 并入 `URL.searchParams`；`body` 改写要求请求体为 `json` / `ref` 形态（改写 `raw` 报 `CONFIG_INVALID`）
- 改写随 `http.execute` 落位后**清空**，不会误作用到再下一个请求
- 声明了 `apply.set` 但其后没有 `http.execute`：保存期 R6 预警；运行期真遇到仍报 `CONFIG_INVALID`（绝不留悬空改写）
- 轨迹描述：`header.X-Trace` / `body.ext.traceId` / `query._t`

---

## 4. 数据变换

数据变换算子都是纯函数 / 纯异步计算，只读写模板上下文与绑定表。

### 4.1 `digest`

对 `input` 求摘要。

```json
{
  "op": "digest",
  "algorithm": "sha256",
  "input": "$signInput",
  "inputEncoding": "utf8",
  "outputEncoding": "hex",
  "upperCase": false,
  "as": "sign"
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `algorithm` | `"sha1" \| "sha256"` | ✓ | — | WebCrypto `subtle.digest` |
| `input` | `Ref` | ✓ | — | 模板字符串；空输入合法 |
| `inputEncoding` | `"utf8" \| "ascii" \| "latin1"` | — | `"utf8"` | `ascii` / `latin1`：每字符一字节，>0xFF 截断为低 8 位 |
| `outputEncoding` | `"hex" \| "base64" \| "base64url"` | — | `"hex"` | 行内实现 base16 / base64（零依赖） |
| `upperCase` | `boolean` | — | `false` | 输出转大写 |
| `as` | `string` | ✓ | — | 绑定名 |

- 轨迹描述：`sha256`

### 4.2 `crypto.encrypt`

RSA 加密，输出 base64。

```json
{
  "op": "crypto.encrypt",
  "algorithm": "rsa-pkcs1v15",
  "publicKey": "{publicKey}",
  "input": "{password}",
  "as": "xstr"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `algorithm` | `"rsa-pkcs1v15" \| "rsa-oaep"` | ✓ | `pkcs1v15` 走 `jsencrypt`（WebCrypto 不实现）；`oaep` 走 WebCrypto `RSA-OAEP + SHA-256` |
| `publicKey` | `Ref` | ✓ | PEM 或裸 base64 DER，二选一 |
| `input` | `Ref` | ✓ | 明文模板 |
| `as` | `string` | ✓ | 绑定名 |

- 公钥无效 / 加密失败（明文过长、密钥不符） → `RSA_ENCRYPT_ERROR`
- 轨迹描述：`rsa-pkcs1v15` / `rsa-oaep`

### 4.3 `payload.build`

拼装字符串或有序对象。

**字符串模式**（`join` 必填，可为空串）：

```json
{
  "op": "payload.build",
  "join": "",
  "parts": [
    { "value": "{nonce}" },
    { "value": "{timestamp}" },
    { "value": "$loginData" }
  ],
  "as": "signInput"
}
```

**对象模式**（每个 part 带 `key`，无 `join`）：

```json
{
  "op": "payload.build",
  "parts": [
    { "key": "loginType", "value": "1" },
    { "key": "username", "value": "{username}" },
    { "key": "xstr",      "value": "$xstr" }
  ],
  "as": "loginData"
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `parts[]` | 数组 | ✓ | — | 按声明序作用 |
| `parts[].key` | `string` | 对象模式必填 | — | 与 `join` 互斥；校验器 R6 拦截混用 |
| `parts[].value` | `Ref` | ✓ | — | 整串恰为一个引用时保留对象 / 数字类型，否则按模板字符串解析 |
| `parts[].normalize` | `NormalizeRule[]` | — | — | 该 part 的归一化规则（按声明顺序逐个作用） |
| `join` | `string` | 字符串模式必填 | `""` | 连接符 |
| `as` | `string` | ✓ | — | 绑定名 |

**归一化规则**（`NormalizeRule`）：

| 规则 | 行为 |
|------|------|
| `trim` | 去首尾空白 |
| `upper` | 转大写 |
| `lower` | 转小写 |
| `numericString` | 去非数字字符，保留前导负号（`-123abc` → `-123`） |
| `base64` | base64url → base64：`-_` → `+/`，补齐尾部 `=` |
| `base64url` | base64 → base64url：`+/` → `-_`，去尾部 `=` |

- 轨迹描述：`对象` / `字符串`

### 4.4 `map`

精确相等匹配的查表。

```json
{
  "op": "map",
  "input": "$pageLanguage",
  "cases": [
    { "equals": "en", "value": "en-US,en" }
  ],
  "default": "zh-CN,zh",
  "as": "acceptLanguage"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `input` | `Ref` | ✓ | 待匹配的输入（求值后保留原始类型） |
| `cases[]` | 数组 | ✓ | `{ equals: string\|number\|boolean, value: Ref }` |
| `default` | `Ref` | — | 无命中时的回退值 |
| `as` | `string` | ✓ | 绑定名 |

- 匹配为**严格 `===`**（规格「精确相等匹配」）
- 无命中且无 `default` → `CONFIG_INVALID`
- 轨迹描述：`→ acceptLanguage`

---

## 5. 会话写入

### 5.1 `auth.write`

按 `AuthSpec` 的声明写入 cookie 与 storage。本算子不携带参数，所有字段在 `spec.auth` 上。

```json
{
  "ops": [ ..., { "op": "auth.write" } ],
  "auth": {
    "mode": "engine",
    "cookiesWrite": [
      {
        "name": "auth",
        "value": "$resp.data",
        "domain": "example.com",
        "path": "/",
        "secure": "auto",
        "httpOnly": false,
        "sameSite": "unspecified",
        "expiresFrom": { "from": "resp", "path": "data.expiredTime", "unit": "epochMs" }
      }
    ],
    "localStorageWrite": [
      { "key": "auth",  "value": "$resp.data" },
      { "key": "token", "value": "$resp.data.token" }
    ],
    "sessionStorageWrite": []
  }
}
```

**`auth.mode`**：

| 值 | 含义 |
|----|------|
| `"engine"` | 由引擎写 cookie + storage（本算子生效） |
| `"page"` | 页面自管会话，`auth.write` 是空操作（登录请求/表单提交后由站点自己写会话） |

**`cookiesWrite[]`（CookieWrite）**：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `name` | `string` | — | cookie 名 |
| `value` | `Ref` | — | 模板；字面 JSON 对象会在导入时被 `escapeLiteralBraces` 自动转义 |
| `domain` | `string` | host-only | 前导点表示子域通配 |
| `path` | `string` | `/` | |
| `secure` | `boolean \| "auto"` | `"auto"`（https → `true`） | |
| `httpOnly` | `boolean` | `false` | |
| `sameSite` | `"unspecified" \| "lax" \| "strict" \| "no_restriction"` | `"unspecified"`（不写该属性，与历史行为 byte 级一致） | |
| `expiresFrom` | `{ from, path, unit }` | — | 从绑定表取值作为过期时间；`unit` ∈ `epochMs` / `epochS` / `iso` / `relativeSeconds` |

**`localStorageWrite[]` / `sessionStorageWrite[]`（StorageWrite）**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 键名 |
| `value` | `Ref` | 模板字符串 |

- **storage 写入必须在目标 origin 的当前文档内**：origin 不符报 `INJECT_AUTH_FAILED`，绝不静默写错 origin
- `expiresFrom` 的绑定路径不存在 → `LOGIN_REJECTED`；`iso` 解析失败 → `LOGIN_REJECTED`
- 本算子**不产出绑定**

### 5.2 `auth.capture`

在**登录 origin**捕获 cookie 与 storage 快照，写入绑定。

```json
{
  "op": "auth.capture",
  "cookies": "all",
  "localStorage": ["auth", "token"],
  "sessionStorage": "none",
  "as": "snap"
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `cookies` | `AuthRange` | `"none"` | `all` / 白名单数组 |
| `localStorage` | `AuthRange` | `"none"` | 同上 |
| `sessionStorage` | `AuthRange` | `"none"` | 同上 |
| `as` | `string` | ✓ | 绑定名 |

**产出形状**（`CapturedSnapshot`）：

```ts
{
  origin: string;                          // 捕获时的 origin
  cookies: CookieRecord[];                 // 完整字段（domain/path/secure/httpOnly/sameSite/expirationDate）
  localStorage?: Record<string, string>;   // 仅声明范围非 none 时存在
  sessionStorage?: Record<string, string>;
}
```

- 轨迹描述：`→ snap`

### 5.3 `auth.restore`

在**目标 origin 的当前文档内**恢复快照。

```json
{ "op": "auth.restore", "snapshot": "snap" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `snapshot` | `string` | ✓ | 绑定名（不含 `$` 前缀） |

**执行顺序**（不变量）：

1. 按快照捕获的 cookie 名单，先 `clearHostCookies` 清同名键
2. 若快照声明了 storage（字段存在即视为声明，与是否抓到键无关）→ 校验当前 tab 位于目标 origin，否则报 `INJECT_AUTH_FAILED`
3. 写回 cookie（保留 domain / path / secure / httpOnly / sameSite / 过期）
4. 写回 storage：先清同一批键再写（幂等恢复）

- `snapshot` 绑定不存在或形状不符 → `CONFIG_INVALID`
- 消费快照不产出新绑定
- 轨迹描述：`快照 snap`

---

## 6. DOM 子集

DOM 算子复用 `strategies/generic-recipe.ts` 的 `Target` / `FrameScope` / `SettleCondition`，跨 frame + shadow root 深查询。

### 6.1 `fill`

向表单元素填值。

```json
{ "op": "fill", "target": { "name": "username" }, "value": "{username}", "clearFirst": true, "frameUrl": "https://idp.example.com/login" }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `target` | `Target` | ✓ | — | 定位描述符（见 §0.5） |
| `value` | `Ref` | ✓ | — | 模板字符串 |
| `clearFirst` | `boolean` | — | `true` | 填值前先清空 |
| `frameId` | `number` | — | — | `FrameScope`：导航期间稳定 |
| `frameUrl` | `string` | — | — | `FrameScope`：导航后重定位 |

- 找不到元素 → `ELEMENT_NOT_FOUND`；多命中歧义 → `AMBIGUOUS_TARGET`；选择器非法 → `SELECTOR_INVALID`；frame 不命中 → `FRAME_NOT_FOUND`
- 单次 `stepMs` 超时 → `STEP_TIMEOUT`
- 轨迹描述：`describeTarget(target)`

### 6.2 `click`

点击元素。

```json
{ "op": "click", "target": { "text": "登录" }, "onNotFound": "fail" }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `target` | `Target` | ✓ | — | 定位描述符 |
| `onNotFound` | `"fail" \| "skip"` | — | `"fail"` | `skip` 时找不到不报错，轨迹记 `skipped` |
| `frameId` / `frameUrl` | `FrameScope` | — | — | 同 `fill` |

- **执行前先刷新 settle 基准**（点击可能触发表单提交跳转，避免 `formGone` / `urlChanged` 误判）
- 轨迹描述：`describeTarget(target)`

### 6.3 `waitFor`

等待页面条件满足。

```json
{ "op": "waitFor", "when": { "type": "url", "glob": "**/dashboard" }, "timeoutMs": 8000 }
{ "op": "waitFor", "when": { "type": "fixed", "ms": 500 } }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `when` | `SettleCondition` | ✓ | — | 结算条件（见 §0.6） |
| `timeoutMs` | `number` | — | `limits.settleMs` | 轮询超时 |

- `fixed` 类型直接 `setTimeout`，不走 settle 轮询
- 轮询期间会并行评估 `failure[]` 条件——**失败优先**：任一命中立即中止
- 轮询超时报 `SUCCESS_CONDITION_UNMET` 或按失败条件命中报 `LOGIN_REJECTED` / `CAPTCHA_REQUIRED`
- `waitFor` 归 `settleMs`，**不**套 `stepMs`（`stepMs` 只约束 `fill` / `click` / `extract` / `script`）
- 轨迹描述：`describeCondition(when)`

### 6.4 `extract`

从页面 / URL / cookie / storage 提取一个值，写入绑定。

```json
{ "op": "extract", "source": "local", "key": "language", "parse": "jsonValue", "default": "zh", "as": "pageLanguage" }
{ "op": "extract", "source": "url",   "key": "ticket",    "as": "ticket" }
{ "op": "extract", "source": "dom",   "key": "#csrf",     "as": "csrf" }
{ "op": "extract", "source": "cookie","key": "sessionid", "as": "sid" }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `source` | `"local" \| "session" \| "dom" \| "url" \| "cookie"` | ✓ | — | 数据源 |
| `key` | `string` | 视 source | — | `local` / `session` / `cookie` / `dom` 必填；`url` 缺省时取整个 URL |
| `parse` | `"raw" \| "jsonValue"` | — | `"raw"` | `jsonValue` 把取到的字符串再 `JSON.parse` 一次（如 `"en"` → `en`）；对五个来源一致生效 |
| `default` | `string` | — | — | 取到空值时回退到字面量，**而非报错**（试登录时 `default` 是 `extract` 唯一的允许路径） |
| `as` | `string` | ✓ | — | 绑定名 |

- `source: "url"`：`key` 为 query 参数名；解析失败或参数缺失返回 `null`
- `source: "cookie"`：按 cookie 的 domain 与登录 origin host 匹配（host-only 或子域通配），取第一个匹配的 `name=key` 值
- `source: "dom"`：跨 frame + shadow root 定位，唯一命中才读值；找不到 / 歧义 / 选择器非法按算子错误码抛
- 取到 `null` / `undefined` / `""`：声明了 `default` 就回退，否则报 `LOGIN_REJECTED`
- 轨迹描述：`local:language` / `url?ticket` / 等

### 6.5 `script`

在当前 tab 执行一段页面脚本，结果写入绑定。**逃生舱**——分享 / 导入时会被明确标为不可序列化风险。

```json
{ "op": "script", "code": "return document.querySelector('meta[name=csrf]').content;", "world": "MAIN", "as": "csrf" }
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `code` | `string` | ✓ | — | 页面脚本源码（通过 `chrome.scripting.executeScript` 执行） |
| `world` | `"MAIN" \| "ISOLATED"` | — | `"MAIN"` | 执行世界 |
| `as` | `string` | ✓ | — | 绑定名（脚本的返回值） |

- 执行前先刷新 settle 基准（脚本可能提交表单 / 触发跳转）
- 单次 `stepMs` 超时 → `STEP_TIMEOUT`
- 轨迹描述：`undefined`（不展示 target）

---

## 7. 校验规则速查（保存期 R1–R7）

| 规则 | 内容 |
|------|------|
| R1 成功先行 | `auth.write` / `auth.capture` 必须位于其成功信号引用的绑定产出之后；`mode: "page"` 只豁免 `auth.write` |
| R2 数据流可达 | 引用 `$x` 的算子必须位于产出 `x` 的算子之后 |
| R3 跨 origin 写入 | `goto` 引用 `{targetUrl}` / `{debugRedirect}` 时，要求其后存在配套的 `auth.capture` → `auth.restore` |
| R4 输入已声明 | `{name}` 必须在输入命名空间中（内置 + vars + aux） |
| R5 绑定唯一 | 同一 spec 内 `as` 不得重复 |
| R6 算子前置 | `apply.set` 之后必须有 `http.execute`；`auth.restore.snapshot` 必须引用一个 `auth.capture` 产出；`payload.build` 字符串 / 对象模式互斥 |
| R7 成功信号至少一条 | `success[]` 非空 |

---

## 8. 成功 / 失败信号

```ts
type SuccessSignal =
  | { response: { from: string; path: string; equals?: unknown } }  // 绑定路径的值
  | { token:    { from: string; path: string } }                    // 绑定路径非空即视为 token
  | { page:     SettleCondition }                                   // 页面条件
  | { anyOf:    SuccessSignal[] };                                  // 任一命中
```

- `success[]` 至少一条（R7），**顶层所有信号都满足（AND）才登录成功**；`anyOf` 内任一子信号满足（OR）即该组满足
- `failure[]` 是 `SettleCondition[]`，**失败优先**：任一命中即中止（如命中验证码特征报 `CAPTCHA_REQUIRED`）
- `response.from` 引用绑定名，`response.path` 是点路径（`resp.data.success`），`equals` 为严格相等匹配

---

## 9. 完整示例

下面的虚构示例展示「读取语言 → 映射 → 加密 → 构造请求 → 签名 → 提交 → 写入会话」的算子组合。变量需由使用方自行配置，示例不对应任何实际系统：

```json
{
  "version": 2,
  "template": "example-api-login",
  "vars": [{ "name": "publicKey", "title": "测试公钥" }],
  "aux": { "nonce": "auto", "timestamp": "auto" },
  "ops": [
    { "op": "extract", "source": "local", "key": "language", "default": "zh", "as": "language" },
    { "op": "map", "input": "$language", "cases": [{ "equals": "en", "value": "en-US,en" }], "default": "zh-CN,zh", "as": "acceptLanguage" },
    { "op": "crypto.encrypt", "algorithm": "rsa-pkcs1v15", "publicKey": "{publicKey}", "input": "{password}", "as": "encryptedPassword" },
    { "op": "payload.build", "parts": [{ "key": "username", "value": "{username}" }, { "key": "password", "value": "$encryptedPassword" }], "as": "loginData" },
    { "op": "payload.build", "join": "", "parts": [{ "value": "{nonce}" }, { "value": "{timestamp}" }, { "value": "$loginData" }], "as": "signInput" },
    { "op": "digest", "algorithm": "sha256", "input": "$signInput", "outputEncoding": "hex", "as": "sign" },
    {
      "op": "http.execute",
      "url": "{origin}/api/login",
      "method": "POST",
      "headers": { "Content-Type": "application/json", "Accept-Language": "$acceptLanguage", "nonce": "{nonce}", "timestamp": "{timestamp}", "sign": "$sign" },
      "body": { "ref": "loginData" },
      "as": "resp"
    },
    { "op": "map", "input": "$resp.code", "cases": [{ "equals": 0, "value": "$resp.data" }], "as": "accepted" },
    { "op": "auth.write" }
  ],
  "success": [{ "response": { "from": "resp", "path": "code", "equals": 0 } }],
  "auth": {
    "mode": "engine",
    "cookiesWrite": [{ "name": "auth", "value": "$accepted.token", "expiresFrom": { "from": "accepted", "path": "expiredTime", "unit": "epochMs" } }],
    "localStorageWrite": [{ "key": "auth", "value": "$accepted" }, { "key": "token", "value": "$accepted.token" }]
  },
  "limits": { "requestMs": 15000, "stepMs": 5000, "settleMs": 10000 }
}
```

新建环境时的内置默认声明（`defaultLoginSpec()`）：

```json
{
  "version": 2,
  "template": "generic",
  "ops": [
    { "op": "clear.cookies", "range": "all" },
    { "op": "fill",  "target": "", "value": "{username}", "clearFirst": true },
    { "op": "fill",  "target": "", "value": "{password}", "clearFirst": true },
    { "op": "click", "target": "", "onNotFound": "fail" },
    { "op": "auth.write" }
  ],
  "success": [
    { "page": { "type": "any", "of": [{ "type": "formGone" }, { "type": "urlChanged" }] } }
  ],
  "auth": { "mode": "engine" },
  "limits": { "requestMs": 15000, "stepMs": 5000, "settleMs": 10000 }
}
```

---

## 10. 相关文档

- `entrypoints/tools/account-switch/README.md` — 账号切换系统总览
- `docs/adr/0014-unified-login-spec-engine.md` — 统一登录声明执行引擎决策
- `docs/adr/0015-login-spec-completion.md` — 17 个算子的完整决策记录（D1–D13）
- `docs/adr/0019-strategy-library.md` — 登录策略库
- `docs/login-specs/README.md` — 策略包导入与公开仓库约定
