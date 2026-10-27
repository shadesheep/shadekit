/**
 * P0b spike — Firefox WebDriver BiDi 验证（ADR-0020 验证清单 1–8）
 */
import { startServer } from "./server.mjs";
import { launchFirefox, FirefoxSession, deserialize } from "./bidi.mjs";
import { sleep } from "./cdp.mjs";
import { domActionInPage } from "./.gen-generic-target.mjs";

const results = [];
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok === true ? "PASS" : ok === false ? "FAIL" : "WARN"}] ${id} ${title}${detail ? `\n        ${detail}` : ""}`);
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

const ff = await launchFirefox({ headless: false });
let session;
try {
  // P0b-1 / P0b-2 已在 launchFirefox 内验证：-no-remote 共存 + WebDriverBiDiServer.json 端口发现
  record(
    "P0b-1/2",
    "-no-remote 与 --remote-debugging-port 0 共存，端口从 profile 的 WebDriverBiDiServer.json 发现",
    ff.info.port > 0 && !!ff.session.sessionId,
    `browser=${ff.session.capabilities.browserName}/${ff.session.capabilities.browserVersion} port=${ff.info.port}`,
  );

  // P0b-3: session.new → createUserContext → browsingContext.create 全链路
  session = new FirefoxSession(ff.bidi);
  const ucA = await session.createUserContext();
  const tabA = await session.createTab(`${base}/app`, ucA);
  const stateA = await session.evaluate(tabA, "document.getElementById('state').dataset.auth");
  record(
    "P0b-3",
    "session.new → browser.createUserContext → browsingContext.create(+navigate) 全链路",
    stateA === "out",
    `userContext=${ucA.slice(0, 8)}… tab=${tabA.slice(0, 8)}… state=${stateA}`,
  );

  // P0b-4: headed 下 user context 的 tab 可见
  let shot = null;
  try {
    shot = await session.screenshot(tabA);
  } catch (e) {
    shot = `ERR:${e.message}`;
  }
  record(
    "P0b-4",
    "headed 模式下 user context 的 tab 可截图（真实渲染）",
    typeof shot === "string" && shot.length > 2000,
    `screenshot=${typeof shot === "string" ? Math.round(shot.length / 1024) + "KB" : shot}`,
  );

  // P0b-5: storage.setCookie 带 partition.userContext + sourceOrigin 写入容器
  await session.setCookie(ucA, {
    name: "session",
    value: "ok",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  });
  const jarA = await session.getCookies(ucA, { name: "session" });
  await session.reload(tabA);
  await session.waitLoaded(tabA);
  const afterReload = await session.evaluate(tabA, "document.getElementById('state').dataset.auth");
  record(
    "P0b-5",
    "storage.setCookie(userContext + sourceOrigin) 确实写进容器，刷新后服务端放行",
    jarA.length === 1 && afterReload === "in",
    `getCookies={'${"session"}'}→${jarA.length} 条 domain=${jarA[0]?.domain} httpOnly=${jarA[0]?.httpOnly} sameSite=${jarA[0]?.sameSite} 刷新后 state=${afterReload}`,
  );

  // P0b-5b: 关闭 context 后不落盘
  const ucTmp = await session.createUserContext();
  await session.setCookie(ucTmp, {
    name: "tmp",
    value: "x",
    domain: "127.0.0.1",
    path: "/",
  });
  const tmpBefore = (await session.getCookies(ucTmp, { name: "tmp" })).length;
  await ff.bidi.send("browser.removeUserContext", { userContext: ucTmp });
  const tmpAfter = (await session.getCookies(ucTmp, { name: "tmp" }).catch(() => [])).length;
  record(
    "P0b-5b",
    "removeUserContext 后 cookie 不落盘",
    tmpBefore === 1 && tmpAfter === 0,
    `之前=${tmpBefore} 条，之后=${tmpAfter} 条`,
  );

  // P0b-6: script.evaluate 在 sandbox 下能读写 localStorage 并操作 DOM
  const sbResult = await session.evaluateInSandbox(
    tabA,
    `(() => {
       localStorage.setItem("__spike__", "sb-value");
       const el = document.getElementById("user");
       el.dataset.touched = "1";
       return { ls: localStorage.getItem("__spike__"), touched: el.dataset.touched };
     })()`,
    "shadekit",
  );
  const mainSees = await session.evaluate(tabA, "localStorage.getItem('__spike__')");
  record(
    "P0b-6",
    "script.evaluate(sandbox) 能读写 localStorage 并操作 DOM（auth.write / fill / click 依赖）",
    sbResult?.ls === "sb-value" && sbResult?.touched === "1" && mainSees === "sb-value",
    `sandbox 内 ls=${JSON.stringify(sbResult?.ls)} touched=${sbResult?.touched}；MAIN world 读到=${JSON.stringify(mainSees)}`,
  );

  // P0b-6b: domActionInPage 原样下发（与 Chrome 同一份源码）
  const dom = await session.evaluate(tabA, `(${domActionInPage.toString()})(${JSON.stringify({ action: "locate", target: { css: "#state" } })})`);
  record(
    "P0b-6b",
    "domActionInPage.toString() 在 Firefox script.evaluate 下同样生效",
    dom?.status === "ok" && dom?.count === 1,
    `status=${dom?.status} count=${dom?.count}`,
  );

  // P0b-7: 两个 user context 互不可见
  const ucB = await session.createUserContext();
  const tabB = await session.createTab(`${base}/app`, ucB);
  const bState = await session.evaluate(tabB, "document.getElementById('state').dataset.auth");
  const bCookie = (await session.getCookies(ucB, { name: "session" })).length;
  const aCookie = (await session.getCookies(ucA, { name: "session" })).length;
  record(
    "P0b-7",
    "两个 user context 互不可见：A 登录后 B 打开同站点为登出态",
    bState === "out" && bCookie === 0 && aCookie === 1,
    `A cookie=${aCookie} B cookie=${bCookie} B state=${bState}`,
  );

  // P0b-8: 干净 profile 跑完整登录流程（表单填写 → 点击 → 服务端 302 → 受保护页）
  const ucC = await session.createUserContext();
  const tabC = await session.createTab(`${base}/`, ucC);
  await session.evaluate(
    tabC,
    `(() => {
       document.getElementById("username").value = "alice";
       document.getElementById("password").value = "pw";
       document.getElementById("submit").click();
       return true;
     })()`,
  );
  await sleep(1500);
  const finalState = await session.evaluate(
    tabC,
    "document.getElementById('state')?.dataset.auth ?? 'missing'",
  );
  const finalUrl = await session.evaluate(tabC, "location.href");
  record(
    "P0b-8",
    "干净 profile + 真实登录环境：填表 → 提交 → 302 → 受保护页（完整 runSpec 的核心路径）",
    finalState === "in",
    `url=${finalUrl} state=${finalState}`,
  );

  // 补充：跨源 iframe（Firefox 是多进程，但 BiDi 的 context 树是否包含 OOPIF？）
  const tabF = await session.createTab(`${base}/iframe-host`, ucA);
  await sleep(1200);
  const tree = await ff.bidi.send("browsingContext.getTree", { root: tabF });
  const count = (function walk(n) {
    return 1 + (n.children ?? []).reduce((a, c) => a + walk(c), 0);
  })(tree.contexts[0]);
  record(
    "P0b-extra",
    "browsingContext.getTree 覆盖跨源 iframe（Firefox 侧是否与 Chrome 的 OOPIF 缺口一致）",
    count >= 3,
    `context 树节点数=${count}（期望 3：主 frame + 同源 iframe + 跨源 iframe）`,
  );
} finally {
  await ff.cleanup();
  server.close();
}

console.log("\n===== summary =====");
for (const r of results) console.log(`${r.ok === true ? "PASS" : r.ok === false ? "FAIL" : "WARN"}  ${r.id}  ${r.title}`);
const failed = results.filter((r) => r.ok === false);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
