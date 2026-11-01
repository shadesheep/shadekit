# LoginSpec v2 契约基线

LoginSpec 是声明式登录流程的共享数据契约。扩展与 Desktop 各自实现校验器、执行器、页面驱动和宿主适配；本文件及其公开示例只描述数据语义，不是任何一端的运行时代码依赖。

## 1. 顶层声明与通用规则

| 字段 | 类型与默认值 | 语义 |
| --- | --- | --- |
| `version` | 必填，v2 为 `2` | 声明能力版本；见 [版本规则](#8-版本规则)。 |
| `template` | 可选字符串 | 模板显示与新建用途，不参与运行分派。修改它不需要提升声明版本。 |
| `vars` | 可选对象数组 | 每项含 `name`、可选 `title`、`default`、`secret`。声明 `{name}` 输入；环境覆盖优先于非空默认值。`secret` 表示敏感值，不能进入策略分享包。 |
| `aux` | 可选对象 | `nonce: "auto"`、`timestamp: "auto"` 声明引擎生成的随机数与毫秒时间戳输入。 |
| `ops` | 必填非空数组 | 按声明顺序执行的 17 类算子；每个算子只能完成其声明动作，未知算子不得静默跳过。 |
| `success` | 必填非空数组 | 顶层为 AND；每项为 `response`、`token`、`page` 或 `anyOf`。`anyOf` 内为 OR，嵌套保持同样语义。 |
| `failure` | 可选条件数组 | 任一条件成立即拒绝登录；检查优先于同周期的成功判定。 |
| `auth` | 必填对象 | `mode: "engine"` 或 `"page"`，以及可选会话写入声明，详见第 5 节。 |
| `limits` | 可选对象 | `requestMs` 默认 15000、`stepMs` 默认 5000、`settleMs` 默认 10000，均须为大于 0 的有限毫秒数。 |
| `log` | 可选对象 | `reveal` 为允许原样展示的绑定名数组；不能覆盖秘密输入、秘密派生值及敏感字段的黑名单脱敏。 |

### 模板与绑定

- `{name}` 读取已声明输入，`$name` 或 `$name.path` 读取先前算子产出的绑定。
- 内置输入为 `username`、`password`、`origin`、`targetUrl`、`debugRedirect`；`vars` 和 `aux` 提供其他输入。
- 整串为单个绑定的变换输入可保留对象、数字等类型；普通插值输出字符串。未解析输入或绑定是运行错误，不能以空字符串代替。
- `http.execute`、`digest`、`crypto.encrypt`、`payload.build`、`map`、`auth.capture`、`extract`、`script` 用 `as` 产生绑定；同一声明中 `as` 必须唯一。
- 执行失败时停止后续算子并返回结构化失败；运行轨迹只包含公开目标、状态、耗时和错误，不能泄露密码、token、Cookie/Storage 值或可重放认证快照。

### 条件与成功/失败

`SettleCondition` 支持：
- `formGone`：密码输入框从基准状态消失；
- `urlChanged`：URL 相对基准变化；
- `url: { glob }`：URL 匹配声明；
- `selector: { target }`：元素定位条件；
- `cookie: { name }`、`storage: { area, key }`：会话值存在条件；
- `fixed: { ms }`：固定等待；
- `any: { of }` / `all: { of }`：OR / AND 组合。

`response` 读取 `$from.path`；声明 `equals` 时要求精确相等，否则要求值为真。`token` 要求 `$from.path` 存在且为真。页面条件在轮询中求值；顶层全部成功信号满足才算成功，未满足时报 `SUCCESS_CONDITION_UNMET`，命中失败条件报 `LOGIN_REJECTED`，识别到验证码报 `CAPTCHA_REQUIRED`。

### 元素定位

`Target` 为 CSS 字符串或 `{ css }`、`{ ariaLabel }`、`{ label }`、`{ name }`、`{ placeholder }`、`{ text }` 对象。`fill`、`click` 可附 `frameId` / `frameUrl`，限定到记录的 frame。找不到、非唯一、定位语法错误、frame 消失分别报 `ELEMENT_NOT_FOUND`、`AMBIGUOUS_TARGET`、`SELECTOR_INVALID`、`FRAME_NOT_FOUND`；不得任意选一个匹配元素。标准表单整组自动定位使用 `{ "auto": "login" }`，仅限连续的用户名、密码、登录按钮三步。

## 2. 17 个算子

### `clear.cookies`

- 字段：`range`（必填，`"all"`、`"none"` 或 Cookie 名数组）；`includeParent`（可选，默认 `false`）。
- 副作用：删除当前登录 origin 对应范围内的 Cookie；`includeParent: true` 才纳入父域。
- 结果：`none` 不执行删除；缺失会话能力报 `HOST_CAPABILITY_MISSING`，宿主删除失败使登录失败。

### `clear.storage`

- 字段：`area`（必填，`"local"` / `"session"`）；`range`（必填，`"all"`、`"none"` 或键名数组）。
- 副作用：清除当前页面指定存储区域；`all` 清空该区域，数组只删指定键，`none` 不删除。
- 结果：缺少页面能力报 `HOST_CAPABILITY_MISSING`；不得把 localStorage 写到另一个 origin。

### `goto`

- 字段：`url`（必填模板）；`waitForLoad`（默认 `true`）；`waitForTarget`（可选具体 `Target`）；`timeoutMs`（默认 `limits.settleMs`）；`when`（可选模板）。
- 副作用：导航当前受控页面。`when` 仅 `""`、`0`、`false`、`null`、`undefined` 为假，跳过并记录 skipped。
- 结果：导航成功后推进受控 origin；加载或目标等待失败停止流程。无效 URL 报 `INVALID_URL`，超时按加载/等待阶段报 `TAB_LOAD_TIMEOUT` 或相应定位错误。

### `http.execute`

- 字段：`url`、`as` 必填；`method` 默认 `GET`，支持 `GET`、`POST`、`PUT`、`DELETE`、`PATCH`；`headers` 为模板字符串字典；`body` 为 `{ json: object }`、`{ raw: template }`、`{ ref: binding }` 三选一；`parse` 默认 `"json"`，亦可 `"text"`；`expectStatus` 默认 `"2xx"`，或整数状态码数组。
- 副作用：发送一次完整构造好的请求，超时为 `limits.requestMs`。JSON 和对象引用按无空格 JSON 序列化；GET 不发送请求体。结构化 body 的叶子字符串参与模板解析，保留其他 JSON 类型。
- 结果：响应绑定到 `as`。默认把响应文本解析为 JSON，解析失败时保留原始文本；`text` 始终保留文本。状态不匹配报 `LOGIN_FAILED`，宿主超时/网络错误分别报 `REQUEST_TIMEOUT` / `NETWORK_ERROR`。响应绑定不等同于登录成功，仍须满足成功信号。

### `digest`

- 字段：`algorithm`（`"sha1"` / `"sha256"`）；`input`、`as` 必填；`inputEncoding` 默认 `"utf8"`，支持 `"ascii"`、`"latin1"`；`outputEncoding` 默认 `"hex"`，支持 `"base64"`、`"base64url"`；`upperCase` 默认 `false`。
- 副作用：无页面或会话副作用；对解析后的输入字节计算摘要。
- 结果：摘要绑定到 `as`；可选整体大写。不支持的新算法是能力问题，不能按 SHA-256 降级执行。

### `crypto.encrypt`

- 字段：`algorithm`（`"rsa-pkcs1v15"` / `"rsa-oaep"`）；`publicKey`、`input`、`as` 必填。
- 副作用：无页面或会话副作用。PKCS#1 v1.5 使用 RSA 公钥加密；OAEP 使用 RSA-OAEP + SHA-256。公钥接受 PEM 或 base64 DER。
- 结果：base64 密文绑定到 `as`；公钥无效或加密失败报 `RSA_ENCRYPT_ERROR`。不支持的新算法不能退回另一种 padding。

### `payload.build`

- 字段：`parts` 必填非空；每项含 `value`、可选 `key`、可选 `normalize`；`join` 和 `as` 见下述两种互斥模式。
- 副作用：无页面或会话副作用。
- 字符串模式：所有 part 无 `key`，`join` 必填（可为 `""`），依次拼接。对象模式：所有 part 有 `key`，不得声明 `join`，生成对象供 `body.ref` 等使用。混用报 `CONFIG_INVALID`。
- `normalize` 依声明顺序应用 `trim`、`upper`、`lower`、`numericString`、`base64`、`base64url`。`numericString` 去除非数字并保留前导负号；两种 base64 规则只转换编码变体，不把普通文本编码成 base64。

### `map`

- 字段：`input`、`cases`、`as` 必填；`cases[].equals` 为字符串、数字或布尔值，`value` 为模板；`default` 可选模板。
- 副作用：无页面或会话副作用。
- 结果：输入与 `equals` 严格相等时输出对应值，否则输出 `default`；无匹配且无默认值报 `CONFIG_INVALID`。

### `apply.set`

- 字段：`target`（`"header"` / `"body"` / `"query"`）；`key`、`value` 必填。
- 副作用：暂存改写，只作用于其后最近的 `http.execute`，随后清空；不自行发送请求。
- 结果：header 覆盖同名头，query 写入 URL 参数，body 按点路径写入 JSON 或对象引用 body。raw body 不可改写，报 `CONFIG_INVALID`；后续没有请求同样报 `CONFIG_INVALID`。

### `auth.write`

- 字段：仅 `op`；实际内容来自顶层 `auth`。
- 副作用：`auth.mode: "page"` 时为空操作；`"engine"` 时写入声明的 Cookie、localStorage、sessionStorage。
- 结果：写入前验证目标 origin；缺失会话/页面能力报 `HOST_CAPABILITY_MISSING`，错误 origin 或写入失败报 `INJECT_AUTH_FAILED` 或相应宿主错误。HTTP 成功但会话写入失败不能报告完整登录成功。

### `auth.capture`

- 字段：`as` 必填；`cookies`、`localStorage`、`sessionStorage` 可选，范围均为 `"all"`、`"none"` 或字符串数组，缺省为 `"none"`。
- 副作用：读取当前 origin 的声明会话数据，形成仅存在于本次运行的快照。
- 结果：快照绑定到 `as`。缺少页面/会话能力报 `HOST_CAPABILITY_MISSING`；快照和绑定不能进入公共 DTO、日志或诊断。

### `auth.restore`

- 字段：`snapshot` 必填，必须引用先前 `auth.capture` 的绑定。
- 副作用：在导航后的目标 origin 恢复快照 Cookie 和声明的存储值。
- 结果：恢复前检查实际 origin；失败报 `INJECT_AUTH_FAILED` 或相应宿主错误。该操作仅表示一次运行中的跨 origin 会话搬运，不建立持久会话数据库。

### `fill`

- 字段：`target`、`value` 必填；`clearFirst` 默认 `true`；可附 `FrameScope`。
- 副作用：在唯一匹配的输入元素填入解析后的值，默认先清空。
- 结果：定位失败按通用定位错误停止；单次交互超过 `limits.stepMs` 报 `STEP_TIMEOUT`。密码只能进入本次受控页面输入，不能进入日志或公开结果。

### `click`

- 字段：`target` 必填；`onNotFound` 默认 `"fail"`，亦可 `"skip"`；可附 `FrameScope`。
- 副作用：点击唯一匹配元素；点击前采集页面成功判定基准。
- 结果：`skip` 时未找到元素记录 skipped 并继续，其余定位错误仍失败；超时按 `STEP_TIMEOUT`。

### `waitFor`

- 字段：`when`（必填 `SettleCondition`）；`timeoutMs` 默认 `limits.settleMs`。
- 副作用：等待页面、URL、Cookie 或 Storage 条件；`fixed` 只等待声明毫秒数。
- 结果：条件满足后继续；命中失败条件报 `LOGIN_REJECTED`，超时按等待/成功条件错误停止。

### `extract`

- 字段：`source`（`"local"` / `"session"` / `"dom"` / `"url"` / `"cookie"`）；除无 `key` 的 URL 读取外 `key` 必填；`parse` 默认 `"raw"`，亦可 `"jsonValue"`；`default` 可选字符串；`as` 必填。
- 副作用：只读指定来源；DOM 使用唯一元素定位，Cookie 按当前 origin 域匹配。
- 结果：值绑定到 `as`。`jsonValue` 对字符串尝试 JSON 解析，失败保留原值。空值优先使用 `default`，无默认报 `LOGIN_REJECTED`；来源读取失败保留对应定位或宿主错误。

### `script`

- 字段：`code`、`as` 必填；`world` 默认 `"MAIN"`，亦可 `"ISOLATED"`。
- 副作用：在受控页面执行函数表达式 `(bindings) => value`，传入当前绑定的只读副本；`ISOLATED` 不是安全边界。
- 结果：返回值绑定到 `as`，抛错报 `LOGIN_REJECTED`。不做模板解析。策略分享包中的 `script` 是包级非法；完整备份则可按客户端能力禁用该环境。

## 3. 数据流校验 R1–R7

完整校验作用于当前客户端支持的 v2 声明；返回的结构性问题使用 `CONFIG_INVALID`。规则编号用于公开示例和错误定位：

- **R1 成功先行**：`auth.write` / `auth.capture` 必须位于成功信号引用的绑定产出之后；存在页面成功信号时，还须位于最后一个 DOM 交互之后。`mode: "page"` 只豁免 `auth.write`，不豁免 `auth.capture`。
- **R2 数据流可达**：`$binding` 必须由先前算子产出。成功信号在全部算子后求值；会话写入声明在 `auth.write` 处求值。
- **R3 跨 origin 写入**：显式引用 `{targetUrl}` / `{debugRedirect}` 的跨 origin `goto` 不得先于 `auth.write`；`auth.restore` 必须位于 `goto` 和对应 `auth.capture` 之后。
- **R4 输入已声明**：`{name}` 必须在内置输入、`vars` 或 `aux` 中声明。`script.code` 不参与静态模板校验。
- **R5 绑定唯一**：同一 `as` 不得重复。
- **R6 算子前置**：`apply.set` 后须有合适的 `http.execute`；`auth.restore` 引用 capture 快照；`http.execute.body.ref` 必须引用对象模式 `payload.build`；payload 两种模式不得混用。
- **R7 成功信号**：`success` 至少含一条有效信号；空 `anyOf` 不能代替成功条件。

## 4. 能力检查与保留未来声明

导入与执行分开判断：

1. 文件外壳和公共结构必须可识别、可保留；错误外壳或损坏公共结构可拒绝整个文件。
2. 对每个环境实际生效的声明检查包级 `specVersion`、`spec.version`、全部算子、摘要算法和加密算法。
3. 高版本、未知/未实现算子或未知算法只禁用受影响环境，不迁移、不降级、不删未知字段；原始 JSON、环境变量和账号绑定保留。
4. 可支持的 v2 声明仍须通过完整结构和 R1–R7 校验；畸形 v2 不是“未来能力”，应报告配置无效。
5. 禁用环境不得登录、试登录或发送秘密；允许查看、导出、删除和非执行性账号绑定。每次读取重新派生支持状态，客户端能力增加后无需重新导入即可恢复。
6. 镜像策略不支持时禁用所有绑定环境；禁用状态不写入 `LoginSpec`。

## 5. 会话写入声明

`auth.mode` 为 `"engine"` 时可声明：

- `cookiesWrite[]`：`name`、`value` 必填；`domain` 缺省 host-only；`path` 默认 `"/"`；`secure` 默认 `"auto"`（HTTPS 为 true）；`httpOnly` 默认 false；`sameSite` 默认 `"unspecified"`，亦可 `"lax"`、`"strict"`、`"no_restriction"`。
- `cookiesWrite[].expiresFrom`：可选 `{ from, path, unit }`，从绑定读取过期时间；`unit` 为 `"epochMs"`、`"epochS"`、`"iso"`、`"relativeSeconds"`。无法读取或解析时失败，不写入猜测的过期时间。
- `localStorageWrite[]` / `sessionStorageWrite[]`：每项含 `key`、`value`，在当前受控 origin 写入。

所有值均支持模板；秘密和会话值不得因此进入公开 DTO 或日志。

## 6. 试登录与运行边界

试登录默认只允许 `http.execute`、`apply.set`、`digest`、`crypto.encrypt`、`payload.build`、`map`，以及具有字面量 `default` 的 `extract`；不执行导航、DOM、会话清理、快照或脚本。只有显式 `writeSession` 才允许 `auth.write`。数据成功信号必须满足；仅有页面信号时，成功构造请求并收到预期响应不等于已验证页面登录。

完整登录与试登录都必须先检查声明版本、算子及算法能力，再发生权限申请、导航、HTTP、会话写入或秘密解析等副作用。Content Script 只接收公共 DTO；Background 对 ID 请求重新读取配置、检查绑定和实际 origin，仅解析本次登录所需秘密。

## 7. 公开错误语义

声明结构/规则错误为 `CONFIG_INVALID`；未来声明版本、未知算子、缺失宿主能力分别使用 `SPEC_VERSION_UNSUPPORTED`、`OP_UNSUPPORTED`、`HOST_CAPABILITY_MISSING`。算子专属错误见第 2 节。不同端可有不同的内部错误对象与 trace 展示，但不得把失败、跳过、未实现能力或会话写入失败表示为登录成功。

## 8. 版本规则

三个版本相互独立：
- `LoginSpec.version`：声明能力版本，本基线为 `2`；
- 完整配置备份外壳 `__version`：应用配置迁移版本，与 LoginSpec 不互相替代；
- 策略分享包 `format`：`dt-login-config/v1`，是文件外壳版本，不等于声明版本。

新增算子、新摘要/加密算法，或对既有算子做不兼容字段/语义修改，必须共同约定并提升 LoginSpec 版本。新增/修改模板、模板名称或内置组合不提升版本。UI、执行器 bug 修复、trace、内部错误码变化也不提升声明版本。历史变更见 [CHANGELOG](CHANGELOG.md)，文件格式见 [import-files](import-files.md)。

`docs/contracts/examples/v2-valid.json` 覆盖每个 v2 算子；`v2-invalid.json` 提供未知算子/算法、R1–R7 和会话写入畸形的公开反例。这些文件只供文档消费方和各自测试使用。
