import type { AuthContext } from "./types";
import type { CookieRecord, HostBridge, PageAgentCommand, PageFrameResult, ScriptRequestDto } from "./runtime";
import type { SpecOpName } from "./spec/types";
import { domActionInPage } from "./page-agent";
import { scanLoginFormInPage } from "./page-agent";
import { reloadTabAndWait, waitForTabLoaded } from "./utils/tab-load";
import { fetchWithTimeout, RequestTimeoutError } from "./utils/fetch-timeout";
import { LoginError, ErrorCodes } from "./utils/error-codes";
import { assertRuntimeTarget } from "./permissions/permission-gateway";

const SUPPORTED_OPS: SpecOpName[] = [
  "clear.cookies", "clear.storage", "goto", "http.execute", "apply.set", "digest",
  "crypto.encrypt", "payload.build", "map", "auth.write", "auth.capture",
  "auth.restore", "fill", "click", "waitFor", "extract", "script",
];

function cookieFromChrome(cookie: chrome.cookies.Cookie): CookieRecord {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
    session: cookie.session,
    hostOnly: cookie.hostOnly ?? false,
  };
}

async function executePageCommand(tabId: number, command: PageAgentCommand): Promise<PageFrameResult[]> {
  switch (command.action) {
    case "dom":
      return chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "MAIN", func: domActionInPage, args: [command.input],
      }) as Promise<PageFrameResult[]>;
    case "scanLoginForm":
      return chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: "MAIN", func: scanLoginFormInPage,
      }) as Promise<PageFrameResult[]>;
    case "storage.read":
      return chrome.scripting.executeScript({
        target: { tabId, allFrames: command.allFrames === true }, world: "MAIN",
        func: (area: "local" | "session", keys: string[] | null) => {
          const store = area === "local" ? localStorage : sessionStorage;
          const result: Record<string, string> = {};
          for (const key of keys ?? Object.keys(store)) {
            const value = store.getItem(key);
            if (value !== null) result[key] = value;
          }
          return result;
        },
        args: [command.area, command.keys],
      }) as Promise<PageFrameResult[]>;
    case "storage.has":
      return chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (area: "local" | "session", key: string) =>
          (area === "local" ? localStorage : sessionStorage).getItem(key) !== null,
        args: [command.area, command.key],
      }) as Promise<PageFrameResult[]>;
    case "storage.write":
      await assertRuntimeTarget((await chrome.tabs.get(tabId)).url ?? "");
      return chrome.scripting.executeScript({
        target: { tabId },
        func: (area: "local" | "session", entries: Record<string, string>) => {
          const store = area === "local" ? localStorage : sessionStorage;
          for (const [key, value] of Object.entries(entries)) store.setItem(key, value);
        },
        args: [command.area, command.entries],
      }) as Promise<PageFrameResult[]>;
    case "storage.clear":
      await assertRuntimeTarget((await chrome.tabs.get(tabId)).url ?? "");
      return chrome.scripting.executeScript({
        target: { tabId },
        func: (area: "local" | "session", keys: string[] | null) => {
          const store = area === "local" ? localStorage : sessionStorage;
          if (keys === null) store.clear();
          else for (const key of keys) store.removeItem(key);
        },
        args: [command.area, command.keys],
      }) as Promise<PageFrameResult[]>;
  }
}

async function executeScript(tabId: number, request: ScriptRequestDto): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: request.world,
    func: (source: string, serializedBindings: string) => {
      try {
        const factory = new Function(`return (${source});`)() as (bindings: unknown) => unknown;
        if (typeof factory !== "function") return { ok: false as const, error: "脚本必须是函数表达式" };
        const input = JSON.parse(serializedBindings) as Record<string, unknown>;
        const value = factory(Object.freeze({ ...input }));
        return { ok: true as const, value: value === undefined ? null : value };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [request.code, JSON.stringify(request.bindings)],
  });
  let firstError: string | undefined;
  for (const result of results ?? []) {
    const value = result.result as { ok: true; value: unknown } | { ok: false; error: string } | null;
    if (value && typeof value === "object" && "ok" in value) {
      if (value.ok) return value.value;
      firstError ??= value.error;
    }
  }
  if (firstError !== undefined) throw new LoginError(ErrorCodes.LOGIN_REJECTED, `脚本执行失败: ${firstError}`);
  return null;
}

export function createChromeHostBridge(ctx: AuthContext): HostBridge {
  const tabId = ctx.tabId;
  return {
    capabilities: () => ({ specVersions: [2], ops: SUPPORTED_OPS, page: tabId > 0, session: true, script: tabId > 0 }),
    http: {
      execute: async (request) => {
        await assertRuntimeTarget(request.url);
        try {
          const response = await fetchWithTimeout(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body !== undefined ? { body: request.body } : {}),
          }, request.timeoutMs);
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => { headers[key] = value; });
          return {
            status: response.status,
            finalUrl: response.url || request.url,
            redirected: response.redirected,
            headers,
            text: await response.text(),
          };
        } catch (error) {
          if (error instanceof RequestTimeoutError) {
            throw Object.assign(new Error(error.message), { code: "HTTP_TIMEOUT", reason: "timeout" });
          }
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
            code: "HTTP_TRANSPORT_ERROR", reason: "unknown",
          });
        }
      },
    },
    ...(tabId > 0 ? {
      page: {
        execute: (command: PageAgentCommand) => executePageCommand(tabId, command),
        currentUrl: async () => {
          const tab = await chrome.tabs.get(tabId);
          return tab.pendingUrl || tab.url || "";
        },
        navigate: async (url: string) => { await assertRuntimeTarget(url); await chrome.tabs.update(tabId, { url }); },
        waitForLoad: (timeoutMs: number) => waitForTabLoaded(tabId, timeoutMs),
        reload: (timeoutMs: number) => reloadTabAndWait(tabId, timeoutMs),
      },
      script: { execute: (request: ScriptRequestDto) => executeScript(tabId, request) },
    } : {}),
    session: {
      listCookies: async (filter) => (await chrome.cookies.getAll(filter ?? {})).map(cookieFromChrome),
      removeCookie: async (url, name) => { await assertRuntimeTarget(url); await chrome.cookies.remove({ url, name }); },
      setCookie: async (details) => {
        await assertRuntimeTarget(details.url);
        await chrome.cookies.set({
          ...details,
          sameSite: details.sameSite as chrome.cookies.SameSiteStatus | undefined,
        });
      },
    },
  };
}
