# ADR-0020 P0 Spike 验证结果

- **日期**: 2026-10-26
- **状态**: 已完成（P0a / P0b 全通过；附带发现 6 处 ADR 需修正）
- **环境**: macOS 15.5 · Chrome 155.0.8059.85 · Edge 156.0.4314.42 · Firefox 158.0.1
- **代码**: `docs/spikes/0020-p0a-chrome/`（可复跑，不参与构建）

## 结论

**ADR-0020 的核心假设成立**：TS 引擎可以零改动跑在 WebView 里，通过 CDP（Chrome/Edge）与
WebDriver BiDi（Firefox）驱动真实浏览器完成「建上下文 → 导航 → 写会话 → 刷新 → 登录成功」。
两个浏览器的隔离上下文（`createBrowserContext` / `createUserContext`）都做到了账号间
cookie 互不可见，且 `domActionInPage.toString()` 在两种协议下都能原样下发。

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `run.mjs`（Chrome） | 15/15 | P0a 1–4、D3 序列化、D4 隔离、D5 CORS、D8 可见性、CSP |
| `run-events.mjs` | 5/5 | 302 自发导航、onUpdated/onRemoved、SPA、headed 渲染 |
| `run-http.mjs` | 4/4 | 真实 `runHttpExecute` + invoke shim + Set-Cookie 回灌 |
| `run-firefox.mjs` | 10/10 | P0b 1–8、sandbox storage、跨源 iframe |
| Edge 同路径 | PASS | 同 CDP 代码，仅二进制不同 |

## 逐条对照 ADR 验证清单

### P0a — Chrome / Edge

| # | 假设 | 结果 | 备注 |
|---|---|---|---|
| 1 | 独立 `--user-data-dir` + `--remote-debugging-port=0` → `DevToolsActivePort` | ✅ | 端口与 wsPath 两行格式稳定 |
| 2 | `setAutoAttach({flatten:true})` 后新 tab 可 `Runtime.evaluate` | ✅ | 需同时处理 `waitingForDebugger` |
| 3 | headed 下 `createBrowserContext` 的 tab 正常可见 | ✅ | 有独立 `windowId`、`windowState:"normal"`、可截图 38KB |
| 4 | 建 tab → 导航 → `setCookie` → reload → 真实登录 | ✅ | 服务端按 cookie 放行，state 由 `out` → `in` |
| 5 | `http.execute` 改走 reqwest 后两段式等价 | ✅ | 见下文 D5 补充 |

### P0b — Firefox

| # | 假设 | 结果 | 备注 |
|---|---|---|---|
| 1 | `-no-remote` 与 `--remote-debugging-port` 共存 | ✅ | 无冲突 |
| 2 | `--remote-debugging-port 0` 的端口发现 | ✅ **但方式不同** | 无 HTTP 端点；读 profile 下 `WebDriverBiDiServer.json`（见修正 1） |
| 3 | `session.new` → `createUserContext` → `browsingContext.create` 全链路 | ✅ | 连上必须先 `session.new` |
| 4 | headed 下 user context 的 tab 可见 | ✅ | 截图 44KB |
| 5 | `storage.setCookie` 带 `partition.userContext` + `sourceOrigin` 生效 | ✅ | 刷新后服务端放行；`removeUserContext` 后不落盘 |
| 6 | `script.evaluate` 在 `sandbox` 下读写 localStorage / DOM | ✅ | sandbox 写 MAIN 可见，`fill`/`click`/`auth.write` 的底座成立 |
| 7 | 两个 user context 互不可见 | ✅ | A 有 cookie、B 为 `out` |
| 8 | 干净 profile 跑通完整登录 | ✅ | 填表 → 提交 → 302 → 受保护页 |

## 需要修正 ADR 的 6 处

### 1. Firefox 端口发现不是 `DevToolsActivePort`，而是 `WebDriverBiDiServer.json`

ADR-0020 D2 只写了 Chrome 的发现方式，P0b-2 标注「待确认」。实测 Firefox 在 profile 根目录写：

```json
{ "ws_host": "127.0.0.1", "ws_port": 55299 }
```

`--remote-debugging-port 0` 时该文件给出实际端口，**功能上等价于 Chrome 的 `DevToolsActivePort`**。
注意：`/json/version`、`/status` 等 Chrome 风格 HTTP 端点全部 404，不要按 CDP 习惯去探测。
连接 URL 是 `ws://<host>:<port>/session`。

**持久化 profile 的陷阱**：文件会残留（指向已失效端口）。复用 profile 启动前必须先删该文件，
否则会连到上一轮的僵尸端口（实测 `ECONNREFUSED`）。

### 2. `Page.lifecycleEvent` 必须先 `Page.setLifecycleEventsEnabled({enabled:true})`

D3 映射表把 `tabs.onUpdated` 直接映射到 `Page.lifecycleEvent`。实测在 Chrome 155 上**不启用则一个事件都收不到**，
表现为「页面永远 loading」。启用后 `navigated → load` 序列正常。

替代/兜底方案（生产建议两者并用）：轮询 `document.readyState`（`run.mjs` 采用，跨进程导航更稳），
或订阅 `Page.loadEventFired` / `Page.frameStoppedLoading`。

### 3. `Target.targetDestroyed` 需要先 `Target.setDiscoverTargets({discover:true})`

同上，`tabs.onRemoved` 的映射不完整。未开启时关闭 tab 不产生事件，`onRemoved` 永远不触发，
引擎的 `waitForTabLoaded` 在被关 tab 上会一直等到超时而非立即报 `TAB_CLOSED`。

### 4. browser 级连接没有 `Network.setCookie` / `Network.deleteCookies`

Chrome 155 上这两个命令**只存在于 page session**。`Storage` 域才是 browser 级入口：

| 操作 | 正确命令 |
|---|---|
| 读 | `Storage.getCookies({browserContextId})` |
| 写 | `Storage.setCookies({cookies:[...], browserContextId})` |
| 删 | **无 deleteCookies**；用「写空值 + `expires:1`」实测立即消失，或路由到 context 内某个 page session 的 `Network.deleteCookies` |

这也影响 `clear.cookies` 的实现：`host-cookies.ts` 逐个 `cookies.remove`，
shim 里每次都要走一次「过期写入」，批量清除时是 N 次 CDP 往返（性能项，非阻塞）。

### 5. 跨源 iframe 是 OOPIF，不在父 page 的 frameTree 里

D3 的 `allFrames` 方案写的是「取 frame 树 → 逐 frame 建 context」，实测**只覆盖同进程 frame**。
跨源 iframe 出现在 `Target.getTargets` 里（`type:"iframe"`），必须：

```
Target.attachToTarget({targetId, flatten:true}) → Runtime.evaluate(sessionId)
```

否则 `generic-dom.ts` 的「全 frame 搜索」会漏掉跨源 iframe 里的登录框。
好消息：`Target.getTargets` 能按 `browserContextId` 过滤，不会串到别的账号上下文。

Firefox 侧没有这个问题：`browsingContext.getTree` 直接返回全部 3 个 frame（含跨源）。

### 6. `tabs.get().url` 必须靠事件维护，且 SPA 会滞后

引擎多处依赖 `tabs.get(tabId).url`（`assertTabOnOrigin`、`refreshAfterSwitch`）。实测：

- 页面**自发**导航（302 / `location.href=` / form submit）不经过 shim 任何写路径，
  必须订阅 `Page.frameNavigated` 更新缓存，否则读到旧 URL → 误报 `INJECT_AUTH_FAILED`。
- `history.pushState` **不产生** `frameNavigated`，缓存会滞后于真实 `location.href`。
  `refreshAfterSwitch` 解析 `?redirect=` 时会漏掉 SPA 路由写入的参数（已知边界，需在 shim 里补 `Runtime.evaluate("location.href")` 兜底）。

## 额外验证到的语义

- **sameSite / httpOnly / expires**：`Storage.setCookies` 与 `chrome.cookies.set` 语义一致；
  缺省不写 `sameSite` 时 CDP 返回 `undefined`，与引擎「缺省 unspecified」的约定吻合。
- **domain 前导点**：`.example.com` → `hostOnly:false`；无点 → `hostOnly:true`，与扩展一致。
- **CSP 反转成立**：`script-src 'none'` 页面的内联脚本被拦，但 `Runtime.evaluate` 照常执行（能力增强，排障时勿误判）。
- **页面内跨源 fetch 确实被 CORS 拦**（`Failed to fetch`），证明 D5「下沉 Rust」不是可选优化而是必需。
- **引擎不设 `Origin` 头**：扩展里由浏览器补 `chrome-extension://`，Rust 侧若要改成目标 origin 是新增行为，需显式决定。
- **`domActionInPage.toString()` 一条代码路径两个协议都通**：Chrome 走 `Runtime.evaluate`，
  Firefox 走 `script.evaluate`，同一份 esbuild 产物，无需分支。

## persistent 模式（P3）补充结论

ADR 说 persistent 排 P3，spike 顺带验证了可行性，**有一条必须写进实现**：

- **关闭方式决定 cookie 是否落盘**。`SIGTERM` 在无窗口的 headless/后台实例上会被忽略
  （实测 20s 不退出、cookie 全丢）；`SIGKILL` 有时能 flush 但不可依赖。
  **必须走 BiDi `browser.close`**（实测 `exit:0`，cookie 正确落入 `cookies.sqlite`，重启后登录态保留）。
- 持久化 profile 复用前删 `WebDriverBiDiServer.json`（见修正 1）。
- session cookie（无 `expiry`）跨重启本就不保留，这是浏览器语义而非实现缺陷。

## 未验证 / 遗留

- **元素拾取器**（`target-picker.ts`）：ADR 已排 P3，未验证。
- **环境角标常驻注入**：`Page.addScriptToEvaluateOnNewDocument` 未实测（P2 项）。
- **Windows / Linux 路径与进程管理**：仅在 macOS 验证。
- **`windows.update`**：Linux/部分平台下 `browser.setClientWindowState` 支持度未验证（BiDi 规范标注部分平台不支持）。
- **并发多账号**：只验证了 2 个上下文并存，未做 10+ 账号的压力验证。

## 复跑方式

```bash
node docs/spikes/0020-p0a-chrome/run.mjs          # Chrome 主链路
node docs/spikes/0020-p0a-chrome/run-events.mjs   # 事件语义
node docs/spikes/0020-p0a-chrome/run-http.mjs     # http.execute + 回灌
node docs/spikes/0020-p0a-chrome/run-firefox.mjs  # Firefox BiDi
```

Firefox 路径写在 `bidi.mjs` 的 `FIREFOX` 常量里，默认指向 spike 时的临时解压位置；
换机器需改成实际安装路径。`run.mjs` 会启动**有头** Chrome，跑完自动清理临时 profile。
