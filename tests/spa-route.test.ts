/**
 * Issue 14 — SPA 路由监听（环境指示器实时更新；ADR-0017 起并入账号切换配置）
 * ① evaluateEnv：域名命中 / 白名单排除 / 均不匹配 / 无配置（入参为合并后的配置）
 * ② watchSpaRoutes：pushState / replaceState / popstate / hashchange 四类变化均触发回调
 * ③ URL 去重：同一次路由变化多通道触发时回调只执行一次；URL 未变不触发
 * ④ 轮询兜底：隔离 world 下页面主 world 的路由变化（不经过补丁）也能被发现
 * ⑤ stop()：恢复原始 history 方法、移除事件监听、清除轮询，无泄漏；stop 幂等
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateEnv } from '../entrypoints/tools/account-switch/EnvIndicator';
import {
  watchSpaRoutes,
  ROUTE_POLL_INTERVAL,
  type WindowLike,
} from '../entrypoints/tools/account-switch/utils/spa-route';

// ============================================================
// evaluateEnv — 纯函数：配置 + origin → 匹配环境
// ============================================================

describe('evaluateEnv — 环境匹配评估', () => {
  const cfg = {
    domains: {
      'https://*.test-example.com': { name: '测试环境', tags: ['test'] },
      'https://prod.example.com': { name: '生产环境', tags: ['prod'] },
    },
  };

  it('域名命中 → 返回匹配环境', () => {
    const matched = evaluateEnv(cfg, 'https://prod.example.com');
    expect(matched).toEqual({ name: '生产环境', tags: ['prod'] });
  });

  it('通配符域名命中', () => {
    const matched = evaluateEnv(cfg, 'https://dev.test-example.com');
    expect(matched).toEqual({ name: '测试环境', tags: ['test'] });
  });

  it('所有域名均不匹配 → null', () => {
    expect(evaluateEnv(cfg, 'https://other.com')).toBeNull();
  });

  it('白名单非空且当前域名不在白名单 → null（即使环境域名命中）', () => {
    const withWhitelist = {
      ...cfg,
      envBadge: { whitelist: ['https://allowed.example.com'] },
    };
    expect(evaluateEnv(withWhitelist, 'https://prod.example.com')).toBeNull();
  });

  it('白名单命中 → 正常评估', () => {
    const withWhitelist = { ...cfg, envBadge: { whitelist: ['https://*.example.com'] } };
    const matched = evaluateEnv(withWhitelist, 'https://prod.example.com');
    expect(matched).toEqual({ name: '生产环境', tags: ['prod'] });
  });

  it('白名单为空数组 → 不限制', () => {
    const withWhitelist = { ...cfg, envBadge: { whitelist: [] } };
    const matched = evaluateEnv(withWhitelist, 'https://prod.example.com');
    expect(matched).not.toBeNull();
  });

  it('无账号配置 → null', () => {
    expect(evaluateEnv(undefined, 'https://prod.example.com')).toBeNull();
    expect(evaluateEnv({ domains: {} }, 'https://prod.example.com')).toBeNull();
  });
});

// ============================================================
// watchSpaRoutes — SPA 路由变化监听
// ============================================================

/** 构造可注入的 fake window：history 补丁会改变 href，事件可手动派发 */
function createFakeWindow(initialUrl: string) {
  const listeners = new Map<string, Set<() => void>>();
  const win = {
    location: { href: initialUrl },
    history: {
      pushState: (_data: unknown, _unused: string, url?: string | null) => {
        if (url) win.location.href = new URL(url, win.location.href).href;
      },
      replaceState: (_data: unknown, _unused: string, url?: string | null) => {
        if (url) win.location.href = new URL(url, win.location.href).href;
      },
    },
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    /** 测试辅助：派发事件 */
    emit: (type: string) => listeners.get(type)?.forEach((fn) => {
      fn();
    }),
    /** 测试辅助：当前监听数量 */
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
  return win;
}

describe('watchSpaRoutes — 四类路由变化触发', () => {
  let win: ReturnType<typeof createFakeWindow>;
  let onChange: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    win = createFakeWindow('https://a.example.com/page1');
    onChange = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushState 改变 URL → 触发回调', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    win.history.pushState(null, '', '/page2');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('https://a.example.com/page2');
    watcher.stop();
  });

  it('replaceState 改变 URL → 触发回调', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    win.history.replaceState(null, '', '/replaced');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('https://a.example.com/replaced');
    watcher.stop();
  });

  it('popstate 事件（URL 已变化）→ 触发回调', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    win.location.href = 'https://a.example.com/back';
    win.emit('popstate');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('https://a.example.com/back');
    watcher.stop();
  });

  it('hashchange 事件 → 触发回调', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    win.location.href = 'https://a.example.com/page1#section2';
    win.emit('hashchange');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('https://a.example.com/page1#section2');
    watcher.stop();
  });

  it('URL 未变化的 pushState / popstate 不触发回调（去重）', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    win.history.pushState(null, ''); // 无 url 参数，href 不变
    win.emit('popstate'); // href 不变
    expect(onChange).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('同一次变化多通道触发时回调只执行一次', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    win.history.pushState(null, '', '/page2'); // 通道 1：补丁
    win.emit('popstate'); // 通道 2：事件（同一 URL）
    vi.advanceTimersByTime(ROUTE_POLL_INTERVAL); // 通道 3：轮询（同一 URL）
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('轮询兜底：不经过补丁的 URL 变化（页面主 world 路由）也能被发现', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    // 模拟页面主 world 的 pushState：href 变了，但补丁/事件都感知不到
    win.location.href = 'https://a.example.com/main-world-route';
    vi.advanceTimersByTime(ROUTE_POLL_INTERVAL);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('https://a.example.com/main-world-route');
    watcher.stop();
  });

  it('连续多次路由变化 → 每次各触发一次', () => {
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    win.history.pushState(null, '', '/p2');
    win.history.pushState(null, '', '/p3');
    win.location.href = 'https://a.example.com/p4';
    win.emit('popstate');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenNthCalledWith(3, 'https://a.example.com/p4');
    watcher.stop();
  });
});

describe('watchSpaRoutes — stop() 清理无泄漏', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop 后恢复原始 history 方法引用', () => {
    const win = createFakeWindow('https://a.example.com/');
    const origPush = win.history.pushState;
    const origReplace = win.history.replaceState;

    const watcher = watchSpaRoutes(win as unknown as WindowLike, vi.fn<(url: string) => void>());
    expect(win.history.pushState).not.toBe(origPush); // 已被补丁替换

    watcher.stop();
    expect(win.history.pushState).toBe(origPush);
    expect(win.history.replaceState).toBe(origReplace);
  });

  it('stop 后事件监听全部移除', () => {
    const win = createFakeWindow('https://a.example.com/');
    const watcher = watchSpaRoutes(win as unknown as WindowLike, vi.fn<(url: string) => void>());
    expect(win.listenerCount('popstate')).toBe(1);
    expect(win.listenerCount('hashchange')).toBe(1);

    watcher.stop();
    expect(win.listenerCount('popstate')).toBe(0);
    expect(win.listenerCount('hashchange')).toBe(0);
  });

  it('stop 后任何通道都不再触发回调', () => {
    const win = createFakeWindow('https://a.example.com/');
    const onChange = vi.fn<(url: string) => void>();
    const watcher = watchSpaRoutes(win as unknown as WindowLike, onChange);
    watcher.stop();

    win.location.href = 'https://a.example.com/other';
    win.history.pushState(null, '', '/more');
    win.emit('popstate');
    vi.advanceTimersByTime(ROUTE_POLL_INTERVAL * 3);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stop 幂等：重复调用不抛错', () => {
    const win = createFakeWindow('https://a.example.com/');
    const watcher = watchSpaRoutes(win as unknown as WindowLike, vi.fn<(url: string) => void>());
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
  });
});
