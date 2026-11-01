import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, until } from "../0020-p0a-chrome/cdp.mjs";
import { startHttpFixtures } from "./http-server.mjs";

const browserName = process.argv[2] ?? "chrome";
const bins = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
};
const bin = bins[browserName];
if (!bin) throw new Error("usage: node run-cdp.mjs <chrome|edge>");
const extensionDir = fileURLToPath(new URL("./extension/", import.meta.url));
const evidenceDir = fileURLToPath(new URL("./evidence/", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("./fixtures/http.json", import.meta.url), "utf8"));
const profileDir = await mkdtemp(path.join(tmpdir(), `shadekit-h0-${browserName}-`));
const checks = [];
let browser;
let fixtures;
let version = "unknown";

function record(id, ok, detail) {
  checks.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

async function launch() {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  await rm(portFile, { force: true });
  const proc = spawn(bin, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--enable-logging=stderr",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const devtools = await until(async () => {
    if (!existsSync(portFile)) return null;
    const [port, wsPath] = (await readFile(portFile, "utf8")).trim().split("\n");
    return port && wsPath ? { port, wsUrl: `ws://127.0.0.1:${port}${wsPath}` } : null;
  }, { timeout: 25000, label: `${browserName} DevToolsActivePort` }).catch((error) => {
    proc.kill("SIGKILL");
    throw new Error(`${error.message}; browser log: ${stderr.slice(-1000)}`);
  });
  let cdp;
  try {
    cdp = await Cdp.connect(devtools.wsUrl);
  } catch (error) {
    proc.kill("SIGKILL");
    throw error;
  }
  await cdp.send("Extensions.loadUnpacked", { path: extensionDir });
  const browserVersion = await cdp.send("Browser.getVersion");
  version = browserVersion.product;
  return { proc, cdp, log: () => stderr };
}

async function stop(target) {
  if (!target) return;
  target.cdp.close();
  if (target.proc.exitCode === null && target.proc.signalCode === null) target.proc.kill("SIGTERM");
  await until(() => target.proc.exitCode !== null || target.proc.signalCode !== null, {
    timeout: 5000,
    label: `${browserName} shutdown`,
  }).catch(() => {
    target.proc.kill("SIGKILL");
  });
}

async function openBridge() {
  const worker = await until(async () => {
    const { targetInfos } = await browser.cdp.send("Target.getTargets");
    for (const target of targetInfos) {
      if (target.type !== "service_worker" || !target.url.startsWith("chrome-extension://")) continue;
      const attached = await browser.cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      const manifest = await browser.cdp.send("Runtime.evaluate", {
        expression: "chrome.runtime.getManifest().name",
        returnByValue: true,
      }, attached.sessionId).catch(() => null);
      if (manifest?.result?.value === "ShadeKit H0 key and HTTP spike") return target;
    }
    return null;
  }, { timeout: 20000, label: "H0 MV3 service worker" }).catch(async (error) => {
    const { targetInfos } = await browser.cdp.send("Target.getTargets");
    const workers = targetInfos.filter((target) => target.type === "service_worker").map((target) => target.url);
    const relevantLog = browser.log().split("\n").filter((line) => /extension|manifest|shadekit/i.test(line)).join("\n");
    throw new Error(`${error.message}; workers=${JSON.stringify(workers)}; browserLog=${relevantLog.slice(-5000)}`);
  });
  const extensionId = new URL(worker.url).host;
  const { targetId } = await browser.cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/page.html`,
  });
  const { sessionId } = await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await browser.cdp.send("Page.enable", {}, sessionId);
  await browser.cdp.send("Runtime.enable", {}, sessionId);
  await until(async () => {
    const result = await browser.cdp.send("Runtime.evaluate", {
      expression: "typeof globalThis.h0Send === 'function'",
      returnByValue: true,
    }, sessionId);
    return result.result.value === true;
  }, { timeout: 10000, label: "extension page bridge" }).catch(async (error) => {
    const diagnostic = await browser.cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify({href:location.href,ready:document.readyState,chromeType:typeof chrome,sendType:typeof globalThis.h0Send,text:document.body?.innerText})",
      returnByValue: true,
    }, sessionId).catch((evaluationError) => ({ error: evaluationError.message }));
    throw new Error(`${error.message}; ${JSON.stringify(diagnostic)}`);
  });
  return { extensionId, targetId, sessionId, workerTargetId: worker.targetId };
}

async function send(page, message) {
  const response = await browser.cdp.send("Runtime.evaluate", {
    expression: `globalThis.h0Send(${JSON.stringify(message)})`,
    awaitPromise: true,
    returnByValue: true,
  }, page.sessionId);
  if (response.exceptionDetails) throw new Error("extension bridge evaluation failed");
  return response.result.value;
}

function validProbe(probe) {
  return probe?.ok === true
    && probe.keyType === "secret"
    && probe.algorithm === "AES-KW"
    && probe.extractable === false
    && probe.exportBlocked === true
    && probe.dekExtractable === false
    && probe.challengeRoundTrip === true
    && probe.plaintextFallback === false
    && typeof probe.wrappedDigest === "string";
}

async function stopServiceWorker(page) {
  await browser.cdp.send("Target.closeTarget", { targetId: page.workerTargetId });
  await until(async () => {
    const { targetInfos } = await browser.cdp.send("Target.getTargets");
    return !targetInfos.some((target) => target.targetId === page.workerTargetId);
  }, { timeout: 10000, label: "service worker stop" });
}

function sanitizeHttp(actual) {
  if (actual?.kind === "error") return actual;
  return {
    kind: actual?.kind,
    status: actual?.status,
    finalUrl: actual?.finalUrl,
    redirected: actual?.redirected,
    text: actual?.text,
    bodyBase64: actual?.bodyBase64,
    exposedSetCookieCount: actual?.setCookies?.length ?? 0,
  };
}

function httpMatches(item, actual) {
  const expected = item.expect;
  if (expected.kind === "error") {
    return actual?.kind === "error" && actual.code === expected.code && expected.causes.includes(actual.cause);
  }
  let finalPath = "";
  try {
    const url = new URL(actual.finalUrl);
    finalPath = `${url.pathname}${url.search}`;
  } catch {
    return false;
  }
  return actual?.kind === "response"
    && actual.status === expected.status
    && actual.redirected === expected.redirected
    && actual.text === expected.text
    && actual.bodyBase64 === expected.bodyBase64
    && finalPath === expected.finalPath;
}

try {
  fixtures = await startHttpFixtures();
  browser = await launch();
  let page = await openBridge();
  const initial = await send(page, { type: "probe" });
  record("indexeddb-non-extractable-key", validProbe(initial), initial);

  await stopServiceWorker(page);
  const afterWorkerRestart = await send(page, { type: "probe" });
  const currentWorker = await until(async () => {
    const { targetInfos } = await browser.cdp.send("Target.getTargets");
    return targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${page.extensionId}/`));
  }, { timeout: 15000, label: "message-triggered MV3 restart" });
  record("mv3-background-restart", validProbe(afterWorkerRestart)
    && afterWorkerRestart.wrappedDigest === initial.wrappedDigest
    && afterWorkerRestart.instanceId !== initial.instanceId, afterWorkerRestart);
  page.workerTargetId = currentWorker.targetId;

  await stop(browser);
  browser = await launch();
  page = await openBridge();
  const afterBrowserRestart = await send(page, { type: "probe" });
  record("browser-restart-same-profile", validProbe(afterBrowserRestart)
    && afterBrowserRestart.wrappedDigest === initial.wrappedDigest, afterBrowserRestart);

  const targets = {
    http: `http://127.0.0.1:${fixtures.httpPort}`,
    https: `https://127.0.0.1:${fixtures.httpsPort}`,
    closed: `http://127.0.0.1:${fixtures.closedPort}`,
  };
  for (const item of fixture.cases) {
    const url = `${targets[item.request.target]}${item.request.path}`;
    const actual = await send(page, {
      type: "http",
      request: { ...item.request, url, target: undefined, path: undefined },
    });
    const sanitized = sanitizeHttp(actual);
    record(`http-${item.id}`, httpMatches(item, actual), sanitized);
    if (item.id === "set-cookie-replay") {
      const cookies = await send(page, { type: "cookie-names", url: targets.http });
      const names = cookies.map((cookie) => cookie.name).sort();
      const session = cookies.find((cookie) => cookie.name === "h0_session");
      const preference = cookies.find((cookie) => cookie.name === "h0 Preference");
      record("http-set-cookie-browser-context", item.expect.cookieNames.slice().sort().every((name) => names.includes(name))
        && session?.httpOnly === true && session?.sameSite === "lax"
        && preference?.session === false && preference?.sameSite === "lax", { cookies });
    }
  }

  await send(page, { type: "forget-key" });
  const unavailable = await send(page, { type: "probe" });
  record("missing-key-no-plaintext-fallback", unavailable?.ok === false
    && unavailable.code === "VAULT_UNAVAILABLE"
    && unavailable.plaintextFallback === false, unavailable);
} catch (error) {
  record("harness-error", false, error instanceof Error ? error.message : String(error));
} finally {
  await stop(browser);
  await fixtures?.cleanup();
  await rm(profileDir, { recursive: true, force: true });
}

const evidence = {
  schema: "shadekit-h0-browser-evidence/v1",
  browser: browserName,
  version,
  platform: process.platform,
  arch: process.arch,
  executedAt: new Date().toISOString(),
  profile: "disposable-isolated-profile",
  checks,
};
await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, `${browserName}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${checks.filter((check) => check.ok).length}/${checks.length} checks passed; evidence: ${browserName}.json`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
