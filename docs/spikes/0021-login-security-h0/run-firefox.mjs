import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bidi, deserialize } from "../0020-p0a-chrome/bidi.mjs";
import { sleep, until } from "../0020-p0a-chrome/cdp.mjs";
import { startHttpFixtures } from "./http-server.mjs";

const bin = process.env.FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const sourceExtensionDir = fileURLToPath(new URL("./extension/", import.meta.url));
const evidenceDir = fileURLToPath(new URL("./evidence/", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("./fixtures/http.json", import.meta.url), "utf8"));
const workDir = await mkdtemp(path.join(tmpdir(), "shadekit-h0-firefox-"));
const profileDir = path.join(workDir, "profile");
const extensionDir = path.join(workDir, "extension");
const checks = [];
const backgroundIdleWaitMs = 95_000;
let browser;
let fixtures;
let version = "unknown";

function record(id, ok, detail) {
  checks.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

async function prepareFirefoxExtension() {
  await cp(sourceExtensionDir, extensionDir, { recursive: true });
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background.scripts = ["background.js"];
  manifest.permissions.push("tabs");
  manifest.browser_specific_settings = {
    gecko: { id: "shadekit-h0-key-spike@shadekit.local" },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const backgroundPath = path.join(extensionDir, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  await writeFile(backgroundPath, `${background}\nchrome.tabs.create({ url: chrome.runtime.getURL("page.html") });\n`);
}

async function launch() {
  const portFile = path.join(profileDir, "WebDriverBiDiServer.json");
  await rm(portFile, { force: true });
  const proc = spawn(bin, [
    "-no-remote",
    "--profile",
    profileDir,
    "--remote-debugging-port",
    "0",
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const info = await until(async () => {
    if (!existsSync(portFile)) return null;
    try {
      const value = JSON.parse(await readFile(portFile, "utf8"));
      return value.ws_port
        ? { port: value.ws_port, wsUrl: `ws://${value.ws_host ?? "127.0.0.1"}:${value.ws_port}/session` }
        : null;
    } catch {
      return null;
    }
  }, { timeout: 30000, label: "Firefox WebDriverBiDiServer.json" }).catch((error) => {
    proc.kill("SIGKILL");
    throw new Error(`${error.message}; browser log: ${output.slice(-3000)}`);
  });
  const bidi = await Bidi.connect(info.wsUrl);
  const session = await bidi.send("session.new", { capabilities: {} });
  version = session.capabilities.browserVersion;
  const installed = await bidi.send("webExtension.install", {
    extensionData: { type: "path", path: extensionDir },
  });
  return { proc, bidi, extensionId: installed.extension, log: () => output };
}

async function stop(target) {
  if (!target) return;
  target.bidi.close();
  if (target.proc.exitCode === null && target.proc.signalCode === null) target.proc.kill("SIGTERM");
  await until(() => target.proc.exitCode !== null || target.proc.signalCode !== null, {
    timeout: 10000,
    label: "Firefox shutdown",
  }).catch(() => {
    target.proc.kill("SIGKILL");
  });
}

async function openBridge(extensionId) {
  const context = await until(async () => {
    const tree = await browser.bidi.send("browsingContext.getTree", {});
    const tab = tree.contexts.find((item) => item.url.startsWith("moz-extension://") && item.url.endsWith("/page.html"));
    return tab?.context;
  }, { timeout: 15000, label: `Firefox extension tab ${extensionId}` });
  await until(async () => {
    const result = await browser.bidi.send("script.evaluate", {
      expression: "typeof globalThis.h0Send === 'function'",
      target: { context },
      awaitPromise: false,
    }).catch(() => null);
    return deserialize(result?.result) === true;
  }, { timeout: 10000, label: "Firefox extension page bridge" }).catch(async (error) => {
    const diagnostic = await evaluate(context, "JSON.stringify({href:location.href,ready:document.readyState,chromeType:typeof chrome,sendType:typeof globalThis.h0Send,scripts:Array.from(document.scripts).map(s=>s.src),text:document.body?.innerText})").catch((evaluationError) => ({ error: evaluationError.message }));
    throw new Error(`${error.message}; ${JSON.stringify(diagnostic)}`);
  });
  return { context, extensionId };
}

async function evaluate(context, expression) {
  const response = await browser.bidi.send("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
    serializationOptions: { maxObjectDepth: null, maxDomDepth: 0 },
  });
  if (response.type === "exception") {
    throw new Error(response.exceptionDetails?.text ?? "Firefox extension evaluation failed");
  }
  return deserialize(response.result);
}

async function send(page, message) {
  return evaluate(page.context, `globalThis.h0Send(${JSON.stringify(message)})`);
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
  await prepareFirefoxExtension();
  fixtures = await startHttpFixtures();
  browser = await launch();
  let page = await openBridge(browser.extensionId);
  const initial = await send(page, { type: "probe" });
  record("indexeddb-non-extractable-key", validProbe(initial), initial);

  console.log(`[WAIT] Firefox event page idle for ${backgroundIdleWaitMs}ms`);
  await sleep(backgroundIdleWaitMs);
  const afterBackgroundRestart = await send(page, { type: "probe" });
  record("mv3-background-restart", validProbe(afterBackgroundRestart)
    && afterBackgroundRestart.wrappedDigest === initial.wrappedDigest
    && afterBackgroundRestart.instanceId !== initial.instanceId, {
    ...afterBackgroundRestart,
    idleWaitMs: backgroundIdleWaitMs,
    backgroundModel: "event-page",
  });

  await stop(browser);
  browser = await launch();
  page = await openBridge(browser.extensionId);
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
  await rm(workDir, { recursive: true, force: true });
}

const evidence = {
  schema: "shadekit-h0-browser-evidence/v1",
  browser: "firefox",
  version,
  platform: process.platform,
  arch: process.arch,
  executedAt: new Date().toISOString(),
  profile: "disposable-isolated-profile",
  backgroundModel: "event-page",
  checks,
};
await mkdir(evidenceDir, { recursive: true });
await writeFile(path.join(evidenceDir, "firefox.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${checks.filter((check) => check.ok).length}/${checks.length} checks passed; evidence: firefox.json`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
