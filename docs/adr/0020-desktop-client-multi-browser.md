# ADR-0020: 桌面客户端 ShadeKit Desktop（Tauri）—— 复用登录引擎，双浏览器后端

- **日期**: 2026-10-26
- **状态**: 草案 · 修订 1（P0 spike 已全部通过，见 `docs/spikes/0020-p0a-chrome/RESULTS.md`；本修订吸收 spike 的 6 处修正，并把宿主缝从「模拟 `chrome.*`」改为引擎自有的 `HostBridge`）
- **修订 1 要点**:
  1. D3：宿主缝改为 `HostBridge` 意图接口，取消「引擎零改动」的承诺（改为「引擎一次性机械迁移后，两端共享且由类型/lint 守住」）。
  2. D1/D2：CDP/BiDi 协议驱动从 Rust 移到 TS，Rust 只做进程、字节转发、HTTP、钥匙串；Chromium 改用 `--remote-debugging-pipe`。
  3. 新增 D9 命名、D10 仓库与模块边界、D11 分发与签名；环境角标提到 MVP；明确配置单一来源。
- **背景**: 账号切换目前以浏览器扩展形态提供：登录发生在用户日常浏览器的**当前标签页**里，靠 `chrome.tabs` / `chrome.cookies` / `chrome.scripting` 完成「清会话 → 发请求 → 写会话 → 刷新」。用户需要桌面客户端形态，诉求四条：复用现有 JSON 配置、可配置打开的浏览器、Chrome/Edge 支持匿名模式、**点击账号即打开浏览器并完成登录**。同时要求支持 Firefox。
  
  两个前置事实决定了方案形状：
  1. **登录能力不在 JSON 里**。`devtools-account-switch` 只是声明式配置，真正执行的是 `spec/run.ts` 的 17 个算子（约 6.8k 行）+ 约 6.4k 行策略/视图层。重写引擎 = 重做这 1.3 万行及其 20+ 个测试文件。
  2. **Firefox 141 起 CDP 已被彻底移除**，`remote.active-protocols` 偏好一并删除（129 起默认关闭，140 ESR 是最后一个可回退版本）。跨浏览器不存在「统一用 CDP」这个选项。
- **范围**: 同仓新增 `engine/`（`@shadekit/engine`，登录引擎）与 `desktop/`（Tauri 2 应用），根目录启用 npm workspaces，扩展保持在根目录不搬迁（D10）。引擎内对 `chrome.*` 的直接调用迁移到 `HostBridge`（D3），扩展提供 `chrome` 实现、桌面端提供协议实现。不改 `LoginSpec` 格式、不改配置包 `dt-login-config/v1`、**不改扩展的用户可见行为**（迁移由现有登录链路测试兜底）。
- **关联**: ADR-0012（通用登录配方）、ADR-0014 D2（LoginSpec）、ADR-0015 D1/D7（算子与 `auth.write`）、ADR-0017 D2（三个对象、两条轴）、ADR-0019（策略库与镜像）、ADR-0016（配置白名单导出）。

---

## 备选方案评审

### S1. 把引擎移植到 Rust —— 否决

| 维度 | 影响 |
|---|---|
| 工作量 | 17 个算子 + 模板求值 + 校验器（1233 行）+ 迁移链（509 行）全部重写，2–3 个月起步 |
| 长期成本 | 扩展与客户端两份引擎并行演进，登录声明的语义漂移不可避免 |
| 收益 | 只有「交付形态是纯 Rust」这一条，与功能目标无关 |

### S2. Rust 拉起浏览器 + 扩展桥（`externally_connectable`）—— 否决

Rust 启动受管 profile，扩展装在里面，控制页通过 `chrome.runtime.sendMessage` 把「切哪个账号」转给扩展，扩展用**未修改的引擎**执行。

- 保真度最高（CORS、iframe、时序全部沿用扩展语义），工作量最小（2–3 周）。
- **但 Chrome 137 起品牌版移除了 `--load-extension`**，无法自动把扩展装进受管 profile，每个 profile 需要用户手工安装一次；无痕上下文默认不加载扩展、也不继承「允许在无痕中运行」。产品体验不可接受。
- 被否决，但保留作为「方案 B 保真度不达标」时的回退路径。

### S3. Tauri 2 外壳 + 复用 TS 引擎（采纳）

Vue UI 与 TS 引擎跑在 WebView 里（等价于今天的 background），引擎经 `HostBridge` 调用宿主能力；桌面端的 `HostBridge` 实现用 TS 协议驱动（CDP / WebDriver BiDi）操控浏览器，Rust 只负责拉进程与转发字节。

- 引擎是同一份源码、同一套测试，登录语义与扩展一致。
- 需要新写的是**执行底座**：`HostBridge` 桌面实现 + 两个协议驱动（spike 的 `cdp.mjs` + `bidi.mjs` 约 970 行可作起点），Rust 约 500 行。
- 代价：不再注入网页，页面内的 Dock / 拾取器需要重做或降级（见 D7）；引擎需先做一次宿主缝迁移（D3）。

### S4. 直接用 Puppeteer 作为浏览器驱动 —— 否决

Puppeteer 同时支持 CDP 与 BiDi，看似省掉两个驱动。否决理由：依赖体积大；它的 Page/Frame 抽象与 `HostBridge` 之间又多一层语义，排障要穿两层；spike 已证明手写驱动规模可控。若 P2 中驱动维护成本超预期，可重新评估（未在本 ADR 中验证 Puppeteer 在 WebView 内运行的能力）。

---

## 决策

### D1. 分层：WebView 跑引擎与协议驱动，Rust 只做进程、字节转发、HTTP、密钥

- **决策**:
  ```
  ┌─ Tauri 2 ───────────────────────────────────────────────┐
  │  WebView (Vue)                                          │
  │    ├─ desktop UI（账号列表 / 设置，自有视图层）           │
  │    ├─ @shadekit/engine（spec/* + strategies/*，共享）    │
  │    └─ host/desktop-bridge.ts  implements HostBridge     │
  │         ├─ drivers/cdp.ts    Chrome / Edge              │
  │         └─ drivers/bidi.ts   Firefox                    │
  │              │ 协议消息（JSON 帧）                        │
  │              ▼ Tauri Channel                             │
  │  Rust                                                   │
  │    ├─ browser/   路径探测 / 进程拉起 / 端口或 pipe 发现   │
  │    ├─ transport  透明转发：pipe(Chromium) / WS(Firefox)  │
  │    ├─ http.rs    reqwest，返回原始 Set-Cookie            │
  │    └─ secrets.rs keyring                                │
  └──────────────────────────────────────────────────────────┘
  ```
- **理由**:
  - 引擎放在 WebView：**扩展与客户端共享同一份源码与同一套测试**，这是唯一能避免语义漂移的结构。
  - 协议驱动放在 TS：spike 的 6 处修正全部是协议细节（事件需显式启用、OOPIF、cookie 包装），这类代码需要被频繁调试、并能用 vitest 对录制的协议帧做回放测试。放在 Rust 里，最易错的部分落在团队最不熟、测试最难写的一层。
  - Rust 只承担不可替代的部分：拉进程、持有 pipe/socket、绕过 CORS、读写系统钥匙串。Rust 侧不理解协议语义，只按连接 id 转发帧。
- **被否决**: 引擎下沉到 Rust 侧运行（需嵌入 JS 运行时）；引擎复刻到 Rust（S1）；协议驱动写在 Rust `BrowserBackend` trait（修订 1 前的方案，理由见上）。

### D2. 双浏览器后端：Chrome/Edge 走 CDP，Firefox 走 WebDriver BiDi

- **决策**: TS 侧两个驱动（`drivers/cdp.ts` / `drivers/bidi.ts`），共同实现 `HostBridge`（D3）：

  | | Chrome / Edge | Firefox |
  |---|---|---|
  | 协议 | CDP | WebDriver BiDi |
  | 启动 | `--remote-debugging-pipe --user-data-dir=<dir>` | `--remote-debugging-port 0 --profile <dir> -no-remote` |
  | 协议入口 | fd 3（写）/ fd 4（读），消息以 `\0` 分隔；Rust 持有 pipe | 读 profile 根目录 `WebDriverBiDiServer.json` 得端口 → `ws://127.0.0.1:P/session`，连接后必须先发 `session.new` |
  | 隔离上下文 | `Target.createBrowserContext` | `browser.createUserContext` |
  | 外部依赖 | 无 | 无（BiDi 内置于 Firefox remote agent，**不需要 geckodriver**） |

- **为什么 Chromium 用 pipe 而不是端口**: 调试端口对本机**所有进程**开放，连上即可读走全部隔离上下文的 cookie——包括生产环境账号的会话。pipe 只有父进程（Rust）持有，无监听端口、无需 `--remote-allow-origins`。Windows 上 fd 3/4 的句柄传递需在 P1 实测；不成立时回退 `--remote-debugging-port=0` + `DevToolsActivePort`（spike 已验证）。
- **Firefox 的残余风险**: 标准 Firefox 的 BiDi 只有 WebSocket 入口。端口为随机值且 Remote Agent 默认拒绝带 `Origin` 头的连接（网页无法连入），但本机进程仍可连接。在 UI 安全说明中写明，不在本期解决。
- **Firefox 端口发现的陷阱（spike 修正 1）**: `/json/version` 等 Chrome 风格 HTTP 端点全部 404。复用 profile（`persistent` 模式）启动前**必须先删除** `WebDriverBiDiServer.json`，否则会连到上一轮的僵尸端口。

- **关键论证：不做协议统一**。WebDriver BiDi 理论上两浏览器都支持，但 **Chrome 的 BiDi 由 chromedriver 提供**（Chromium 浏览器本身不实现 BiDi endpoint，chromedriver 再翻译成 CDP）。为「统一」而引入一个需要版本对齐的额外二进制、并多一跳进程内转发，没有收益。
- **Firefox 侧明确不做 CDP**：129 起默认关闭、141 起彻底移除，回退开关 `remote.active-protocols` 也一并删除。任何依赖 `remote.active-protocols=3` 的设计都只有一年寿命。
- **CDP 驱动必须做对的初始化（spike 修正 2、3）**:
  - `Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:false})`，否则新建 tab 拿不到 session；同时处理 `waitingForDebugger`。所有命令按 `sessionId` 路由到同一条连接。
  - `Target.setDiscoverTargets({discover:true})`，否则关闭 tab 不产生 `targetDestroyed`。
  - 每个 page session 上 `Page.enable` + `Page.setLifecycleEventsEnabled({enabled:true})`，否则收不到 `lifecycleEvent`（表现为页面永远 loading）。
- **驱动测试**: 两个驱动以「录制的协议帧 → 回放」做单元测试（vitest），真实浏览器的端到端测试沿用 spike 脚本形态，不进默认 `npm test`。

### D3. 宿主缝：引擎自有的 `HostBridge` 意图接口（取代 `chrome.*` shim）

- **决策**: 引擎不再直接访问 `chrome` 全局，改为依赖一个由引擎定义、按**意图粒度**划分的接口。扩展与桌面端各提供一份实现：

  ```ts
  // engine/host.ts
  export interface HostBridge {
    // —— tab 与导航（等待语义收进实现内部）——
    getTab(tab: TabRef): Promise<TabInfo>;                 // { url, status }，url 现场读取
    openTab(url: string, opts?: { active?: boolean }): Promise<TabRef>;
    navigateAndWait(tab: TabRef, url: string, timeoutMs: number): Promise<void>;
    reloadAndWait(tab: TabRef, timeoutMs: number): Promise<void>;
    focusTab(tab: TabRef): Promise<void>;
    closeTab(tab: TabRef): Promise<void>;
    onTabClosed(tab: TabRef, cb: () => void): () => void;
    // —— 页面内执行（保留扩展 allFrames 语义）——
    evalInFrames<T>(tab: TabRef, fn: (...a: any[]) => T, args: unknown[],
                    opts: { world: "MAIN" | "ISOLATED"; allFrames: boolean }): Promise<FrameResult<T>[]>;
    // —— 会话 ——
    getCookies(filter: CookieFilter): Promise<CookieRecord[]>;
    setCookies(origin: string, cookies: CookieSpec[]): Promise<void>;
    removeCookies(origin: string, names: string[]): Promise<void>;
    // —— 网络（D5）——
    http(req: HttpRequest): Promise<HttpResponse>;
  }
  ```

  `TabRef` 是不透明句柄：扩展里包着 `tabId`，桌面端包着 `{ contextId, targetId }`。隔离上下文由桌面端 bridge 在实例化时绑定，引擎不感知「上下文」概念。

- **为什么不用 `chrome.*` shim（修订 1 前的方案）**:
  - **模拟的是 Chrome 的隐式行为，不是引擎的需求**。spike 的 6 处修正里有 4 处属于这类：`onUpdated` 需显式启用事件、`onRemoved` 需开启发现、`tabs.get().url` 必须靠事件维护缓存且 SPA 下滞后、browser 级没有 `cookies.remove`。shim 要为每一条补一层状态机；意图接口下它们要么消失（`url` 现场读取、`removeCookies` 批量语义），要么收进 `navigateAndWait` 内部。
  - **漂移不可见**。shim 下，扩展侧新用一个 `chrome.*` 字段（如 `changeInfo.url`）能编译、测试全绿、桌面端静默失效。意图接口下，新需求必须先改 `HostBridge`，两个实现都会编译失败，漂移被类型系统拦住。
  - **`chrome` 的全局类型不说明「用到了哪些」**。`@types/chrome` 覆盖数百个 API，`HostBridge` 的十余个方法就是两端必须对齐的全部契约。

- **迁移量（实测）**: 引擎核心直连 `chrome.*` 共 12 个文件、54 处——`utils/tab-load.ts` 16、`spec/snapshot.ts` 8、`utils/auth-snapshot.ts` 8、`spec/session.ts` 7，其余 1–3 处。另有 `login-tab-flow.ts`（被 `spec/run.ts:42` 反向依赖）需一并迁入。均为调用点替换，不改算子语义。

- **桌面端实现映射**（协议细节在驱动内消化，不出现在接口上）：

  | `HostBridge` | CDP | WebDriver BiDi |
  |---|---|---|
  | `getTab` | `Runtime.evaluate("location.href")` + `document.readyState`（现场读取，修正 6） | `browsingContext.getTree({root})` |
  | `openTab` | `Target.createTarget({url, browserContextId})` | `browsingContext.create({type:"tab", userContext})` + `navigate` |
  | `navigateAndWait` | `Page.navigate` + 等 `lifecycleEvent:load`，兜底轮询 `readyState`（修正 2） | `browsingContext.navigate({wait:"complete"})` |
  | `reloadAndWait` | `Page.reload` + 同上 | `browsingContext.reload({wait:"complete"})` |
  | `focusTab` | `Target.activateTarget` | `browsingContext.activate` |
  | `closeTab` / `onTabClosed` | `Target.closeTarget` / `targetDestroyed`（需 discover，修正 3） | `browsingContext.close` / `contextDestroyed` |
  | `evalInFrames(MAIN)` | 同进程 frame：`Runtime.evaluate`；跨源 iframe（OOPIF）：`Target.attachToTarget({flatten:true})` 后求值（修正 5） | `script.evaluate`（无 `sandbox`），frame 来自 `getTree`（含跨源） |
  | `evalInFrames(ISOLATED)` | `Page.createIsolatedWorld` + `Runtime.evaluate` | `script.evaluate`（`sandbox:"shadekit"`） |
  | `getCookies` | `Storage.getCookies({browserContextId})` | `storage.getCookies`（`partition.userContext`） |
  | `setCookies` | `Storage.setCookies({cookies, browserContextId})`（修正 4：browser 级无 `Network.setCookie`） | `storage.setCookie`（逐条，带 `sourceOrigin`） |
  | `removeCookies` | 写空值 + `expires:1`（browser 级无 delete，修正 4） | `storage.deleteCookies` |
  | `http` | Rust `http_execute`（D5） | 同左 |

- **为什么函数可原样下发**: `strategies/generic-target.ts:1-10` 的既有约束是「`domActionInPage` 的全部辅助函数都定义在函数体内，不引用任何模块级变量」——原本为 `executeScript` 序列化而设，**恰好是 `Runtime.evaluate` / `script.evaluate` 需要的形态**。spike 已验证同一份 `fn.toString()` 两协议都通。
- **`allFrames` 归并**: 按 `spec/run.ts` 现有语义——任一 frame 成功即返回该值，全失败才抛错。CDP 侧 frame 来源 = 父 page 的 `frameTree` ∪ 同 `browserContextId` 下 `type:"iframe"` 的 target。
- **BiDi 的两个返回值陷阱**（在驱动里吃掉，不能污染引擎）:
  - `browsingContext.create` **没有 `url` 参数**，`tabs.create({url})` 必须拆成「建 + 导航」两步。
  - `script.evaluate` 返回 RemoteValue，统一用 `JSON.stringify` 包裹 + `serializationOptions:{maxObjectDepth:null,maxDomDepth:0}`，顺带解决 `undefined` 的落空问题。
- **契约守护**（防漂移的唯一机制，必须随迁移一并落地）:
  1. `engine/` 目录用 biome `noRestrictedGlobals` 禁止 `chrome` / `browser` / `document` / `window`（页面内函数体例外，按文件 override）。
  2. `engine/` 的 `package.json` 不声明 `@types/chrome`；`tsconfig` 的 `types` 不含它——引擎里写 `chrome.` 直接类型报错。
  3. `engine/tests/host-contract.ts`：一套与实现无关的行为测试（导航后 `getTab().url` 已更新、`removeCookies` 后读不到、`evalInFrames` 覆盖跨源 iframe 等），对扩展实现（stub 环境）与桌面实现（协议回放）各跑一遍。
- **迁移顺序**: 先在扩展内完成迁移（`HostBridge` + `chrome` 实现），**行为不变、全部现有测试通过**后，才开始写桌面实现。现有测试对 `globalThis.chrome` 的 stub 改为对 `HostBridge` 的 fake，测试意图不变。

### D4. 会话隔离模型：用浏览器上下文，不用 `--incognito`

- **决策**: 默认 `sessionMode = "isolated"`，每个账号一个隔离上下文：

  | 模式 | Chrome / Edge | Firefox | 语义 |
  |---|---|---|---|
  | `isolated`（默认） | `Target.createBrowserContext` | `browser.createUserContext` | 账号间 cookie/storage 互不可见；关掉即清 |
  | `persistent`（后续） | 每账号 `--user-data-dir=<appdata>/profiles/<id>` | 每账号 `--profile <dir> -no-remote` | 重启保留登录态；进程数 = 账号数 |

- **为什么不用 `--incognito` 做隔离单位**: 同一浏览器实例里**所有无痕窗口共享同一个无痕会话**（Google 官方文档明示：首个无痕窗口创建会话，后续无痕窗口都在这同一个会话内；关闭全部无痕窗口才结束）。拿它当「账号隔离」等于把当前扩展「切换即踢掉上一个」的痛点原样搬到桌面端。
- **Firefox 的 `userContext` 是什么**: BiDi 的 `userContext` 在 Firefox 里映射到**容器级 cookie jar**（类似 Multi-Account Containers），隔离的是 web 数据，**不是私密浏览**——不隐藏历史、不绕开追踪保护、不隔离指纹。UI 文案要说清「这是账号隔离，不是隐私模式」。
- **Firefox 的 `userContext` 生命周期**: 由 `browser.createUserContext` 创建、`browser.removeUserContext` 销毁，**不跨会话持久化**（不同于扩展管理的容器）。要在重启后保留登录态，必须走 `persistent` 模式的独立 profile，而不是靠复用 user context id。
- **被否决**: 统一用 `--incognito` / `-private-window`（不隔离）；单实例单 profile 靠反复 `clear.cookies` 切换（这正是要摆脱的现状）。

### D5. `http.execute` 下沉 Rust，`Set-Cookie` 回灌上下文

- **决策**: `spec/http.ts:257` 的 `fetchWithTimeout` 调用点改为 `HostBridge.http()`。扩展实现仍走 `fetch`；桌面实现经 `invoke("http_execute")` 由 Rust `reqwest` 发出，Rust 返回原始响应与 `Set-Cookie` 列表，**由 TS 侧 bridge** 解析后经 `setCookies` 写回当前上下文（CDP `Storage.setCookies` / BiDi `storage.setCookie`），再交给引擎解析响应体。Rust 不理解 cookie 语义，只透传。
- **理由**:
  - 扩展有 `host_permissions: ["http://*/*"]`，fetch 不受 CORS 约束；Tauri 的 WebView 是真实浏览器引擎，跨域 fetch 会被 CORS/CSP 拦。**这是不复用就必然踩的坑。**
  - `Origin` 头：扩展里由浏览器自动补 `chrome-extension://<id>`，部分后端会拒绝。spike 确认引擎本身不设 `Origin`。**决策：桌面端默认不发送 `Origin`**（与引擎显式意图一致）；若某环境需要，由 LoginSpec 的 `headers` 显式声明，不在 Rust 里隐式补。
  - reqwest 不启用 cookie jar，与现有引擎的隐式行为一致——现有代码本就不带 `credentials:"include"`，cookie 全靠 `auth.write` 显式写。
- **不变量**: 服务端返回的 `Set-Cookie` **必须**回灌，否则表现为「登录接口 200 但页面仍登出」，是最典型的翻车点。
- **BiDi 的 cookie 写入细节**（驱动内消化）: 值需类型包装 `{"type":"string","value":"..."}`；`partition` 需带 `userContext`，且 **Firefox 强制要求 `sourceOrigin`** 才会真正落到站点上。`HostBridge.setCookies(origin, …)` 的签名把 `origin` 作为必填参数，正是为此；`spec/session.ts` 的 `writeCookie()` 调用点 `origin` 已在作用域内。
- **spike 已验证**: 真实 `runHttpExecute` + invoke 转发 + `Set-Cookie` 回灌，两段式流程等价；页面内跨源 fetch 确实被 CORS 拦（`Failed to fetch`）。

### D6. 配置分层：兼容层与会话层分开

- **决策**: 两份文件，职责不重叠。

  ```
  shadekit-config.json     ← 与扩展完全兼容，原样读写
  { "__version": 2, "account-switch": { accounts, domains, strategies, envBadge, ... } }

  client.json              ← 桌面端独有，扩展不认
  {
    "browsers": {
      "chrome":  { "path": "auto", "args": [] },
      "edge":    { "path": "auto", "args": [] },
      "firefox": { "path": "auto", "args": [] }
    },
    "defaultBrowser": "chrome",
    "sessionMode": "isolated",
    "firefox": { "minVersion": 140 }
  }
  ```

- **理由**: 把 `browser` / `sessionMode` 塞进 `account-switch` 会污染扩展配置——`getAllConfig` 按注册表白名单导出，这些客户端字段会跟着回到扩展里。客户端设置本来就只属于客户端。
- **兼容性**: `shadekit-config.json` 直接消费「全部工具设置」导出（`options/App.vue` 的 `getAllConfig` 产物）里的 `account-switch` 子键，形状不变；`account-env-view.ts` 的 `detectImportKind` / `planImport` 可直接复用。
- **凭据落盘**: `Account.password`、`DomainConfig.defaultPassword`、`strategyParams.clientSecret` 在扩展里是**明文**（README §9 明写）。桌面端这些字段必须走系统钥匙串（`keyring` crate: macOS Keychain / Windows Credential Manager / Secret Service），JSON 里只留空值。
  - 钥匙串条目：service = `dev.shadekit.desktop`（与 bundle identifier 一致，D9），account = `<kind>:<id>`，如 `account:<Account.id>`、`domain:<domainId>:defaultPassword`。**service 名定下后不再改**——改名等于所有已存凭据失联。
  - 记录格式随引擎 `Account` / `DomainConfig` 类型演进；字段形状变化时，桌面端必须提供钥匙串迁移，与配置 `__version` 迁移同步执行。
- **配置来源（MVP）**: 两端**不做双向同步**。桌面端的配置来源是「导入扩展导出的全部工具设置文件」，导入即为桌面端本地副本；提供「重新导入（覆盖）」与「导出」，不做合并。双向同步依赖 ADR-0016 的 WebDAV 管线——该 ADR 已接受但**尚未实现**（`entrypoints/tools/` 下无 `webdav-sync`），实现后另立 ADR 接入。UI 上明确标注「桌面端配置独立于浏览器扩展」。
- **版本策略**: 读到的 `__version` 高于当前支持值时**拒绝导入并给出明确提示**，不猜测、不降级处理。
- **不变量（沿用 ADR-0019）**: 环境的登录声明可能只是**镜像**库条目（`strategyId` 指向 `strategies[id]`，运行期实时读取），不得在客户端里物化成内联 spec，否则与扩展的策略库语义分叉。

### D7. 页面内能力：明确降级清单

扩展有四项能力依赖「注入网页」，桌面端不再有 content script：

| 能力 | 现状 | 桌面端处理 |
|---|---|---|
| Dock 面板（`Alt+Shift+A` 网页内唤出） | `content/index.ts` | ❌ 改为 Tauri 窗口 + 全局快捷键。能力不丢，入口换位置 |
| 环境角标（`EnvIndicator.ts`） | 页面右下角 badge | ✅ **MVP 必做**（见下）：CDP `Page.addScriptToEvaluateOnNewDocument` / BiDi `script.addPreloadScript` 常驻注入「环境 · 账号」标签 |
| 元素拾取器（`config/target-picker.ts`） | 页面上框选登录框 | ⚠️ 成本高（覆盖层 + 事件接管重写，约 300–400 行），P3 再评估 |
| 登录表单扫描（`config/login-form-scan.ts`） | 一次 `executeScript` | ✅ 一次 `evalInFrames`，成本低，随 P2 交付 |

- **决策**: Dock 明确降级为 Tauri 窗口；拾取器排到 P3；**环境角标提为 MVP**。
- **为什么角标是 MVP**: 扩展里同一时刻只有一个账号在线，角标是辅助。桌面端的卖点是多账号并存——三个隔离上下文就是三个**外观完全相同**的浏览器窗口，没有标识时在错误账号（尤其是生产环境）上操作是必然事故。标识分两层：
  1. 页面内角标：复用 `EnvIndicator` 的视觉规范，按环境色 + 账号名渲染。注入脚本按 context 绑定参数，重连后重新注册；以 DOM 标记去重。
  2. 窗口标题前缀：preload 脚本改写 `document.title` 为 `[环境 · 账号] 原标题`，并用 `MutationObserver` 维持。任务栏与窗口切换器里即可区分。
- **注意**: 注入脚本运行在 ISOLATED world / sandbox，不污染页面全局；生产环境（`envBadge` 标记为生产的环境）的角标不可在页面内关闭。

### D8. 已知语义缺口：没有「当前活动标签」

- **决策**: `chrome.tabs.query({active:true, currentWindow:true})`（`background-handler.ts:44`）在 CDP/BiDi 里**没有直接等价物**——`Target.getTargets` 与 `browsingContext.getTree` 都不返回可见性或焦点状态。
- **处理**: 该调用属于扩展的编排层（`background-handler.ts`），不进入 `HostBridge`。桌面端的入口是「在账号列表点一个账号」，tab 由桌面端自己打开并持有 `TabRef`，不需要「推断当前页」。spike 已验证 `document.visibilityState` 轮询可行，保留为将来「从当前窗口推环境」的实现路径，MVP 不做。

### D9. 命名

| 项 | 值 |
|---|---|
| 产品名 / 安装名（`productName`） | ShadeKit Desktop |
| 可执行文件 / 目录 / npm 包 | `shadekit-desktop`（目录为仓库内 `desktop/`） |
| Tauri `identifier` | `dev.shadekit.desktop` |
| 钥匙串 service | `dev.shadekit.desktop`（D6） |
| 引擎包 | `@shadekit/engine`（workspace 内部包，`private: true`，不发布） |

- **为什么安装名带 Desktop**: 扩展与桌面端同机共存是常态（共用配置文件），裸名 `ShadeKit` 会让 issue、文档、口头沟通都产生歧义；钥匙串 service 名与应用名绑定，事后改名会导致已存凭据失联，只能一次定对。
- **不做**: `CFBundleName` 与 `CFBundleDisplayName` 取不同值——菜单栏与访达显示不一致，排障成本高。

### D10. 仓库与模块边界：同仓 workspaces，扩展留在根目录

- **决策**:
  ```
  shadekit/
  ├── package.json        # 扩展本体 + workspaces: ["engine", "desktop"]
  ├── entrypoints/        # 扩展，路径不变
  │   └── tools/account-switch/
  │       ├── host/chrome-bridge.ts   # HostBridge 的 chrome 实现
  │       └── 编排层 / 视图层（login-tab-flow 余下部分、account-view、background-handler、Config.vue …）
  ├── engine/             # @shadekit/engine：spec/ strategies/ 纯工具 utils/ host.ts tests/
  └── desktop/            # ShadeKit Desktop：src/（Vue + bridge + drivers）src-tauri/
  ```
- **进 `engine/` 的**: `spec/`、`strategies/`、`types.ts` 中引擎类型、`utils/` 里与宿主无关的部分（`error-codes`、`parse-text`、`fetch-retry`、`validate-*`、`debug-log`）、迁移后的 `tab-load` / `host-cookies` / `auth-snapshot`、`login-tab-flow` 中被 `spec/run.ts` 依赖的导航意图逻辑。
- **不进 `engine/` 的**: 页面内运行的 `EnvIndicator.ts` / `show-page-toast.ts` / `spa-route.ts`（依赖 DOM，属于扩展宿主能力）；`config/` 下的拾取器与表单扫描（依赖页面注入，各宿主各写）；所有 Vue 组件；`shared/tool-config.ts` 等存储读写。**视图层不共享**：扩展 UI 嵌在网页与 popup 里，桌面 UI 是独立窗口，交互模型不同；共享 `.vue` 会把 UnoCSS / Vue 版本纠缠进引擎。纯计算的视图模型（如 `account-env-view.ts` 的 `detectImportKind` / `planImport`）可在去除 `chrome` 依赖后进入 `engine/`。
- **为什么同仓**: 两端必须保证登录语义完全一致，锁步演进是需求而非限制。同仓下改一个算子，一次 `npm test` 同时验证两端；分仓需要版本发布与依赖升级流程，换来的独立节奏在这里没有用。
- **为什么扩展不搬进 `packages/extension/`**: wxt 配置、`public/`、`tests/`、CI、`scripts/release.mjs`、README 图片路径都要改，对已发布的扩展是纯风险。
- **代价与对策**:
  - CI：Tauri 需 Rust 工具链。拆两个 workflow，按路径过滤（`desktop/**` 触发桌面构建；`engine/**` 同时触发两端测试）。
  - `scripts/release.mjs` 与 `wxt zip` 不得把 `desktop/` 的源码与产物打进扩展包；`engine/` 只以被 import 的模块进入 bundle。E1 验收时比对扩展包体积。
  - `biome.json`、`vitest.config.ts`、`tsconfig.json` 需覆盖 `engine/`，并排除 `desktop/src-tauri/target/`。
- **可逆性**: 将来出现独立发布节奏、第三方消费引擎、或 CI 时长不可接受时，`git subtree split --prefix=engine` 可连同历史拆出独立仓库。

### D11. 分发与签名：P1 定方案，不拖到最后

- **决策**: 签名方案在 P1 确定并接入 CI，而不是 P3。
- **理由**:
  - macOS 未签名/未公证的应用会被 Gatekeeper 拦截，开源用户的首次体验是「无法打开」。
  - **钥匙串访问控制与代码签名绑定**：未签名或签名身份变化的版本，每次更新都会重新弹「允许访问钥匙串」；D6 把密码放进钥匙串，签名身份必须从第一个公开版本起保持稳定。
  - Windows SmartScreen 对未签名安装包同样会拦截。
- **待定（需维护者决策）**: macOS Developer ID（年费）+ 公证；Windows 代码签名证书或 Azure Trusted Signing；Linux 先只提供 AppImage / deb，不签名。自动更新使用 Tauri updater，更新包签名密钥单独保管，不进仓库。

---

## 后果

### 正面

- **一份引擎、两个宿主、类型守住边界**：`spec/*`、`strategies/*` 及迁移后的工具函数由两端共享，登录相关的 30 个测试文件继续有效。宿主契约是十余个方法的 `HostBridge`，新增宿主能力必须先改接口，两端实现同时编译失败——漂移无法静默发生。
- **扩展先受益**：E1 让扩展的引擎与 `chrome` 解耦，测试从 stub 全局改为 fake 接口，更易写、更稳定；该阶段可独立发版。
- **配置零迁移**：现有「全部工具设置」导出可直接被客户端导入，无需新格式、无需重新录入。
- **多账号并存**：浏览器上下文让「A 账号和 B 账号同时在线、互不干扰」成为可能，而现在的扩展每次切换都要 `clear.cookies` 把上一个踢掉。
- **Firefox 不引入额外二进制**：BiDi 内置于浏览器，无 geckodriver 依赖、无版本匹配问题。
- **协议细节可测**：驱动在 TS 中，以协议帧回放做单元测试；未来接 Safari / WebKit 只需新增一个驱动。
- **Chromium 无监听端口**：pipe 模式下本机其他进程无法连入受管浏览器读取会话。

### 负面 / 风险

- **无法接管用户日常浏览器**：Chrome 136 起，默认 profile 不再接受 `--remote-debugging-port`（必须配非默认 `--user-data-dir`）。客户端只能养自己的受管 profile，首次使用是**全新环境**（无历史、无既有登录态、无用户装的扩展）。
- **扩展失去天然入口**：桌面端不再随网页存在，`Alt+Shift+A` 从「页面内唤出」变成「全局快捷键唤出独立窗口」。
- **页面内能力退化**：拾取器、Dock 需要重做或降级；角标以注入方式重做（D7）。
- **E1 触碰扩展已发布的登录链路**：虽为机械替换，仍是回归风险源。对策：E1 不混入任何功能改动；迁移前后对真实环境各跑一遍主流策略的冒烟登录。
- **两套视图层**：扩展与桌面 UI 不共享组件，账号/环境的展示逻辑需各写一份（纯计算部分可共享）。这是有意的取舍，见 D10。
- **首次登录时序可能变化**：扩展跑在用户日常 profile（带广告拦截、脚本注入扩展），受管 profile 是干净的。`waitFor` / `pollPageSignals` 的 settle 行为要用真实环境复核。
- **CSP 行为反转**：`Runtime.evaluate` / `script.evaluate` 不受页面 CSP 约束，而扩展的 `executeScript` MAIN world **受**约束。原来被 CSP 挡住的页面在桌面端反而能跑通——这是能力增强，但排障时容易误判为「不应该能跑」。
- **桌面端与扩展的配置会分叉**：MVP 是单向导入、两端各自持有副本（D6），两边分别修改后不会自动合并。用户需要知道「改完扩展要重新导入」，UI 文案与文档必须讲清。双向同步待 ADR-0016 实现后另议。
- **Firefox 仍有本机调试端口**：标准 Firefox 的 BiDi 无 pipe 入口（D2），本机进程可连入。安全说明中写明。
- **导入不可信来源需收紧**：`spec.op === "script"` 是任意 JS。配置包导出时已拒绝（`spec/package.ts` 的 `findScriptOps`），但**原始备份里可能有**。桌面端从不受信来源导入时应拒绝含 `script` 算子的声明。

### 明确不做

- 不做 Firefox CDP 兼容（协议已移除）。
- 不做「接管用户默认浏览器实例」。
- 不在本期做 `persistent` 会话模式（配置文件留位，实现排 P3）。
- MVP 不做扩展与桌面端的双向配置同步（D6）。
- 不共享 Vue 视图层组件（D10）。
- 不发布 `@shadekit/engine` 到 npm（D9）。

---

## 验证

### P0 spike（已完成）

P0a（Chrome/Edge）5 条、P0b（Firefox）8 条全部通过，34/34 用例；环境 macOS 15.5 · Chrome 155 · Edge 156 · Firefox 158。详见 `docs/spikes/0020-p0a-chrome/RESULTS.md`。spike 的 6 处修正已并入 D2、D3、D5：

| # | 修正 | 落点 |
|---|---|---|
| 1 | Firefox 端口发现读 `WebDriverBiDiServer.json`；复用 profile 前须删除 | D2 |
| 2 | `lifecycleEvent` 需 `setLifecycleEventsEnabled` | D2、D3 `navigateAndWait` |
| 3 | `targetDestroyed` 需 `setDiscoverTargets` | D2、D3 `onTabClosed` |
| 4 | browser 级无 `Network.setCookie/deleteCookies`，用 `Storage.*` 与过期写入 | D3 `setCookies` / `removeCookies` |
| 5 | 跨源 iframe 是 OOPIF，需 `attachToTarget` | D3 `evalInFrames` |
| 6 | `tabs.get().url` 缓存滞后（自发导航、`pushState`） | D3 `getTab` 现场读取 |

### P0c（修订 1 新增，P1 开工前完成）

1. **窗口隐藏/最小化时引擎仍按时执行**：Tauri 主窗口最小化或仅剩托盘时，WKWebView（macOS）/ WebView2（Windows）对定时器与 Promise 的节流程度；登录流程中的 `waitFor` 不得因此超时。不成立时，引擎改在常驻的隐藏窗口里运行，或在 Tauri 配置中关闭后台节流。
2. **`--remote-debugging-pipe` 在 macOS / Windows 均可由 Rust 子进程持有 fd 3/4**（D2）。
3. **10 个隔离上下文并存**的内存与稳定性（spike 只验证了 2 个）。
4. **Windows / Linux 的浏览器路径探测与进程退出**（spike 仅 macOS）。

### 遗留（不阻塞 MVP）

- `browser.setClientWindowState` 在 Linux 等平台的支持度（影响 `focusTab` 的 Firefox 实现，失败时降级为 `browsingContext.activate`）。
- persistent 模式必须用 BiDi `browser.close` 关闭 Firefox，`SIGTERM` 会丢 cookie（spike 已验证，P3 实现时遵守）。

---

## 分阶段计划

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0a / P0b | Chrome、Firefox spike | ✅ 已完成 |
| P0c | 后台节流、pipe、10 上下文、跨平台探测（见「验证」） | 2–3 天 |
| **E1** | **引擎宿主缝迁移（仅动扩展）**：定义 `HostBridge`、写 `chrome-bridge.ts`、迁移 12 个文件 54 处调用、测试 stub 改为 fake；启用 workspaces 并抽出 `engine/`；落地契约守护（D3）。**验收：扩展行为不变，全部现有测试通过，扩展包体积不变**，可单独发版 | 1–1.5 周 |
| P1 | Tauri 2 骨架、桌面 UI（账号列表 / 设置）、配置导入导出、钥匙串、浏览器探测与选择；**签名与 CI 打包接入**（D11） | 1.5–2 周 |
| P2 | 两个 TS 驱动 + `desktop-bridge` + Rust transport / `http_execute` + 错误码/日志透传 + **环境角标与窗口标题前缀**（D7）+ 表单扫描；契约测试对桌面实现跑通 | 3–4 周 |
| P3 | 多账号并存打磨、全局快捷键、拾取器、persistent 模式 | 1–2 周 |

**MVP = E1 + P1 + P2**。E1 先于桌面端任何代码，且独立交付价值（引擎边界清晰化）；若桌面端中途搁置，E1 的成果不浪费。

**代码量预估**：Rust 约 500 行（进程与探测 200、transport 150、http 100、钥匙串 50）；TS 驱动约 1000–1200 行（spike 的 `cdp.mjs` 682 + `bidi.mjs` 291 为起点）；`chrome-bridge.ts` 约 200 行。

---

## 相关

- 引擎入口：`entrypoints/tools/account-switch/spec/run.ts`（`runSpec`）、`spec/login-run.ts`（`runLoginSpec`）
- 会话算子：`spec/session.ts`（`runAuthWrite` / `clear.cookies` / `clear.storage`）
- 快照：`spec/snapshot.ts`、`utils/auth-snapshot.ts`
- Tab 编排：`login-tab-flow.ts`、`utils/tab-load.ts`、`login-session.ts`
- DOM 执行：`strategies/generic-target.ts`（`domActionInPage`，单函数自包含，可直接下发）
- HTTP 算子：`spec/http.ts`（`runHttpExecute`，D5 的替换点）、`utils/fetch-timeout.ts`
- 配置读写：`shared/tool-config.ts`、`shared/config-transfer.ts`、`account-env-view.ts`（`detectImportKind` / `planImport`）
- 密码落盘位置：`types.ts` 的 `Account.password`、`DomainConfig.defaultPassword`、`strategyParams.clientSecret`
- E1 迁移热点（`chrome.*` 调用数）：`utils/tab-load.ts` 16、`spec/snapshot.ts` 8、`utils/auth-snapshot.ts` 8、`spec/session.ts` 7、`spec/run.ts` 3、`strategies/generic-settle.ts` 3、`utils/host-cookies.ts` 3；反向依赖 `spec/run.ts:42 → login-tab-flow.applyNavigationIntent`
- spike 代码（驱动起点）：`docs/spikes/0020-p0a-chrome/cdp.mjs`、`bidi.mjs`；结果 `RESULTS.md`

---

## 参考资料

- [Changes to remote debugging switches to improve security — Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port)（Chrome 136 起默认 profile 不再接受调试端口）
- [Deprecating CDP Support in Firefox — fxdx.dev](https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/)
- [CDP Retirement in Firefox — fxdx.dev](https://fxdx.dev/cdp-retirement-in-firefox/)（141 彻底移除）
- [Removing ChromeDevTools Support For Firefox — Selenium](https://www.selenium.dev/blog/2025/remove-cdp-firefox/)
- [Create a WebDriver BiDi connection — MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection)
- [session.new — MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/session/new)
- [browser module（user context 语义）— MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browser)
- [browser.createUserContext — MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/browser/createUserContext)
- [BiDi cookie partition 支持 userContext — Mozilla Phabricator D201965](https://phabricator.services.mozilla.com/D201965)
- [ChromeDriver 文档（Chrome 的 BiDi 由 chromedriver 提供）](https://developer.chrome.com/docs/chromedriver/)
- [Firefox/CommandLineOptions — Mozilla Wiki](https://wiki.mozilla.org/index.php?title=Firefox/CommandLineOptions)
- [Browse in Incognito mode — Google Chrome Help](https://support.google.com/chrome/answer/9845881)（同一实例的无痕窗口共享会话）
- [PSA: Removing --load-extension flag in Chrome branded builds](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)
