/**
 * 本域 Cookie / storage 清理（ADR-0012 D8）
 *
 * 覆盖：精确 host、含父域、白名单、不清 四种情形，以及无关 host 不受影响。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StubCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
  sameSite: string;
  session: boolean;
};

const getAll = vi.fn();
const remove = vi.fn();

vi.stubGlobal('chrome', {
  cookies: { getAll, remove },
  scripting: { executeScript: vi.fn() },
});

const {
  clearHostCookies,
  captureHostCookies,
  cookieBelongsToHost,
  getParentDomain,
} = await import('../entrypoints/tools/account-switch/utils/host-cookies');

function cookie(partial: Partial<StubCookie> & { name: string; domain: string }): StubCookie {
  return {
    value: 'v',
    path: '/',
    secure: false,
    hostOnly: !partial.domain.startsWith('.'),
    sameSite: 'lax',
    session: true,
    ...partial,
  };
}

/**
 * 模拟 chrome.cookies.getAll({}) 的真实语义：返回全量 cookie，**不按 path 过滤**。
 * （`{ url }` 过滤只返回对给定路径生效的 cookie——不少站点把会话 cookie 挂在
 * 子路径上，正是因此被漏清。）
 */
const STORE: StubCookie[] = [
  cookie({ name: 'host-only', domain: 'www.example.com' }),
  cookie({ name: 'exact-domain', domain: 'www.example.com' }),
  cookie({ name: 'parent', domain: '.example.com' }),
  cookie({ name: 'root', domain: '.example.com', path: '/login' }),
  cookie({ name: 'other', domain: 'other.com' }),
];

beforeEach(() => {
  getAll.mockReset();
  remove.mockReset();
  remove.mockResolvedValue({});
  getAll.mockImplementation(async () => [...STORE]);
});

describe('cookieBelongsToHost / getParentDomain', () => {
  it('domain 写法带前导点也能识别为同一 host', () => {
    expect(cookieBelongsToHost({ domain: 'example.com' }, 'example.com')).toBe(true);
    expect(cookieBelongsToHost({ domain: '.example.com' }, 'example.com')).toBe(true);
    expect(cookieBelongsToHost({ domain: '.example.com' }, 'www.example.com')).toBe(false);
  });

  it('父域取末两段', () => {
    expect(getParentDomain('www.example.com')).toBe('example.com');
    expect(getParentDomain('example.com')).toBe('example.com');
    expect(getParentDomain('localhost')).toBe('localhost');
  });
});

describe('clearHostCookies — 四种情形', () => {
  it('默认「全部（仅精确 host）」：清 host-only 与精确 domain，不碰父域', async () => {
    await clearHostCookies('https://www.example.com');

    const removed = remove.mock.calls.map((c) => c[0].name);
    expect(removed).toEqual(['host-only', 'exact-domain']);
    expect(removed).not.toContain('parent');
  });

  it('含父域：额外清除父域 cookie（UI 需明示风险）', async () => {
    await clearHostCookies('https://www.example.com', { includeParent: true });

    const removed = remove.mock.calls.map((c) => c[0].name);
    expect(removed).toEqual(['host-only', 'exact-domain', 'parent', 'root']);
  });

  it('白名单：只删指定名称', async () => {
    await clearHostCookies('https://www.example.com', {
      names: ['exact-domain'],
    });

    expect(remove.mock.calls.map((c) => c[0].name)).toEqual(['exact-domain']);
  });

  it('「不清」：空名单表示一个都不删', async () => {
    const count = await clearHostCookies('https://www.example.com', { names: [] });

    expect(count).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });

  it('子路径下的 cookie 也会被清除（挂在 /admin/ 的会话 cookie）', async () => {
    // 回归：之前用 { url: origin } 枚举，只返回对 path=/ 生效的 cookie，
    // 子路径里的会话 cookie 永远清不掉 → 旧会话自动登录 → 配方找不到输入框。
    getAll.mockResolvedValueOnce([
      cookie({ name: 'sid', domain: 'www.example.com', path: '/' }),
      cookie({ name: 'keepLogin', domain: 'www.example.com', path: '/admin/' }),
      cookie({ name: 'token', domain: 'www.example.com', path: '/admin/' }),
    ]);

    const count = await clearHostCookies('https://www.example.com');

    expect(count).toBe(3);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([
      { url: 'http://www.example.com/', name: 'sid' },
      { url: 'http://www.example.com/admin/', name: 'keepLogin' },
      { url: 'http://www.example.com/admin/', name: 'token' },
    ]);
    // 枚举不能按 url（会被 path 过滤）
    expect(getAll).toHaveBeenCalledWith({});
  });

  it('无关 host 不受影响', async () => {
    await clearHostCookies('https://www.example.com', { includeParent: true });

    const removed = remove.mock.calls.map((c) => c[0].name);
    expect(removed).not.toContain('other');
  });

  it('删除时按 cookie 自身 domain/path/secure 构造 URL', async () => {
    getAll.mockResolvedValueOnce([
      cookie({ name: 'deep', domain: '.example.com', path: '/login', secure: true }),
    ]);
    await clearHostCookies('https://www.example.com', { includeParent: true });

    expect(remove).toHaveBeenCalledWith({
      url: 'https://example.com/login',
      name: 'deep',
    });
  });

  it('返回实际删除数量', async () => {
    const count = await clearHostCookies('https://www.example.com', {
      includeParent: true,
    });
    expect(count).toBe(4);
  });

  it('origin 无法解析 → INVALID_URL', async () => {
    await expect(clearHostCookies('not a url')).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
  });
});

describe('captureHostCookies', () => {
  it('缺省捕获全部，保留 cookie 属性', async () => {
    const cookies = await captureHostCookies('https://www.example.com');
    expect(cookies.map((c) => c.name)).toEqual([
      'host-only',
      'exact-domain',
      'parent',
      'root',
    ]);
    expect(cookies[0]).toMatchObject({
      domain: 'www.example.com',
      path: '/',
      secure: false,
      sameSite: 'lax',
    });
  });

  it('白名单只捕获指定名称', async () => {
    const cookies = await captureHostCookies('https://www.example.com', ['parent']);
    expect(cookies.map((c) => c.name)).toEqual(['parent']);
  });
});
