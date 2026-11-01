/**
 * Default-profile + CDP pipe spike。
 *
 * 验证 Playwright 同类连接方式：真实默认 profile 经 fd3/fd4 的 CDP pipe，
 * 不使用 --remote-debugging-port，不读取 DevToolsActivePort。
 *
 * 运行前完全退出待测 Chrome/Edge，避免启动参数被已有实例忽略。
 * 只操作本地随机端口测试页；不删除 profile，不主动 kill 浏览器。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { startServer } from "./server.mjs";

const bin =
  process.env.SHADEKIT_BROWSER_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userDataDir =
  process.env.SHADEKIT_BROWSER_USER_DATA_DIR ??
  path.join(homedir(), "Library/Application Support/Google/Chrome");
const profileDirectory = process.env.SHADEKIT_BROWSER_PROFILE ?? "Default";

class PipeCdp {
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #buffer = "";

  constructor(proc) {
    this.input = proc.stdio[3];
    this.output = proc.stdio[4];
    if (!this.input || !this.output) throw new Error("CDP pipe fd3/fd4 不可用");
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk) => this.#onData(chunk));
    this.output.on("error", (error) => this.#rejectAll(error));
    this.input.on("error", (error) => this.#rejectAll(error));
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\0");
      if (end < 0) return;
      const text = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      if (text) this.#onMessage(JSON.parse(text));
    }
  }

  #onMessage(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const key = message.sessionId ? `${message.sessionId}:${message.method}` : message.method;
    for (const listener of this.#listeners.get(key) ?? []) {
      listener(message.params, message.sessionId);
    }
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP pipe 命令超时: ${method}`));
      }, 10000);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
        method,
      });
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }

  on(method, listener, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(listener);
    return () => this.#listeners.get(key)?.delete(listener);
  }

  close() {
    this.input.end();
    this.output.destroy();
  }
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
let cdp;
let normalTargetId;
let incognitoContextId;

try {
  console.log(`Launching with CDP pipe: ${bin}`);
  console.log(`Default user-data-dir: ${userDataDir}; profile: ${profileDirectory}`);
  const proc = spawn(
    bin,
    [
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDirectory}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  proc.on("error", (error) => console.error(`Browser spawn error: ${error.message}`));
  cdp = new PipeCdp(proc);

  const version = await cdp.send("Browser.getVersion");
  console.log(`PASS: default-profile CDP pipe connected: ${version.product}`);

  const attach = async (targetId) => {
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    return sessionId;
  };
  const evaluate = async (sessionId, expression) => {
    const response = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  };
  const waitLoaded = async (sessionId) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await evaluate(sessionId, "document.readyState").catch(() => "")) === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("测试页面加载超时");
  };
  const setSessionCookie = async (browserContextId) => {
    await cdp.send("Storage.setCookies", {
      cookies: [{ name: "session", value: "ok", url: `${base}/`, path: "/", httpOnly: true }],
      ...(browserContextId ? { browserContextId } : {}),
    });
  };
  const authState = async (sessionId) =>
    evaluate(sessionId, "document.getElementById('state')?.dataset.auth ?? 'missing'");

  ({ targetId: normalTargetId } = await cdp.send("Target.createTarget", {
    url: `${base}/app`,
  }));
  const normalSession = await attach(normalTargetId);
  await waitLoaded(normalSession);
  const normalBefore = await authState(normalSession);
  await setSessionCookie();
  await cdp.send("Page.reload", { ignoreCache: false }, normalSession);
  await waitLoaded(normalSession);
  const normalAfter = await authState(normalSession);
  console.log(
    `${normalBefore === "out" && normalAfter === "in" ? "PASS" : "FAIL"}: ` +
      `default profile normal tab cookie/login (${normalBefore} → ${normalAfter})`,
  );

  ({ browserContextId: incognitoContextId } = await cdp.send(
    "Target.createBrowserContext",
    { disposeOnDetach: false },
  ));
  const { targetId: incognitoTargetId } = await cdp.send("Target.createTarget", {
    url: `${base}/app`,
    browserContextId: incognitoContextId,
  });
  const incognitoSession = await attach(incognitoTargetId);
  await waitLoaded(incognitoSession);
  const incognitoBefore = await authState(incognitoSession);
  await setSessionCookie(incognitoContextId);
  await cdp.send("Page.reload", { ignoreCache: false }, incognitoSession);
  await waitLoaded(incognitoSession);
  const incognitoAfter = await authState(incognitoSession);
  console.log(
    `${incognitoBefore === "out" && incognitoAfter === "in" ? "PASS" : "FAIL"}: ` +
      `default browser incognito context isolation/login (${incognitoBefore} → ${incognitoAfter})`,
  );
} finally {
  if (cdp) {
    await cdp.send("Storage.setCookies", {
      cookies: [{ name: "session", value: "", url: `${base}/`, path: "/", expires: 1 }],
    }).catch(() => {});
    if (normalTargetId) {
      await cdp.send("Target.closeTarget", { targetId: normalTargetId }).catch(() => {});
    }
    if (incognitoContextId) {
      await cdp.send("Target.disposeBrowserContext", {
        browserContextId: incognitoContextId,
      }).catch(() => {});
    }
    cdp.close();
  }
  server.close();
}
