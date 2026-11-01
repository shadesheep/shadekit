/**
 * Default-profile spike — 不删除、不关闭、不清理用户浏览器或 profile。
 *
 * 运行前建议完全退出待测 Chrome/Edge，再用以下命令启动验证：
 *   node docs/spikes/0020-p0a-chrome/run-default-profile.mjs
 *
 * 只操作本地随机端口测试页。脚本结束后只清理自己创建的 tab/context
 * 和随机端口测试 Cookie，不 kill 浏览器进程，不删除任何 profile 数据。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Cdp, until } from "./cdp.mjs";
import { startServer } from "./server.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_USER_DATA_DIR = path.join(
  homedir(),
  "Library/Application Support/Google/Chrome",
);
const bin = process.env.SHADEKIT_BROWSER_BIN ?? CHROME;
const userDataDir =
  process.env.SHADEKIT_BROWSER_USER_DATA_DIR ?? DEFAULT_USER_DATA_DIR;
const profileDirectory = process.env.SHADEKIT_BROWSER_PROFILE ?? "Default";

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
let cdp;
let normalTargetId;
let incognitoContextId;
let incognitoTargetId;

try {
  console.log(`Launching: ${bin}`);
  console.log(`Default user-data-dir: ${userDataDir}; profile: ${profileDirectory}`);
  const proc = spawn(
    bin,
    [
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDirectory}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  proc.on("error", (error) => console.error(`Browser spawn error: ${error.message}`));
  proc.unref();

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const devtools = await until(
    async () => {
      if (!existsSync(portFile)) return null;
      try {
        const [debugPort, wsPath] = (await readFile(portFile, "utf8")).trim().split("\n");
        if (!debugPort || !wsPath) return null;
        return { port: Number(debugPort), wsUrl: `ws://127.0.0.1:${debugPort}${wsPath}` };
      } catch {
        return null;
      }
    },
    { timeout: 15000, label: "default-profile DevToolsActivePort" },
  ).catch((error) => {
    throw new Error(
      `${error.message}\n` +
        "未获得默认 profile 的 CDP 端点。若浏览器原本正在运行，请完全退出后重试；" +
        "若完全退出后仍失败，则当前浏览器/参数组合不支持该直连方式。",
    );
  });

  cdp = await Cdp.connect(devtools.wsUrl);
  console.log(`PASS: default-profile CDP connected on 127.0.0.1:${devtools.port}`);

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
    await until(
      async () => (await evaluate(sessionId, "document.readyState").catch(() => "")) === "complete",
      { timeout: 15000, label: "test page load" },
    );
  };
  const setSessionCookie = async (browserContextId) => {
    await cdp.send("Storage.setCookies", {
      cookies: [{
        name: "session",
        value: "ok",
        url: `${base}/`,
        path: "/",
        httpOnly: true,
      }],
      ...(browserContextId ? { browserContextId } : {}),
    });
  };
  const authState = async (sessionId) =>
    evaluate(sessionId, "document.getElementById('state')?.dataset.auth ?? 'missing'");

  // 默认 BrowserContext：必须证明不是另建临时 context。
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

  // 同一默认浏览器进程中的无痕上下文：初始不能看到普通 profile 的测试 Cookie。
  ({ browserContextId: incognitoContextId } = await cdp.send(
    "Target.createBrowserContext",
    { disposeOnDetach: false },
  ));
  ({ targetId: incognitoTargetId } = await cdp.send("Target.createTarget", {
    url: `${base}/app`,
    browserContextId: incognitoContextId,
  }));
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
