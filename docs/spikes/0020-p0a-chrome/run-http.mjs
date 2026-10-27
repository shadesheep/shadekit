/**
 * D5 spike：用**真实引擎**的 runHttpExecute 跑两段式流程。
 *
 * 两种底座对照：
 *  A) 直接跑（Node 的 fetch，等价于扩展在 background 里跑）
 *  B) 替换 fetch 为「经 invoke 转发到 Rust reqwest」的 shim，并把 Set-Cookie 回灌浏览器
 *
 * 验证点：引擎源码零改动 + 请求形状（URL/method/headers/body）不变 + Set-Cookie 回灌后
 * 后续 cookie 条件成立。
 */
import { startServer } from "./server.mjs";
import { launchChrome, BrowserSession } from "./cdp.mjs";
import { runHttpExecute } from "./.gen-http.mjs";

const results = [];
function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`[${ok === true ? "PASS" : ok === false ? "FAIL" : "WARN"}] ${id} ${title}${detail ? `\n        ${detail}` : ""}`);
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

const executeOp = {
  op: "http.execute",
  as: "loginResult",
  method: "POST",
  url: `${base}/api/login`,
  headers: { "content-type": "application/json" },
  body: { json: { username: "{username}", password: "{password}" } },
  parse: "json",
};
const ctx = { inputs: { username: "alice", password: "secret" }, bindings: {} };

// ---------- A) 直跑（扩展语义 / Node fetch） ----------
const nativeFetch = globalThis.fetch;
let captured = null;
globalThis.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  captured = { url: String(input), init };
  return res;
};
const a = await runHttpExecute(ctx, executeOp, [], 10000);
globalThis.fetch = nativeFetch;
record(
  "D5-A",
  "runHttpExecute 直跑（Node fetch）：请求形状与响应解析符合引擎预期",
  a.status === 200 && a.body.token === "tok-123" && captured.init.method === "POST",
  `status=${a.status} token=${a.body.token} url=${captured.url} headers=${JSON.stringify(captured.init.headers)} body=${captured.init.body}`,
);

// ---------- B) 走 invoke shim（模拟 Rust reqwest 边界） ----------
//
// Rust 侧会做三件事：发请求、拿响应、把 Set-Cookie 逐条解析。
// WebView 侧只看到「已归一化的 Response」。
const cookieJar = [];
const rustExecute = async (params) => {
  const res = await nativeFetch(params.url, params.init);
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  return {
    status: res.status,
    headers: [...res.headers.entries()],
    text,
    setCookies,
  };
};

let lastRustResult = null;
globalThis.fetch = async (input, init) => {
  const r = await rustExecute({ url: String(input), init });
  lastRustResult = r;
  // 用真实的 Response 构造器还原，引擎拿到的仍是标准 Response（http.ts 未改动）
  return new Response(r.text, {
    status: r.status,
    headers: r.headers,
  });
};
const b = await runHttpExecute(ctx, executeOp, [], 10000);
globalThis.fetch = nativeFetch;

const reqBody = JSON.parse(lastRustResult.text);
const shapeOk = b.status === 200 && b.body.token === "tok-123" && lastRustResult.setCookies.length === 2;
record(
  "D5-B",
  "runHttpExecute 经 invoke shim：引擎零改动，仍返回标准 Response，Set-Cookie 可被截获",
  shapeOk,
  `status=${b.status} set-cookie=${lastRustResult.setCookies.length} 服务端收到的 Origin=${JSON.stringify(reqBody.receivedOrigin)}`,
);
// 扩展语义对照：引擎从不设置 Origin（浏览器自动带 chrome-extension://）。
// Rust 侧若要显式设 Origin 是 D5 说的「顺带修老问题」，不是引擎行为。
record(
  "D5-B2",
  "引擎本身不设置 Origin 头（扩展里由浏览器补，Rust 侧需 shim 决定是否补目标 origin）",
  reqBody.receivedOrigin === null,
  `receivedOrigin=${JSON.stringify(reqBody.receivedOrigin)}`,
);

// ---------- C) Set-Cookie 回灌 → cookie 条件成立 ----------
const browser = await launchChrome({ headless: true });
try {
  const session = new BrowserSession(browser.cdp);
  await session.init();
  await session.createContext();
  const tab = await session.createTab(`${base}/app`);

  for (const line of lastRustResult.setCookies) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const opt = Object.fromEntries(
      attrs.map((a) => {
        const i = a.indexOf("=");
        return i === -1 ? [a.toLowerCase(), true] : [a.slice(0, i).toLowerCase(), a.slice(i + 1)];
      }),
    );
    await session.setCookie({
      url: `${base}/`,
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      httpOnly: opt.httponly === true,
      sameSite: opt.samesite,
      expirationDate: opt["max-age"]
        ? Math.floor(Date.now() / 1000) + Number(opt["max-age"])
        : undefined,
    });
  }

  // 模拟 generic-settle.ts 的 cookie 条件：chrome.cookies.getAll({name})
  const jar = await session.getAllCookies({ name: "session" });
  const afterReload = await (async () => {
    await session.reloadAndWait(tab.id);
    return session.evaluate(tab.id, "document.getElementById('state').dataset.auth");
  })();
  record(
    "D5-C",
    "Set-Cookie 回灌后 chrome.cookies.getAll({name}) 条件成立，页面刷新即登录",
    jar.length === 1 && afterReload === "in",
    `getAll({name:'session'})=${jar.length} 条，刷新后 state=${afterReload}`,
  );
} finally {
  await browser.cleanup();
  server.close();
}

console.log("\n===== summary =====");
for (const r of results) console.log(`${r.ok === true ? "PASS" : r.ok === false ? "FAIL" : "WARN"}  ${r.id}  ${r.title}`);
const failed = results.filter((r) => r.ok === false);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
