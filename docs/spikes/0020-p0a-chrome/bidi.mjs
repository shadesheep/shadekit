/**
 * 最小 WebDriver BiDi 客户端（P0b spike）。
 *
 * 与 CDP 的差异（都已在本文件里处理）：
 * - 连上后**必须先发 session.new**
 * - 命令/响应是 {id, method, params} / {type:"success"|"error"}，没有 sessionId 路由
 * - 用 `goog:channel` 订阅事件（chrome 语义，Firefox 同样支持）
 * - browsingContext.create 没有 url 参数，必须拆成 create + navigate
 * - script.evaluate 返回 RemoteValue，需显式反序列化
 */
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { until, sleep } from "./cdp.mjs";

export const FIREFOX = "/tmp/shadekit-ff/Firefox.app/Contents/MacOS/firefox";

export class Bidi {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  static async connect(wsUrl) {
    const b = new Bidi();
    b.#ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      b.#ws.once("open", resolve);
      b.#ws.once("error", reject);
    });
    b.#ws.on("message", (raw) => b.#onMessage(JSON.parse(raw.toString())));
    b.#ws.on("close", () => {
      for (const { reject } of b.#pending.values()) reject(new Error("BiDi closed"));
      b.#pending.clear();
    });
    return b;
  }

  #onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.type === "error") {
        p.reject(new Error(`${p.method}: ${msg.error} ${msg.message ?? ""}`));
      } else p.resolve(msg.result);
      return;
    }
    // event: {type:"event", method, params}
    for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(fn);
    return () => this.#listeners.get(method)?.delete(fn);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* noop */
    }
  }
}

// ============================================================
// Launch + port discovery
// ============================================================

export async function launchFirefox({ headless = false, extraArgs = [] } = {}) {
  const profileDir = await mkdtemp(path.join(tmpdir(), "shadekit-ffp-"));
  const portFile = path.join(profileDir, "WebDriverBiDiServer.json");
  const args = [
    "-no-remote",
    "--profile",
    profileDir,
    "--remote-debugging-port",
    "0",
    ...(headless ? ["--headless"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(FIREFOX, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.stdout.on("data", (d) => (stderr += d.toString()));

  let info;
  try {
    info = await until(
      async () => {
        if (!existsSync(portFile)) return null;
        try {
          const j = JSON.parse(await readFile(portFile, "utf8"));
          if (!j.ws_port) return null;
          return { port: j.ws_port, wsUrl: `ws://${j.ws_host ?? "127.0.0.1"}:${j.ws_port}/session` };
        } catch {
          return null; // 文件正在写
        }
      },
      { timeout: 30000, label: "WebDriverBiDiServer.json" },
    );
  } catch (e) {
    proc.kill("SIGKILL");
    throw new Error(`${e.message}\nfirefox log:\n${stderr.slice(-3000)}`);
  }

  const bidi = await Bidi.connect(info.wsUrl);
  const session = await bidi.send("session.new", { capabilities: {} });
  return {
    proc,
    bidi,
    info,
    session,
    profileDir,
    async cleanup() {
      bidi.close();
      proc.kill("SIGTERM");
      await sleep(600);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ============================================================
// RemoteValue 反序列化
// ============================================================

/** BiDi RemoteValue → JS 值。生产 shim 应直接用 JSON.stringify 包裹（ADR D3）。 */
export function deserialize(v) {
  if (!v || typeof v !== "object") return v;
  switch (v.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
      return v.value;
    case "number":
      return v.value;
    case "bigint":
      return BigInt(v.value);
    case "array":
    case "set":
      return (v.value ?? []).map(deserialize);
    case "object":
    case "map":
      return Object.fromEntries((v.value ?? []).map(([k, val]) => [k, deserialize(val)]));
    default:
      return v.value;
  }
}

// ============================================================
// BiDi 会话封装（≈ BrowserSession）
// ============================================================

export class FirefoxSession {
  #bidi;
  constructor(bidi) {
    this.#bidi = bidi;
  }

  get bidi() {
    return this.#bidi;
  }

  async createUserContext() {
    const { userContext } = await this.#bidi.send("browser.createUserContext", {});
    return userContext;
  }

  /** tabs.create({url})：必须拆成 create + navigate（BiDi 的 create 没有 url 参数） */
  async createTab(url, userContext) {
    const { context } = await this.#bidi.send("browsingContext.create", {
      type: "tab",
      ...(userContext ? { userContext } : {}),
    });
    if (url && url !== "about:blank") {
      await this.navigate(context, url);
      await this.waitLoaded(context);
    }
    return context;
  }

  async navigate(context, url) {
    const res = await this.#bidi.send("browsingContext.navigate", {
      context,
      url,
      wait: "complete",
    });
    return res;
  }

  async reload(context) {
    await this.#bidi.send("browsingContext.reload", { context, wait: "complete" });
  }

  async waitLoaded(context, timeout = 20000) {
    await until(
      async () => {
        const r = await this.#bidi
          .send("script.evaluate", {
            expression: "document.readyState",
            target: { context },
            awaitPromise: false,
          })
          .catch(() => null);
        return deserialize(r?.result) === "complete";
      },
      { timeout, label: `firefox page load ${context.slice(0, 8)}` },
    );
  }

  async evaluate(context, expression) {
    const r = await this.#bidi.send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
      serializationOptions: { maxObjectDepth: null, maxDomDepth: 0 },
    });
    if (r.type === "exception") {
      throw new Error(r.exceptionDetails?.text ?? "evaluation failed");
    }
    return deserialize(r.result);
  }

  /** script.evaluate 的 sandbox 形态（≈ ISOLATED world） */
  async evaluateInSandbox(context, expression, sandbox) {
    const r = await this.#bidi.send("script.evaluate", {
      expression,
      target: { context, sandbox },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (r.type === "exception") throw new Error(r.exceptionDetails?.text ?? "eval failed");
    return deserialize(r.result);
  }

  /** storage.getCookies（partition 带 userContext） */
  async getCookies(userContext, filter) {
    const { cookies } = await this.#bidi.send("storage.getCookies", {
      partition: userContext ? { type: "storageKey", userContext } : undefined,
    });
    const list = cookies ?? [];
    return filter?.name ? list.filter((c) => c.name === filter.name) : list;
  }

  async setCookie(userContext, { name, value, domain, path: p, secure, httpOnly, sameSite, expiry }) {
    const cookie = {
      name,
      value: { type: "string", value }, // 值需类型包装
      ...(domain ? { domain } : {}),
      ...(p ? { path: p } : {}),
      ...(secure !== undefined ? { secure } : {}),
      ...(httpOnly !== undefined ? { httpOnly } : {}),
      ...(sameSite ? { sameSite } : {}),
      ...(expiry ? { expiry } : {}),
    };
    await this.#bidi.send("storage.setCookie", {
      cookie,
      partition: {
        type: "storageKey",
        // ⚠️ Firefox 强制要求 sourceOrigin 才会落到站点上
        ...(userContext ? { userContext } : {}),
        sourceOrigin: `http://${domain ?? "localhost"}${p ?? "/"}`,
      },
    });
  }

  async screenshot(context) {
    const { data } = await this.#bidi.send("browsingContext.captureScreenshot", { context });
    return data;
  }
}
