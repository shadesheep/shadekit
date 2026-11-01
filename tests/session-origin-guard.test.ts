import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAuthWrite, runAuthRestore } from "../entrypoints/tools/account-switch/runtime";
import { createChromeHostBridge } from "../entrypoints/tools/account-switch/chrome-host";
import { restoreAuth } from "../entrypoints/tools/account-switch/utils/auth-snapshot";
import type { AuthContext } from "../entrypoints/tools/account-switch/types";

const origin = "https://current.example.com";
const cookieSet = vi.fn();
const cookieRemove = vi.fn();

vi.stubGlobal("chrome", {
  permissions: { contains: async () => true, request: async () => true },
  tabs: {
    get: vi.fn(async () => ({ id: 42, url: "https://evil.example.com/" })),
  },
  cookies: {
    set: (...args: unknown[]) => cookieSet(...args),
    remove: (...args: unknown[]) => cookieRemove(...args),
    getAll: vi.fn(async () => []),
  },
  scripting: { executeScript: vi.fn() },
});

function host() {
  const ctx: AuthContext = {
    tabId: 42,
    origin,
    domainConfig: { name: "App", tags: [] },
    credentials: { username: "alice", password: "secret" },
    tokenData: null,
  };
  return createChromeHostBridge(ctx);
}

const snapshot = {
  origin,
  cookies: [{
    name: "session",
    value: "session-secret",
    domain: "current.example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    session: true,
    storeId: "0",
    hostOnly: true,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  cookieSet.mockResolvedValue(null);
  cookieRemove.mockResolvedValue(null);
});

describe("会话原语 origin 防线", () => {
  it("auth.write 即使只写 Cookie 也先检查实际 tab origin", async () => {
    await expect(runAuthWrite(host(), origin, {
      mode: "engine",
      cookiesWrite: [{ name: "session", value: "session-secret" }],
    }, { inputs: {}, bindings: {} })).rejects.toMatchObject({
      code: "INJECT_AUTH_FAILED",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("auth.restore 在 Cookie 清理和写回前检查快照 origin", async () => {
    await expect(runAuthRestore(host(), snapshot)).rejects.toMatchObject({
      code: "INJECT_AUTH_FAILED",
    });
    expect(cookieSet).not.toHaveBeenCalled();
    expect(cookieRemove).not.toHaveBeenCalled();
  });

  it("尾部 restoreAuth 也不能在错误 origin 先写 Cookie", async () => {
    await expect(restoreAuth(origin, 42, {
      mode: "snapshot",
      cookies: "all",
    }, snapshot)).rejects.toMatchObject({ code: "INJECT_AUTH_FAILED" });
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
