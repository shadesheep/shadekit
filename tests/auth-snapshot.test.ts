/**
 * auth-snapshot — 认证态捕获 / 清除 / 恢复（ADR-0012 D6 / D7 / D8）
 *
 * 覆盖：三种存储区的读写、cookie 属性保留、三态语义、
 * 错误 origin 上写 storage 报 INJECT_AUTH_FAILED、管线顺序断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAll = vi.fn();
const setCookie = vi.fn();
const removeCookie = vi.fn();
const tabsGet = vi.fn();
const executeScript = vi.fn();

vi.stubGlobal('chrome', {
  cookies: { getAll, set: setCookie, remove: removeCookie },
  tabs: { get: tabsGet },
  scripting: { executeScript },
});

import {
  captureAuth,
  clearAuth,
  normalizeSnapshotSpec,
  restoreAuth,
} from '../entrypoints/tools/account-switch/utils/auth-snapshot';
import { ErrorCodes } from '../entrypoints/tools/account-switch/utils/error-codes';

type Cookie = Record<string, unknown>;

function cookie(partial: Cookie = {}): Cookie {
  return {
    name: 'auth',
    value: 'v1',
    domain: 'example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: false,
    expirationDate: 1893456000,
    hostOnly: false,
    ...partial,
  };
}

/** 内存 storage fake：executeScript 的 func 直接在 fake store 上跑 */
function installStorage(stores: {
  local?: Record<string, string>;
  session?: Record<string, string>;
}) {
  const local = { ...(stores.local ?? {}) };
  const session = { ...(stores.session ?? {}) };
  executeScript.mockImplementation(
    async (injection: {
      func: (...args: never[]) => unknown;
      args?: unknown[];
    }) => {
      const [area, keys] = (injection.args ?? []) as [
        string | undefined,
        string[] | null | undefined,
      ];
      const store = area === "session" ? session : local;
      // 模拟页面内执行：把 store 挂到全局后调用 func
      const merged = { ...store };
      for (const key of Object.keys(merged)) {
        (globalThis as Record<string, unknown>)[key] = merged[key];
      }
      // 真实 Storage 的 Object.keys() 返回已存键；用 Proxy 还原这一语义
      const fakeStorage = (data: Record<string, string>) => {
        const methods = {
          getItem: (k: string) => (k in data ? data[k] : null),
          setItem: (k: string, v: string) => {
            data[k] = v;
          },
          removeItem: (k: string) => {
            delete data[k];
          },
          clear: () => {
            for (const k of Object.keys(data)) delete data[k];
          },
          key: (i: number) => Object.keys(data)[i] ?? null,
        };
        return new Proxy(methods as Record<string | symbol, unknown>, {
          get(target, prop) {
            if (prop in target) return target[prop];
            if (prop in data) return data[prop as string];
            if (prop === "length") return Object.keys(data).length;
            return undefined;
          },
          ownKeys: () => Object.keys(data),
          getOwnPropertyDescriptor: (_t, prop) =>
            prop in data
              ? { enumerable: true, configurable: true, value: data[prop as string] }
              : undefined,
        });
      };
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: fakeStorage(local),
      });
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: fakeStorage(session),
      });
      void keys;
      return [
        {
          frameId: 0,
          result: (injection.func as (...a: unknown[]) => unknown)(
            ...((injection.args ?? []) as unknown[]),
          ),
        },
      ];
    },
  );
  return { local, session };
}

beforeEach(() => {
  getAll.mockReset();
  setCookie.mockReset();
  removeCookie.mockReset();
  tabsGet.mockReset();
  executeScript.mockReset();
  getAll.mockResolvedValue([]);
  setCookie.mockResolvedValue(undefined);
  removeCookie.mockResolvedValue({});
  tabsGet.mockResolvedValue({ url: 'https://example.com/login' });
});

describe('normalizeSnapshotSpec', () => {
  it('page 模式返回 null（不做任何写入）', () => {
    expect(normalizeSnapshotSpec({ mode: 'page' })).toBeNull();
  });

  it('snapshot 缺省：cookie 不清不取、cookiesClear=all、storage 不清', () => {
    expect(normalizeSnapshotSpec({ mode: 'snapshot' })).toEqual({
      cookies: 'none',
      cookiesClear: 'all',
      localStorage: 'none',
      sessionStorage: 'none',
    });
  });

  it('snapshot 显式三态原样保留', () => {
    expect(
      normalizeSnapshotSpec({
        mode: 'snapshot',
        cookies: ['auth'],
        cookiesClear: 'none',
        localStorage: 'all',
        sessionStorage: ['sid'],
      }),
    ).toEqual({
      cookies: ['auth'],
      cookiesClear: 'none',
      localStorage: 'all',
      sessionStorage: ['sid'],
    });
  });
});

describe('captureAuth', () => {
  it('按白名单读取 cookie（保留属性），storage 按 all / 白名单读取', async () => {
    getAll.mockResolvedValue([cookie()]);
    installStorage({ local: { token: 't1', other: 'x' }, session: { sid: 's1' } });

    const snapshot = await captureAuth('https://example.com', 7, {
      mode: 'snapshot',
      cookies: ['auth'],
      localStorage: 'all',
      sessionStorage: ['sid'],
    });

    expect(snapshot.cookies).toHaveLength(1);
    expect(snapshot.cookies[0]).toMatchObject({
      name: 'auth',
      domain: 'example.com',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 1893456000,
    });
    expect(snapshot.localStorage).toEqual({ token: 't1', other: 'x' });
    expect(snapshot.sessionStorage).toEqual({ sid: 's1' });
  });

  it('page 模式不读任何东西', async () => {
    const snapshot = await captureAuth('https://example.com', 7, {
      mode: 'page',
    });
    expect(snapshot.cookies).toEqual([]);
    expect(snapshot.localStorage).toBeUndefined();
    expect(executeScript).not.toHaveBeenCalled();
    expect(getAll).not.toHaveBeenCalled();
  });
});

describe('restoreAuth', () => {
  it('恢复 cookie 时保留 domain / path / secure / httpOnly / sameSite / 过期时间', async () => {
    await restoreAuth(
      'https://example.com',
      7,
      { mode: 'snapshot', cookies: 'all' },
      { cookies: [cookie()] as unknown as chrome.cookies.Cookie[] },
    );

    expect(setCookie).toHaveBeenCalledOnce();
    const details = setCookie.mock.calls[0][0] as Record<string, unknown>;
    expect(details).toMatchObject({
      name: 'auth',
      value: 'v1',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 1893456000,
    });
    expect(String(details.url)).toBe('https://example.com/');
  });

  it('session cookie 不写 expirationDate', async () => {
    await restoreAuth(
      'https://example.com',
      7,
      { mode: 'snapshot', cookies: 'all' },
      {
        cookies: [
          cookie({ session: true, expirationDate: undefined }),
        ] as unknown as chrome.cookies.Cookie[],
      },
    );
    const details = setCookie.mock.calls[0][0] as Record<string, unknown>;
    expect('expirationDate' in details).toBe(false);
  });

  it('恢复 storage 写在目标 origin 的文档内', async () => {
    const { local } = installStorage({ local: {} });
    await restoreAuth(
      'https://example.com',
      7,
      { mode: 'snapshot', localStorage: 'all' },
      { cookies: [], localStorage: { token: 't1' } },
    );
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(local).toEqual({ token: 't1' });
  });

  it('tab 不在目标 origin → INJECT_AUTH_FAILED（绝不静默成功）', async () => {
    installStorage({ local: {} });
    tabsGet.mockResolvedValue({ url: 'https://login.other.com/sso' });

    await expect(
      restoreAuth(
        'https://example.com',
        7,
        { mode: 'snapshot', localStorage: 'all' },
        { cookies: [], localStorage: { token: 't1' } },
      ),
    ).rejects.toMatchObject({
      code: ErrorCodes.INJECT_AUTH_FAILED,
    });
    // 报错信息说明「origin 作用域」的原因
    await expect(
      restoreAuth(
        'https://example.com',
        7,
        { mode: 'snapshot', localStorage: 'all' },
        { cookies: [], localStorage: { token: 't1' } },
      ),
    ).rejects.toThrow(/origin|l边|目标站点/i);
  });
});

describe('clearAuth', () => {
  it('cookiesClear=all 只清精确 host（不含父域）', async () => {
    getAll.mockResolvedValue([
      cookie({ name: 'a', domain: 'www.example.com' }),
      cookie({ name: 'p', domain: '.example.com' }),
      cookie({ name: 'other', domain: 'other.com' }),
    ]);
    await clearAuth('https://www.example.com', 7, {
      mode: 'snapshot',
      cookies: 'none',
      cookiesClear: 'all',
    });
    const removed = removeCookie.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(removed).toContain('a');
    expect(removed).not.toContain('p');
    expect(removed).not.toContain('other');
  });

  it('cookiesClear 白名单只删指定名称', async () => {
    getAll.mockResolvedValue([
      cookie({ name: 'auth', domain: 'example.com' }),
      cookie({ name: 'theme', domain: 'example.com' }),
    ]);
    await clearAuth('https://example.com', 7, {
      mode: 'snapshot',
      cookiesClear: ['auth'],
    });
    expect(removeCookie).toHaveBeenCalledOnce();
    expect(
      (removeCookie.mock.calls[0][0] as { name: string }).name,
    ).toBe('auth');
  });

  it('cookiesClear=none 不清 cookie', async () => {
    await clearAuth('https://example.com', 7, {
      mode: 'snapshot',
      cookiesClear: 'none',
    });
    expect(getAll).not.toHaveBeenCalled();
    expect(removeCookie).not.toHaveBeenCalled();
  });

  it('localStorage = all 时清空该文档全部键', async () => {
    const { local } = installStorage({ local: { a: '1', b: '2' } });
    await clearAuth('https://example.com', 7, {
      mode: 'snapshot',
      cookiesClear: 'none',
      localStorage: 'all',
    });
    expect(local).toEqual({});
  });

  it('localStorage 白名单只删指定键，sessionStorage 不受影响', async () => {
    const { local, session } = installStorage({
      local: { token: '1', keep: '2' },
      session: { sid: '3' },
    });
    await clearAuth('https://example.com', 7, {
      mode: 'snapshot',
      cookiesClear: 'none',
      localStorage: ['token'],
    });
    expect(local).toEqual({ keep: '2' });
    expect(session).toEqual({ sid: '3' });
  });

  it('storage 清理同样校验 origin', async () => {
    installStorage({ local: { a: '1' } });
    tabsGet.mockResolvedValue({ url: 'https://wrong.example.net/' });
    await expect(
      clearAuth('https://example.com', 7, {
        mode: 'snapshot',
        cookiesClear: 'none',
        sessionStorage: 'all',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INJECT_AUTH_FAILED });
  });
});
