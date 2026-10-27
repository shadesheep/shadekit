/**
 * P0a spike 补充：事件语义（tabs.onUpdated / onRemoved）与 URL 缓存维护。
 *
 * 为什么单列：引擎的 waitForTabLoaded 依赖 onUpdated 的 status:'complete'，
 * login-tab-flow 与 session.ts 的 assertTabOnOrigin 依赖 tabs.get().url 的实时性。
 * 页面自发导航（302 / JS redirect / form submit）不经过 shim 的任何写路径，
 * 必须靠 CDP 事件维护缓存，否则「登录成功后误报 TAB_CLOSED / 页面不在目标站点」。
 */
import { startServer } from "./server.mjs";
import { launchChrome, BrowserSession, until, sleep } from "./cdp.mjs";
import { domActionInPage } from "./.gen-generic-target.mjs";

const results = [];
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(
    `[${ok === true ? "PASS" : ok === false ? "FAIL" : "WARN"}] ${id} ${title}${detail ? `\n        ${detail}` : ""}`,
  );
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const browser = await launchChrome({ headless: false });

try {
  const session = new BrowserSession(browser.cdp);
  await session.init();
  await session.createContext();

  // 订阅主 frame 导航事件，维护 tab.url（生产 shim 应做的）
  const tab = await session.createTab(`${base}/`);
  const cdp = browser.cdp;
  const events = [];
  const urlLog = [];
  const sid = session.tabs.get(tab.id).sessionId;

  // ADR-0020 D3 写的是 Page.lifecycleEvent，但实测必须先显式启用，
  // 否则一个事件都收不到（会误判「页面永远 loading」）。
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sid);
  // 同理：Target.targetDestroyed 需要 setDiscoverTargets（见 EV-4）
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  cdp.on(
    "Page.frameNavigated",
    (params) => {
      if (params.frame.parentId) return; // 只关心主 frame
      events.push({ kind: "navigated", url: params.frame.url, loaderId: params.frame.loaderId });
      const t = session.tabs.get(tab.id);
      if (t) {
        t.url = params.frame.url;
        t.status = "loading";
      }
      urlLog.push(params.frame.url);
    },
    sid,
  );
  cdp.on(
    "Page.lifecycleEvent",
    (params) => {
      if (params.name !== "load") return;
      events.push({ kind: "load", loaderId: params.loaderId });
      const t = session.tabs.get(tab.id);
      if (t) t.status = "complete";
    },
    sid,
  );

  // ---- 1) 表单提交（真实 302）后 tab.url 是否跟上 ----
  await session.executeScript(tab.id, domActionInPage.toString(), [
    { action: "fill", target: { css: "#username" }, value: "alice", clearFirst: true },
  ]);
  await session.executeScript(tab.id, domActionInPage.toString(), [
    { action: "fill", target: { css: "#password" }, value: "pw", clearFirst: true },
  ]);
  await session.executeScript(tab.id, domActionInPage.toString(), [
    { action: "click", target: { css: "#submit" } },
  ]);

  const finalUrl = await until(
    async () => (await session.evaluate(tab.id, "location.href").catch(() => "")) || null,
    { timeout: 15000, label: "post-submit url" },
  );
  await until(() => events.some((e) => e.kind === "navigated" && e.url.endsWith("/app")), {
    timeout: 15000,
    label: "frameNavigated to /app",
  });

  const cachedUrl = session.getTab(tab.id).url;
  record(
    "EV-1",
    "302 自发导航：Page.frameNavigated 能维护 tab.url（若不维护会读到旧 URL）",
    cachedUrl.endsWith("/app") && finalUrl.endsWith("/app"),
    `缓存 url=${cachedUrl} 实际 url=${finalUrl}`,
  );

  // ---- 2) onUpdated 语义：status 从 loading → complete ----
  const statusSeq = events.map((e) => e.kind);
  record(
    "EV-2",
    "Page.lifecycleEvent 的 load 可映射为 onUpdated status:'complete'（需先 setLifecycleEventsEnabled）",
    statusSeq.includes("navigated") && statusSeq.includes("load"),
    `事件序列=${statusSeq.join(" → ")}，当前 status=${session.getTab(tab.id).status}`,
  );

  // ---- 3) 同一 URL 再导航 / SPA pushState ----
  await session.evaluate(tab.id, "history.pushState({}, '', '/app?spa=1')");
  await sleep(300);
  const afterPush = session.getTab(tab.id).url;
  record(
    "EV-3",
    "SPA pushState 不产生 frameNavigated（tab.url 会滞后）",
    !afterPush.includes("spa=1"),
    `pushState 后缓存 url=${afterPush}；实际=${await session.evaluate(tab.id, "location.href")}`,
  );

  // ---- 4) Target.targetDestroyed → onRemoved ----
  const removed = [];
  const observer = new BrowserSession(browser.cdp);
  await observer.init();
  const ctx2 = await observer.createContext();
  const doomed = await observer.createTab(`${base}/app`);
  // 观察另一个 session 的 target 销毁
  browser.cdp.on("Target.targetDestroyed", ({ targetId }) => removed.push(targetId));
  const doomedTargetId = observer.tabs.get(doomed.id).targetId;
  await observer.closeTab(doomed.id);
  await until(() => removed.includes(doomedTargetId), {
    timeout: 5000,
    label: "targetDestroyed",
  }).catch(() => {});
  record(
    "EV-4",
    "关闭 tab 产生 Target.targetDestroyed（可映射 onRemoved）",
    removed.includes(doomedTargetId),
    `targetId=${doomedTargetId.slice(0, 8)}… removed=${removed.length}`,
  );

  // ---- 5) headed 下 context tab 的窗口归属（同窗口 vs 新窗口） ----
  const tabInfo = (await cdp.send("Target.getTargets")).targetInfos.find(
    (t) => t.targetId === session.tabs.get(tab.id).targetId,
  );
  const win = await cdp.send("Browser.getWindowForTarget", { targetId: tabInfo.targetId });
  const shot = await cdp
    .send("Page.captureScreenshot", { format: "png" }, session.tabs.get(tab.id).sessionId)
    .catch(() => null);
  record(
    "EV-5",
    "headed 下 context tab 有真实窗口且能截图（证明实际渲染而非 headless 假象）",
    !!win.windowId && (shot?.data?.length ?? 0) > 1000,
    `windowId=${win.windowId} state=${win.bounds.windowState} size=${win.bounds.width}x${win.bounds.height} screenshot=${shot ? Math.round(shot.data.length / 1024) + "KB" : "none"}`,
  );

  // 对照：headless 模式下 bounds 的差异（帮助判断「可见」）
  const headlessBrowser = await launchChrome({ headless: true });
  try {
    const hs = new BrowserSession(headlessBrowser.cdp);
    await hs.init();
    await hs.createContext();
    const htab = await hs.createTab(`${base}/app`);
    const hinfo = (await headlessBrowser.cdp.send("Target.getTargets")).targetInfos.find(
      (t) => t.targetId === hs.tabs.get(htab.id).targetId,
    );
    const hwin = await headlessBrowser.cdp.send("Browser.getWindowForTarget", {
      targetId: hinfo.targetId,
    });
    console.log(
      `        ↳ 对照 headless: windowId=${hwin.windowId} bounds=${JSON.stringify(hwin.bounds)}`,
    );
  } finally {
    await headlessBrowser.cleanup();
  }
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
