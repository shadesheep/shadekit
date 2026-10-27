/**
 * 最小 CDP 客户端 + chrome.* shim 原型（P0a spike）。
 *
 * 只为验证可行性，不是生产实现。刻意保持「一个 WebSocket、按 sessionId 路由」。
 */
import { WebSocket } from "ws";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询直到 fn 返回真值或超时 */
export async function until(fn, { timeout = 15000, interval = 100, label = "condition" } = {}) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
}

// ============================================================
// CDP transport
// ============================================================

export class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  wsUrl = "";

  static async connect(wsUrl) {
    const cdp = new Cdp();
    cdp.wsUrl = wsUrl;
    cdp.#ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      cdp.#ws.once("open", resolve);
      cdp.#ws.once("error", reject);
    });
    cdp.#ws.on("message", (raw) => cdp.#onMessage(JSON.parse(raw.toString())));
    cdp.#ws.on("close", () => {
      for (const { reject } of cdp.#pending.values())
        reject(new Error("CDP connection closed"));
      cdp.#pending.clear();
    });
    return cdp;
  }

  #onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error)
        p.reject(
          new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`),
        );
      else p.resolve(msg.result);
      return;
    }
    // event
    const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
    for (const fn of this.#listeners.get(key) ?? []) fn(msg.params, msg.sessionId);
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  on(method, fn, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(fn);
    return () => this.#listeners.get(key)?.delete(fn);
  }

  once(method, { sessionId, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting event ${method}`));
      }, timeout);
      const off = this.on(
        method,
        (params) => {
          clearTimeout(timer);
          off();
          resolve(params);
        },
        sessionId,
      );
    });
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

export const EDGE =
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

export async function launchChrome({ headless = false, extraArgs = [], bin = CHROME } = {}) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "shadekit-spike-"));
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  let devtools;
  try {
    devtools = await until(
      async () => {
        if (!existsSync(portFile)) return null;
        const text = await readFile(portFile, "utf8");
        const [port, wsPath] = text.trim().split("\n");
        if (!port || !wsPath) return null;
        return { port: Number(port), wsPath, wsUrl: `ws://127.0.0.1:${port}${wsPath}` };
      },
      { timeout: 20000, label: "DevToolsActivePort" },
    );
  } catch (e) {
    proc.kill("SIGKILL");
    throw new Error(`${e.message}\nchrome stderr:\n${stderr.slice(-3000)}`);
  }

  const cdp = await Cdp.connect(devtools.wsUrl);
  return {
    proc,
    cdp,
    devtools,
    userDataDir,
    async cleanup() {
      cdp.close();
      proc.kill("SIGTERM");
      await sleep(300);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ============================================================
// chrome.* shim（原型）
// ============================================================

/**
 * 一个 BrowserSession 对应「引擎眼中的一个浏览器」：一个 browserContext + 若干 tab。
 * tabs 的 id 是自增的本地句柄，映射到 CDP targetId + sessionId。
 */
export class BrowserSession {
  #cdp;
  #nextTabId = 1;
  tabs = new Map(); // tabId -> { targetId, sessionId, url, status, contextId, loaderId }
  #contextId = null;
  #destroyed = new Set();

  constructor(cdp, { contextId = null } = {}) {
    this.#cdp = cdp;
    this.#contextId = contextId;
    this.#cdp.on("Target.targetDestroyed", ({ targetId }) => {
      for (const [tabId, tab] of this.tabs) {
        if (tab.targetId === targetId) {
          this.tabs.delete(tabId);
          this.#destroyed.add(tabId);
        }
      }
    });
  }

  get cdp() {
    return this.#cdp;
  }

  async init() {
    // D2 的关键点：flatten auto-attach 才能拿到新 tab 的 session
    await this.#cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });
    // 接收 paused/waitingForDebugger 时必须放行，否则新 target 卡住
    this.#cdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo, waitingForDebugger }) => {
      try {
        await this.#cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      } catch {
        /* headless 下可能不需要 */
      }
      if (targetInfo.type === "page") this.#onAttached(sessionId, targetInfo);
    });
    // 已有 target（about:blank）不会触发 attachedToTarget，需要显式 attach
    const { targetInfos } = await this.#cdp.send("Target.getTargets");
    for (const info of targetInfos) {
      if (info.type !== "page") continue;
      if (this.#contextId && info.browserContextId !== this.#contextId) continue;
      const { sessionId } = await this.#cdp.send("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      });
      this.#onAttached(sessionId, info);
      await this.#enableDomains(sessionId);
    }
  }

  #onAttached(sessionId, targetInfo) {
    const existing = [...this.tabs.values()].find((t) => t.targetId === targetInfo.targetId);
    if (existing) return existing;
    const tab = {
      tabId: this.#nextTabId++,
      targetId: targetInfo.targetId,
      sessionId,
      url: targetInfo.url,
      status: "complete",
      contextId: targetInfo.browserContextId ?? null,
      loaderId: undefined,
    };
    this.tabs.set(tab.tabId, tab);
    this.#enableDomains(sessionId).catch(() => {});
    return tab;
  }

  async #enableDomains(sessionId) {
    await this.#cdp.send("Page.enable", {}, sessionId);
    await this.#cdp.send("Runtime.enable", {}, sessionId);
    await this.#cdp.send("Network.enable", {}, sessionId);
  }

  async createContext() {
    const { browserContextId } = await this.#cdp.send("Target.createBrowserContext", {
      disposeOnDetach: false,
    });
    this.#contextId = browserContextId;
    return browserContextId;
  }

  /** tabs.create({url}) */
  async createTab(url) {
    const params = { url: "about:blank" };
    if (this.#contextId) params.browserContextId = this.#contextId;

    const attached = new Promise((resolve) => {
      const off = this.#cdp.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
        if (targetInfo.type !== "page") return;
        if (this.#contextId && targetInfo.browserContextId !== this.#contextId) return;
        off();
        resolve({ sessionId, targetInfo });
      });
    });
    const { targetId } = await this.#cdp.send("Target.createTarget", params);
    const { sessionId, targetInfo } = await attached;

    const tab = this.#onAttached(sessionId, targetInfo);
    tab.targetId = targetId;
    // shim 里 tabs.create({url}) = 建 + 导航（与 BiDi 需要拆两步的形态统一）
    if (url && url !== "about:blank") {
      await this.navigateAndWait(tab.tabId, url);
    }
    return this.getTab(tab.tabId);
  }

  getTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return {
      id: tab.tabId,
      url: tab.url,
      pendingUrl: tab.url,
      status: tab.status,
      active: true,
      windowId: 1,
    };
  }

  /** 导航后 executionContext 全失效，必须清缓存 */
  #invalidateContexts(tab) {
    tab.mainContextId = undefined;
    tab.contexts?.clear();
  }

  async navigate(tabId, url) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    tab.url = url;
    tab.status = "loading";
    this.#invalidateContexts(tab);
    const res = await this.#cdp.send("Page.navigate", { url }, tab.sessionId);
    if (res.errorText) throw new Error(`navigation failed: ${res.errorText} (${url})`);
  }

  async reload(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    tab.status = "loading";
    this.#invalidateContexts(tab);
    await this.#cdp.send("Page.reload", { ignoreCache: false }, tab.sessionId);
  }

  async navigateAndWait(tabId, url, timeout = 20000) {
    const loaded = this.waitLoaded(tabId, timeout).catch((e) => {
      throw e;
    });
    await this.navigate(tabId, url);
    await loaded;
  }

  async reloadAndWait(tabId, timeout = 20000) {
    const loaded = this.waitLoaded(tabId, timeout);
    await this.reload(tabId);
    await loaded;
  }

  /**
   * 等待页面加载完成。
   * 以轮询 document.readyState 为准（D2 里写的是 Page.lifecycleEvent，
   * 实测在跨进程导航时事件与 context 重建存在竞态，轮询更稳；生产实现可两者并用）。
   */
  async waitLoaded(tabId, timeout = 20000) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    await until(
      async () => {
        try {
          const state = await this.evaluate(tabId, "document.readyState");
          return state === "complete";
        } catch {
          return false; // 导航中 context 尚未就绪
        }
      },
      { timeout, interval: 100, label: `page load (tab ${tabId})` },
    );
    tab.status = "complete";
  }

  async closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    await this.#cdp.send("Target.closeTarget", { targetId: tab.targetId });
  }

  async activate(tabId) {
    const tab = this.tabs.get(tabId);
    if (tab) await this.#cdp.send("Target.activateTarget", { targetId: tab.targetId });
  }

  /**
   * chrome.scripting.executeScript 的最小等价：单 frame 或全 frame。
   *
   * ⚠️ 关键发现：跨源 iframe 是 OOPIF，不在父 page session 的 frameTree 里，
   * 必须从 Target.getTargets 找 type="iframe" 并单独 attachToTarget。
   * ADR-0020 D3 只写了「取 frame 树 → 逐 frame 建 context」，这一条需要补。
   */
  async executeScript(tabId, funcSource, args = [], { allFrames = false, world = "MAIN" } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);

    const expression = `(${funcSource})(...${JSON.stringify(args)})`;
    const results = [];
    let index = 0;

    const evalIn = async (sessionId, contextId, frameId) => {
      try {
        const { result, exceptionDetails } = await this.#cdp.send(
          "Runtime.evaluate",
          { expression, contextId, returnByValue: true, awaitPromise: true, userGesture: true },
          sessionId,
        );
        results.push({
          frameId: frameId ?? index++,
          result: exceptionDetails ? null : result.value,
          ...(exceptionDetails
            ? { error: exceptionDetails.exception?.description ?? exceptionDetails.text }
            : {}),
        });
      } catch (e) {
        results.push({ frameId: frameId ?? index++, result: null, error: e.message });
      }
    };

    if (!allFrames) {
      const { contextId } = await this.#executionContext(tab, tab.targetId, world);
      await evalIn(tab.sessionId, contextId);
      return results;
    }

    // 1) 同进程 frame：Page.getFrameTree + 各 frame 的 execution context
    const frameIds = await this.#frameIds(tab);
    for (const frameId of frameIds) {
      const contexts = await this.#frameContexts(tab);
      const ctxId =
        world === "MAIN"
          ? contexts.find((c) => c.frameId === frameId && c.isDefault)?.id
          : await this.#isolatedContext(tab, frameId);
      if (ctxId === undefined) {
        results.push({ frameId: index++, result: null, error: `no context for frame ${frameId}` });
        continue;
      }
      await evalIn(tab.sessionId, ctxId, index++);
    }

    // 2) OOPIF：type="iframe" 的独立 target
    const oopifs = await this.#oopifTargets(tab);
    for (const info of oopifs) {
      try {
        const { sessionId } = await this.#cdp.send("Target.attachToTarget", {
          targetId: info.targetId,
          flatten: true,
        });
        await this.#cdp.send("Page.enable", {}, sessionId).catch(() => {});
        await this.#cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
        await evalIn(sessionId, undefined, index++);
        await this.#cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      } catch (e) {
        results.push({ frameId: index++, result: null, error: e.message });
      }
    }
    return results;
  }

  /** 当前 tab 内所有 OOPIF target（跨源 iframe） */
  async #oopifTargets(tab) {
    const { targetInfos } = await this.#cdp.send("Target.getTargets");
    return targetInfos.filter(
      (t) => t.type === "iframe" && (!this.#contextId || t.browserContextId === this.#contextId),
    );
  }

  async #isolatedContext(tab, frameId) {
    const key = `${frameId}:isolated`;
    tab.contexts ??= new Map();
    if (tab.contexts.has(key)) return tab.contexts.get(key);
    const { executionContextId } = await this.#cdp.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "shadekit", grantUniveralAccess: false },
      tab.sessionId,
    );
    tab.contexts.set(key, executionContextId);
    return executionContextId;
  }

  /** 当前 tab 的所有 frame 默认上下文 */
  async #frameContexts(tab) {
    tab.ctxList ??= new Map();
    if (tab.ctxHooked !== true) {
      tab.ctxHooked = true;
      this.#cdp.on(
        "Runtime.executionContextCreated",
        ({ context }) => {
          if (!context.auxData?.frameId) return;
          tab.ctxList.set(context.id, {
            id: context.id,
            frameId: context.auxData.frameId,
            isDefault: context.auxData.isDefault === true,
          });
        },
        tab.sessionId,
      );
      this.#cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => tab.ctxList.delete(executionContextId), tab.sessionId);
      this.#cdp.on("Runtime.executionContextsCleared", () => tab.ctxList.clear(), tab.sessionId);
    }
    if (tab.ctxList.size === 0) {
      await this.#cdp.send("Runtime.disable", {}, tab.sessionId).catch(() => {});
      await this.#cdp.send("Runtime.enable", {}, tab.sessionId);
      await sleep(50);
    }
    return [...tab.ctxList.values()];
  }

  /** 直接求值（单 frame，主 frame） */
  async evaluate(tabId, expression, { awaitPromise = true } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    const { result, exceptionDetails } = await this.#cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      tab.sessionId,
    );
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  async #frameIds(tab) {
    const { frameTree } = await this.#cdp.send("Page.getFrameTree", {}, tab.sessionId);
    const out = [];
    const walk = (node) => {
      out.push(node.frame.id);
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(frameTree);
    return out;
  }

  /**
   * frame + world → executionContextId。
   * MAIN world 用默认上下文（Runtime.executionContextCreated 的 auxData.isDefault），
   * ISOLATED world 用 Page.createIsolatedWorld（每个 frame 一个）。
   *
   * 简化：MAIN world 一律取主 frame 的默认上下文——与本 spike 覆盖的引擎调用一致
   * （真实 shim 需要按 frame 建映射，见 ADR-0020 D3 的 allFrames 说明）。
   */
  async #executionContext(tab, frameId, world) {
    if (world === "MAIN") {
      return { contextId: await this.mainContextId(tab.tabId) };
    }
    // 单 frame 且没有 frameId 语义（tab.targetId）时，回退到主 frame
    const { frameTree } = await this.#cdp.send("Page.getFrameTree", {}, tab.sessionId);
    const realFrameId = frameId === tab.targetId ? frameTree.frame.id : frameId;
    return { contextId: await this.#isolatedContext(tab, realFrameId) };
  }

  /**
   * 主 frame 的默认上下文 id（缓存）。
   * 用 Runtime.disable/enable 让浏览器补发 executionContextCreated 事件，
   * 避免依赖「事件已经在更早时候到达」的竞态。
   */
  async mainContextId(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    if (tab.mainContextId !== undefined) return tab.mainContextId;

    tab.ctxList ??= new Map();
    const { frameTree } = await this.#cdp.send("Page.getFrameTree", {}, tab.sessionId);
    const mainFrameId = frameTree.frame.id;
    tab.mainFrameId = mainFrameId;

    const pick = () =>
      [...tab.ctxList.values()].find((c) => c.frameId === mainFrameId && c.isDefault)?.id;

    if (tab.ctxHooked !== true) {
      tab.ctxHooked = true;
      this.#cdp.on(
        "Runtime.executionContextCreated",
        ({ context }) => {
          if (context.auxData?.frameId) {
            tab.ctxList.set(context.id, {
              id: context.id,
              frameId: context.auxData.frameId,
              isDefault: context.auxData.isDefault === true,
            });
            if (context.auxData.frameId === tab.mainFrameId && context.auxData.isDefault) {
              tab.mainContextId = context.id;
            }
          }
        },
        tab.sessionId,
      );
      this.#cdp.on(
        "Runtime.executionContextDestroyed",
        ({ executionContextId }) => {
          tab.ctxList.delete(executionContextId);
          if (tab.mainContextId === executionContextId) tab.mainContextId = undefined;
        },
        tab.sessionId,
      );
      this.#cdp.on(
        "Runtime.executionContextsCleared",
        () => {
          tab.ctxList.clear();
          tab.mainContextId = undefined;
          tab.contexts?.clear();
        },
        tab.sessionId,
      );
    }

    let found = pick();
    if (found === undefined) {
      await this.#cdp.send("Runtime.disable", {}, tab.sessionId).catch(() => {});
      await this.#cdp.send("Runtime.enable", {}, tab.sessionId);
      found = await until(pick, { timeout: 3000, label: "main execution context" }).catch(
        () => undefined,
      );
    }
    if (found === undefined) throw new Error("main execution context not found");
    tab.mainContextId = found;
    return found;
  }

  /** cookies.getAll({}) —— 关键：context 内全量，不按 url 过滤 */
  async getAllCookies(filter = {}) {
    const params = {};
    if (this.#contextId) params.browserContextId = this.#contextId;
    const { cookies } = await this.#cdp.send("Storage.getCookies", params);
    return cookies
      .filter((c) => (filter.name === undefined || c.name === filter.name))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        hostOnly: !c.domain.startsWith("."),
        session: c.session,
        expirationDate: c.expires === -1 ? undefined : c.expires,
        sameSite: c.sameSite,
      }));
  }

  async setCookie({ url, name, value, domain, path: cookiePath, secure, httpOnly, sameSite, expirationDate }) {
    const u = new URL(url);
    const param = {
      name,
      value,
      url,
      path: cookiePath ?? "/",
      secure: secure ?? u.protocol === "https:",
      httpOnly: httpOnly ?? false,
    };
    if (domain) param.domain = domain;
    if (sameSite) param.sameSite = sameSite;
    if (expirationDate) param.expires = expirationDate;
    // 注意：Chrome 155 起 browser 级连接没有 Network.setCookie（它要求 page session），
    // 必须用 Storage.setCookies({cookies, browserContextId})
    const params = { cookies: [param] };
    if (this.#contextId) params.browserContextId = this.#contextId;
    await this.#cdp.send("Storage.setCookies", params);
    return true;
  }

  /**
   * cookies.remove 的等价：Storage 域没有 deleteCookies，两条可行路径：
   * 1) 写成过期空值（实测立即消失）
   * 2) 路由到该 context 内任一 page session 的 Network.deleteCookies
   * 这里用 1)，因为它不依赖「context 里必须开着一个 tab」。
   */
  async removeCookie({ url, name }) {
    await this.setCookie({
      url,
      name,
      value: "",
      expirationDate: 1,
    });
  }

  async disposeContext() {
    if (!this.#contextId) return;
    await this.#cdp.send("Target.disposeBrowserContext", { browserContextId: this.#contextId });
    this.#contextId = null;
  }
}
