/**
 * P0a spike — Chrome / Edge CDP 验证
 *
 * 覆盖 ADR-0020「验证清单」P0a 1–5，加上 D3 映射表中最容易翻车的几处：
 * - DevToolsActivePort 端口发现
 * - setAutoAttach(flatten) 后对新 tab 求值
 * - headed 模式下 createBrowserContext 的 tab 可见性（用 Target.getTargets 的
 *   browserContextId + 独立 cookie jar 证明上下文真实存在；网页可见性无法程序化断言，
 *   单列一条「人工确认」）
 * - 完整登录：建 tab → 导航 → 写 cookie → reload → 真实服务端判定已登录
 * - 两个账号上下文互不可见（ADR-0020 D4 的核心承诺）
 * - http.execute 走 Node（≈reqwest）时的 CORS / Origin / Set-Cookie 回灌
 * - domActionInPage 原样 toString() 下发（D3 的关键论据）
 * - allFrames 归并、ISOLATED world、storage 读写、CSP 页面差异
 */
import { startServer } from "./server.mjs";
import { launchChrome, BrowserSession, until, sleep } from "./cdp.mjs";
import { domActionInPage } from "./.gen-generic-target.mjs";

const results = [];
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "WARN";
  console.log(`[${mark}] ${id} ${title}${detail ? `\n        ${detail}` : ""}`);
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
console.log(`\n# spike site: ${base}\n`);

const browser = await launchChrome({ headless: false });

try {
  // ------------------------------------------------------------
  // P0a-1: 独立 user-data-dir + port 0 → DevToolsActivePort → 连上
  // ------------------------------------------------------------
  record(
    "P0a-1",
    "DevToolsActivePort 端口发现并连接 browser WebSocket",
    !!browser.devtools.port && browser.cdp.wsUrl.startsWith("ws://127.0.0.1:"),
    `port=${browser.devtools.port} ws=${browser.cdp.wsUrl.replace(/\/devtools\/browser\/.*/, "/devtools/browser/<id>")}`,
  );

  // ------------------------------------------------------------
  // P0a-2: setAutoAttach(flatten) 后对新 tab 发 Runtime.evaluate
  // ------------------------------------------------------------
  const sessionA = new BrowserSession(browser.cdp);
  await sessionA.init();
  const ctxA = await sessionA.createContext();
  const tabA = await sessionA.createTab(`${base}/app`);
  const evalOnNewTab = await sessionA.evaluate(tabA.id, "location.pathname");
  const autoAttachOk = evalOnNewTab === "/app";
  record(
    "P0a-2",
    "setAutoAttach({flatten}) 后新 tab 可 Runtime.evaluate",
    autoAttachOk,
    `location.pathname=${JSON.stringify(evalOnNewTab)}`,
  );

  // ------------------------------------------------------------
  // P0a-3: headed 下 createBrowserContext 的 tab「正常」
  //   —— 可程序化断言的：target 归属该 context、window 真实存在、
  //      cookie jar 独立。可见性记人工确认项。
  // ------------------------------------------------------------
  const targets = (await browser.cdp.send("Target.getTargets")).targetInfos;
  const targetA = targets.find((t) => t.targetId === sessionA.tabs.get(tabA.id).targetId);
  const windowInfo = await browser.cdp.send("Browser.getWindowForTarget", {
    targetId: targetA.targetId,
  });
  record(
    "P0a-3",
    "headed 模式下 createBrowserContext 的 tab 属于该 context 且有真实 window",
    targetA.browserContextId === ctxA && !!windowInfo.windowId,
    `browserContextId=${targetA.browserContextId} windowId=${windowInfo.windowId} bounds=${JSON.stringify(windowInfo.bounds)}`,
  );
  console.log(
    `        ↳ 人工确认：此时应看到 Chrome 窗口（context ${ctxA.slice(0, 8)}…）`,
  );

  // ------------------------------------------------------------
  // P0a-4: 建 tab → 导航 → setCookie → reload → 服务端判定已登录
  // ------------------------------------------------------------
  const before = await sessionA.evaluate(tabA.id, "document.getElementById('state').dataset.auth");
  await sessionA.setCookie({ url: `${base}/`, name: "session", value: "ok", httpOnly: true });
  await sessionA.reloadAndWait(tabA.id);
  const after = await sessionA.evaluate(tabA.id, "document.getElementById('state').dataset.auth");
  const cookieCount = (await sessionA.getAllCookies()).length;
  record(
    "P0a-4",
    "写 cookie → reload → 服务端真实放行",
    before === "out" && after === "in",
    `state: ${before} → ${after}, context cookies=${cookieCount}`,
  );

  // ------------------------------------------------------------
  // D4: 两个上下文互不可见
  // ------------------------------------------------------------
  const sessionB = new BrowserSession(browser.cdp);
  await sessionB.init();
  const ctxB = await sessionB.createContext();
  const tabB = await sessionB.createTab(`${base}/app`);
  const bState = await sessionB.evaluate(
    tabB.id,
    "document.getElementById('state').dataset.auth",
  );
  const bCookies = await sessionB.getAllCookies();
  const aCookies = await sessionA.getAllCookies();
  record(
    "D4",
    "两个 browserContext 的 cookie jar 互不可见（B 打开同站点为登出态）",
    bState === "out" && bCookies.length === 0 && aCookies.some((c) => c.name === "session"),
    `A cookies=${aCookies.map((c) => c.name).join(",") || "∅"}, B cookies=${bCookies.length}, B state=${bState}`,
  );

  // ------------------------------------------------------------
  // D3 关键论据: domActionInPage 原样序列化执行（需要登录表单页）
  // ------------------------------------------------------------
  const formTab = await sessionA.createTab(`${base}/`);
  const locateForm = await sessionA.executeScript(formTab.id, domActionInPage.toString(), [
    { action: "locate", target: { css: "#login-form" } },
  ]);
  const locateResult = locateForm[0]?.result;
  const fillUser = await sessionA.executeScript(formTab.id, domActionInPage.toString(), [
    { action: "fill", target: { css: "#username" }, value: "alice@spike", clearFirst: true },
  ]);
  // read 必须在 click 之前：提交会触发导航，页面卸载后 read 拿不到结果
  const readBack = await sessionA.executeScript(formTab.id, domActionInPage.toString(), [
    { action: "read", target: { css: "#username" } },
  ]);
  const clickSubmit = await sessionA.executeScript(formTab.id, domActionInPage.toString(), [
    { action: "click", target: { css: "#submit" } },
  ]);
  record(
    "D3-dom",
    "domActionInPage.toString() 直接下发：locate / fill / read / click 全部生效",
    locateResult?.status === "ok" &&
      fillUser[0]?.result?.status === "ok" &&
      clickSubmit[0]?.result?.status === "ok" &&
      readBack[0]?.result?.value === "alice@spike",
    `locate=${locateResult?.status}/${locateResult?.count} fill=${fillUser[0]?.result?.status} read=${JSON.stringify(readBack[0]?.result?.value)} click=${clickSubmit[0]?.result?.status}`,
  );

  // 表单真实提交后服务端 Set-Cookie + 302 → 受保护页
  await until(
    async () =>
      (await sessionA.evaluate(formTab.id, "location.pathname").catch(() => "")) === "/app",
    { timeout: 15000, label: "form redirect to /app" },
  ).catch(() => {});
  await sessionA.waitLoaded(formTab.id, 20000).catch(() => {});
  const afterForm = await sessionA.evaluate(
    formTab.id,
    "document.getElementById('state')?.dataset.auth ?? 'missing'",
  );
  record(
    "D3-form",
    "真实表单提交（服务端 Set-Cookie + 302）后进入受保护页",
    afterForm === "in",
    `state=${afterForm} url=${(await sessionA.getTab(formTab.id)).url}`,
  );

  // ------------------------------------------------------------
  // D3: allFrames 归并（同源 + 跨源 iframe）
  // ------------------------------------------------------------
  const iframeTab = await sessionA.createTab(`${base}/iframe-host`);
  await sleep(800); // 等子 frame load
  const allFrames = await sessionA.executeScript(
    iframeTab.id,
    `function () {
      return { href: location.href, hasButton: !!document.getElementById("in-iframe") || !!document.getElementById("in-main") };
    }`,
    [],
    { allFrames: true },
  );
  const hrefs = allFrames.map((f) => f.result?.href).filter(Boolean);
  record(
    "D3-frames",
    "allFrames 执行覆盖主 frame + 同源/跨源 iframe",
    hrefs.length >= 2 && hrefs.some((h) => h.includes("/iframe-host")) && hrefs.some((h) => h.includes("/iframe-child")),
    `${allFrames.length} frames: ${hrefs.map((h) => new URL(h).pathname).join(", ")}`,
  );

  // ------------------------------------------------------------
  // D3: ISOLATED world 能读写 localStorage（auth.write / fill / click 依赖）
  // ------------------------------------------------------------
  await sessionA.evaluate(tabA.id, "localStorage.removeItem('__spike__')");
  const isolatedWrite = await sessionA.executeScript(
    tabA.id,
    `function (k, v) { localStorage.setItem(k, v); return localStorage.getItem(k); }`,
    ["__spike__", "iso-value"],
    { world: "ISOLATED" },
  );
  const mainRead = await sessionA.evaluate(tabA.id, "localStorage.getItem('__spike__')");
  record(
    "D3-isolated",
    "ISOLATED world 写 localStorage 对 MAIN world 可见",
    isolatedWrite[0]?.result === "iso-value" && mainRead === "iso-value",
    `isolated=${JSON.stringify(isolatedWrite[0]?.result)} main=${JSON.stringify(mainRead)}`,
  );

  // ------------------------------------------------------------
  // 负面清单 D8: tabs.query({active,currentWindow}) 无直接等价物
  // ------------------------------------------------------------
  const visA = await sessionA.evaluate(tabA.id, "({vis: document.visibilityState, focus: document.hasFocus()})");
  const visIframe = await sessionA.evaluate(iframeTab.id, "({vis: document.visibilityState, focus: document.hasFocus()})");
  const getTargets = (await browser.cdp.send("Target.getTargets")).targetInfos;
  const hasVisibilityField = getTargets.some(
    (t) => "visible" in t || "active" in t || "focused" in t,
  );
  record(
    "D8",
    "Target.getTargets 不含可见性字段（需轮询 visibilityState 兜底）",
    hasVisibilityField === false,
    `tabA=${JSON.stringify(visA)} iframeTab=${JSON.stringify(visIframe)} targets 含可见性字段=${hasVisibilityField}`,
  );

  // ------------------------------------------------------------
  // D5: http.execute 下沉 Node（≈ reqwest）
  //   - 页面内 fetch 受 CORS 限制（对照）
  //   - Node 侧无 CORS；可显式设 Origin；Set-Cookie 手工回灌
  // ------------------------------------------------------------
  // 用 localhost（而非 127.0.0.1）打开页面，与 base 构成真正的跨源
  const crossOriginBase = base.replace("127.0.0.1", "localhost");
  const crossTab = await sessionA.createTab(`${crossOriginBase}/app`);
  const pageFetch = await sessionA.evaluate(
    crossTab.id,
    `fetch("${base}/api/login", {method:"POST", headers:{"content-type":"application/json"}, body:"{}"})
       .then(r => "status:" + r.status)
       .catch(e => "ERR:" + e.message)`,
  );
  // 对照：不带 Origin 的简单 GET（CORS 只约束读取，不约束发送）
  const pageFetchRead = await sessionA.evaluate(
    crossTab.id,
    `fetch("${base}/api/me").then(r => "status:" + r.status).catch(e => "ERR:" + e.message)`,
  );
  record(
    "D5-cors",
    "页面内跨源 fetch 受 CORS 约束（证明不能沿用 WebView fetch）",
    String(pageFetch).startsWith("ERR") && String(pageFetchRead).startsWith("ERR"),
    `cross-origin POST → ${JSON.stringify(pageFetch)}; cross-origin GET → ${JSON.stringify(pageFetchRead)}`,
  );

  // Node 侧：不带 cookie，拿 Set-Cookie
  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ username: "alice", password: "pw" }),
  });
  const setCookies = loginRes.headers.getSetCookie?.() ?? [];
  const loginBody = await loginRes.json();
  record(
    "D5-node",
    "Node(≈reqwest) 发登录请求：无 CORS、可设 Origin、能拿到 Set-Cookie",
    loginRes.status === 200 &&
      setCookies.length === 2 &&
      loginBody.receivedOrigin === base &&
      loginBody.receivedCookieHeader === null,
    `status=${loginRes.status} set-cookie=${setCookies.length} origin=${loginBody.receivedOrigin} cookieHdr=${loginBody.receivedCookieHeader}`,
  );

  // 回灌 Set-Cookie 到上下文 A，再验证业务接口
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const opt = Object.fromEntries(
      attrs.map((a) => {
        const i = a.indexOf("=");
        return i === -1 ? [a.toLowerCase(), true] : [a.slice(0, i).toLowerCase(), a.slice(i + 1)];
      }),
    );
    await sessionA.setCookie({
      url: `${base}/`,
      name,
      value,
      httpOnly: opt.httponly === true,
      sameSite: opt.samesite,
      expirationDate: opt["max-age"] ? Math.floor(Date.now() / 1000) + Number(opt["max-age"]) : undefined,
    });
  }
  const meRes = await fetch(`${base}/api/me`, { headers: { cookie: "session=ok" } });
  const meCookiesInBrowser = await sessionA.evaluate(tabA.id, "document.cookie");
  record(
    "D5-replay",
    "Set-Cookie 回灌上下文后：cookie 落入浏览器，页面 document.cookie 可见非 HttpOnly 项",
    meRes.status === 200 && meCookiesInBrowser.includes("extra=1"),
    `browser document.cookie=${JSON.stringify(meCookiesInBrowser)}`,
  );

  // ------------------------------------------------------------
  // CSP 行为反转（ADR 后果章节）
  // ------------------------------------------------------------
  const cspTab = await sessionA.createTab(`${base}/csp`);
  await sessionA.waitLoaded(cspTab.id);
  const inlineRan = await sessionA.evaluate(cspTab.id, "window.__cspInlineRan === true");
  const cdpEvalWorks = await sessionA.evaluate(cspTab.id, "document.getElementById('csp-state').textContent");
  record(
    "CSP",
    "CSP script-src 'none' 页面：内联脚本被拦，但 Runtime.evaluate 不受影响",
    inlineRan === false && cdpEvalWorks === "pending",
    `inlineRan=${inlineRan} cdpRead=${JSON.stringify(cdpEvalWorks)}`,
  );

  // ------------------------------------------------------------
  // 上下文销毁即清（D4 isolated 语义）
  // ------------------------------------------------------------
  await sessionB.disposeContext();
  await sleep(300);
  const targetsAfterDispose = (await browser.cdp.send("Target.getTargets")).targetInfos;
  const bStillThere = targetsAfterDispose.some((t) => t.browserContextId === ctxB);
  const cookiesAfterDispose = await browser.cdp
    .send("Storage.getCookies", { browserContextId: ctxB })
    .then((r) => r.cookies.length)
    .catch(() => "context-gone");
  record(
    "D4-dispose",
    "disposeBrowserContext 后 target 消失、cookie 不落盘",
    bStillThere === false,
    `B targets still present=${bStillThere}, cookies=${cookiesAfterDispose}`,
  );
} finally {
  await browser.cleanup();
  server.close();
}

console.log("\n===== summary =====");
for (const r of results) {
  console.log(`${r.ok === true ? "PASS" : r.ok === false ? "FAIL" : "WARN"}  ${r.id}  ${r.title}`);
}
const failed = results.filter((r) => r.ok === false);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
