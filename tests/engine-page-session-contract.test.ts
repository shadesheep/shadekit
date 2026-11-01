import { describe, expect, it, vi } from "vitest";
import { runDomAction } from "../entrypoints/tools/account-switch/page-agent";
import { runAuthCapture, runAuthRestore } from "../entrypoints/tools/account-switch/runtime";
import { runClearCookies } from "../entrypoints/tools/account-switch/runtime";
import type { CookieRecord, HostBridge, PagePort, SessionPort } from "../entrypoints/tools/account-switch/runtime";

const cookie: CookieRecord = {
  name: "sid", value: "COOKIE-UNIQUE-33", domain: ".app.test", path: "/login",
  secure: true, httpOnly: true, sameSite: "lax", expirationDate: 2000, session: false, hostOnly: false,
};

function sessionDouble(cookies: CookieRecord[] = []) {
  return {
    listCookies: vi.fn(async () => cookies),
    removeCookie: vi.fn(async () => undefined),
    setCookie: vi.fn(async () => undefined),
  } satisfies SessionPort;
}

function hostWith(page: PagePort, session: SessionPort): HostBridge {
  return {
    page,
    session,
    http: { execute: vi.fn() },
    capabilities: () => ({ specVersions: [2], ops: [], page: true, session: true, script: false }),
  };
}

describe("共享 page-agent frame 归并", () => {
  it("多个匹配 frame 返回 AMBIGUOUS_TARGET，不选择第一个", async () => {
    const page: PagePort = {
      execute: vi.fn(async () => [
        { frameId: 0, result: { status: "ok", count: 1 } },
        { frameId: 2, result: { status: "ok", count: 1 } },
      ]),
      currentUrl: async () => "https://app.test/login",
      navigate: vi.fn(), waitForLoad: vi.fn(), reload: vi.fn(),
    };
    const result = await runDomAction(page, { action: "click", target: "#submit" });
    expect(result).toMatchObject({ status: "ambiguous", count: 2 });
  });

  it("已记录 frame 消失时明确返回 frameMissing", async () => {
    const page: PagePort = {
      execute: vi.fn(async () => [{ frameId: 0, result: { status: "notFound", count: 0 } }]),
      currentUrl: async () => "https://app.test/login",
      navigate: vi.fn(), waitForLoad: vi.fn(), reload: vi.fn(),
    };
    const result = await runDomAction(page, { action: "click", target: "#submit" }, { frameId: 7 });
    expect(result.status).toBe("frameMissing");
  });
});

describe("共享会话 DTO 与快照", () => {
  it("按 host 语义清理 Cookie，保留无关 host", async () => {
    const session = sessionDouble([
      cookie,
      { ...cookie, name: "other", domain: ".other.test" },
    ]);
    await runClearCookies(session, "https://app.test", { range: ["sid"], includeParent: true });
    expect(session.removeCookie).toHaveBeenCalledOnce();
    expect(session.removeCookie).toHaveBeenCalledWith("https://app.test/login", "sid");
  });

  it("捕获保留 Cookie 属性和声明的 Storage 范围", async () => {
    const session = sessionDouble([cookie]);
    const page: PagePort = {
      execute: vi.fn(async (command) => [{
        frameId: 0,
        result: command.action === "storage.read" && command.area === "local" ? { token: "STORAGE-UNIQUE-44" } : {},
      }]),
      currentUrl: async () => "https://app.test/login",
      navigate: vi.fn(), waitForLoad: vi.fn(), reload: vi.fn(),
    };
    const host = hostWith(page, session);
    const snapshot = await runAuthCapture(host, "https://app.test", {
      op: "auth.capture", as: "snap", cookies: "all", localStorage: ["token"], sessionStorage: "none",
    });
    expect(snapshot.cookies).toEqual([cookie]);
    expect(snapshot.localStorage).toEqual({ token: "STORAGE-UNIQUE-44" });
    expect(snapshot).not.toHaveProperty("sessionStorage");
  });

  it("恢复前 origin 变化时没有任何会话写入", async () => {
    const session = sessionDouble([cookie]);
    const page: PagePort = {
      execute: vi.fn(), currentUrl: async () => "https://evil.test/",
      navigate: vi.fn(), waitForLoad: vi.fn(), reload: vi.fn(),
    };
    const host = hostWith(page, session);
    await expect(runAuthRestore(host, {
      origin: "https://app.test", cookies: [cookie], localStorage: { token: "STORAGE-UNIQUE-44" },
    })).rejects.toMatchObject({ code: "INJECT_AUTH_FAILED" });
    expect(session.setCookie).not.toHaveBeenCalled();
    expect(session.removeCookie).not.toHaveBeenCalled();
    expect(page.execute).not.toHaveBeenCalled();
  });
});
