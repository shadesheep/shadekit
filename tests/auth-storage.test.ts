import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterAuthStorageKeys,
  readAuthStorageKeysInPage,
  scanAuthStorage,
  DEFAULT_AUTH_STORAGE_SELECTION,
} from "../entrypoints/tools/account-switch/strategies/auth-storage";

describe("filterAuthStorageKeys", () => {
  it("精确识别 token 核心键及下划线、大小写变体", () => {
    const keys = [
      "token",
      "TOKEN",
      "accessToken",
      "access_token",
      "Access_Token",
      "refreshToken",
      "refresh_token",
      "idToken",
      "id_token",
      "authToken",
      "auth_token",
      "sessionToken",
      "access-token",
      "jwt",
      "Authorization",
    ];

    expect(filterAuthStorageKeys(keys)).toEqual(keys);
  });

  it("不以宽泛用户、界面或缓存片段猜测认证键", () => {
    expect(
      filterAuthStorageKeys([
        "user",
        "profile",
        "userProfile",
        "theme",
        "themeMode",
        "cache",
        "draft",
        "tokenCache",
        "accessTokenDraft",
        "auth",
        "session",
      ]),
    ).toEqual([]);
  });

  it("只有存在 token 核心键时才附带 expireAt、userInfo 等关联键", () => {
    const related = [
      "expireAt",
      "expires_at",
      "expireTime",
      "expiration",
      "expiresIn",
      "userInfo",
      "user_info",
      "tokenType",
    ];
    expect(filterAuthStorageKeys(related)).toEqual([]);
    expect(
      filterAuthStorageKeys(["refreshToken", ...related, "user", "profile"]),
    ).toEqual(["refreshToken", ...related]);
  });
});

describe("readAuthStorageKeysInPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只返回 Object.keys 的键名，不调用 getItem 或带走存储值", () => {
    const localGetItem = vi.fn(() => {
      throw new Error("不得读取 localStorage 值");
    });
    const sessionGetItem = vi.fn(() => {
      throw new Error("不得读取 sessionStorage 值");
    });
    const local = {
      token: "local-secret",
      userInfo: "private-profile",
      theme: "dark",
    };
    const session = {
      sessionToken: "session-secret",
      access_token: "session-secret",
    };
    Object.defineProperty(local, "getItem", { value: localGetItem });
    Object.defineProperty(session, "getItem", { value: sessionGetItem });
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);

    expect(readAuthStorageKeysInPage()).toEqual({
      local: ["token", "userInfo", "theme"],
      session: ["sessionToken", "access_token"],
    });
    expect(localGetItem).not.toHaveBeenCalled();
    expect(sessionGetItem).not.toHaveBeenCalled();
  });
});

describe("scanAuthStorage", () => {
  const executeScript = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", { scripting: { executeScript } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("分别筛选 local/session，并仅让同一存储中的 token 门控关联键", async () => {
    executeScript.mockResolvedValue([
      {
        frameId: 0,
        result: {
          local: ["expireAt", "userInfo", "theme"],
          session: ["id_token", "expireAt", "userInfo", "profile"],
        },
      },
    ]);

    await expect(scanAuthStorage(9)).resolves.toEqual({
      local: DEFAULT_AUTH_STORAGE_SELECTION.local,
      session: [...DEFAULT_AUTH_STORAGE_SELECTION.session, "expireAt", "userInfo"],
    });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 9 },
      world: "MAIN",
      func: readAuthStorageKeysInPage,
    });
  });

  it("主 frame 无结果或注入失败时仍提供默认认证键", async () => {
    executeScript.mockResolvedValueOnce([]);
    await expect(scanAuthStorage(9)).resolves.toEqual(DEFAULT_AUTH_STORAGE_SELECTION);

    executeScript.mockRejectedValueOnce(new Error("Cannot access storage"));
    await expect(scanAuthStorage(9)).resolves.toEqual(DEFAULT_AUTH_STORAGE_SELECTION);
  });
});
