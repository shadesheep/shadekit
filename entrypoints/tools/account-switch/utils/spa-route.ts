/**
 * SPA 路由监听
 *
 * 监听四类路由变化，URL 实际变化时触发回调：
 * - 拦截 history.pushState / history.replaceState（同 world 调用即时感知）
 * - 监听 popstate / hashchange 事件（跨 world 可靠）
 * - 低频轮询 location.href 兜底：content script 运行在隔离 world，
 *   页面主 world 的 pushState 调用无法被隔离 world 的补丁拦截，
 *   轮询保证任何 SPA 框架的路由切换最终都会被发现（≤1 个轮询周期延迟）
 * - 后台标签页（document.hidden）暂停轮询，切回前台时立即补一次检查，
 *   避免空转也不漏掉后台期间的路由变化
 *
 * stop() 恢复原始方法、移除事件监听、清除定时器，无泄漏。
 * 通过 lastUrl 去重：同一次路由变化多通道触发时回调只执行一次。
 */

/** 轮询兜底间隔（ms） */
export const ROUTE_POLL_INTERVAL = 1000;

/** 最小 window 结构（便于测试注入 fake） */
export interface WindowLike {
  history: {
    pushState: History['pushState'];
    replaceState: History['replaceState'];
  };
  location: { href: string };
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface SpaRouteWatcher {
  /** 停止监听：恢复 history 方法、移除事件监听、清除轮询。幂等。 */
  stop(): void;
}

/**
 * 开始监听 SPA 路由变化。
 *
 * @param win 目标 window（测试可注入 fake）
 * @param onRouteChange URL 变化后的回调，参数为新 href
 * @param pollInterval 轮询兜底间隔，默认 {@link ROUTE_POLL_INTERVAL}
 */
export function watchSpaRoutes(
  win: WindowLike,
  onRouteChange: (url: string) => void,
  pollInterval: number = ROUTE_POLL_INTERVAL,
): SpaRouteWatcher {
  let lastUrl = win.location.href;
  let stopped = false;

  const notifyIfChanged = () => {
    if (stopped) return;
    const url = win.location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    onRouteChange(url);
  };

  const history = win.history;
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  history.pushState = function (
    this: unknown,
    ...args: Parameters<History['pushState']>
  ) {
    origPushState.apply(this, args);
    notifyIfChanged();
  } as History['pushState'];
  history.replaceState = function (
    this: unknown,
    ...args: Parameters<History['replaceState']>
  ) {
    origReplaceState.apply(this, args);
    notifyIfChanged();
  } as History['replaceState'];

  win.addEventListener('popstate', notifyIfChanged);
  win.addEventListener('hashchange', notifyIfChanged);

  // 后台标签页暂停轮询（测试环境无 document，守卫跳过）
  const isPageHidden = () =>
    typeof document !== 'undefined' && document.hidden;

  const timer = setInterval(() => {
    if (isPageHidden()) return;
    notifyIfChanged();
  }, pollInterval);

  // 切回前台时立即补一次检查
  const onVisibilityChange = () => {
    if (!isPageHidden()) notifyIfChanged();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      history.pushState = origPushState;
      history.replaceState = origReplaceState;
      win.removeEventListener('popstate', notifyIfChanged);
      win.removeEventListener('hashchange', notifyIfChanged);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      clearInterval(timer);
    },
  };
}
