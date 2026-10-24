/**
 * 开发者模式管理模块
 *
 * 提供开发者模式的开关状态管理和点击计数逻辑。
 * 通过 Options 页面 Logo 连续点击 5 次（2秒内）触发。
 *
 * 状态通过 chrome.storage.local 持久化，并通过事件总线通知所有订阅者。
 * 任何组件都可以通过 onDevModeChange() 订阅状态变化。
 */

import { safeStorageSet } from "./safe-storage";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEV_MODE_KEY = "devtools-dev-mode";
const CLICK_THRESHOLD = 5; // 触发所需点击次数
const CLICK_TIMEOUT = 2000; // 点击超时时间（毫秒）

// ---------------------------------------------------------------------------
// 事件总线
// ---------------------------------------------------------------------------

type DevModeCallback = (enabled: boolean) => void;
const listeners = new Set<DevModeCallback>();

/**
 * 订阅开发者模式状态变化
 *
 * @param callback 状态变化时的回调函数
 * @returns 取消订阅的函数
 *
 * @example
 * const unsubscribe = onDevModeChange((enabled) => {
 *   console.log('开发者模式:', enabled ? '已开启' : '已关闭');
 * });
 * // 稍后取消订阅
 * unsubscribe();
 */
export function onDevModeChange(callback: DevModeCallback): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * 通知所有订阅者状态已变化
 * 内部使用，外部通常不需要直接调用
 */
export function emitDevModeChanged(enabled: boolean): void {
  for (const cb of listeners) {
    try {
      cb(enabled);
    } catch (e) {
      console.error("[dev-mode] 事件回调执行失败:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// 状态管理
// ---------------------------------------------------------------------------

/**
 * 获取开发者模式是否启用
 * 默认为 false（未设置时）
 */
export async function isDevModeEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get([DEV_MODE_KEY]);
  // 只有明确设置为 true 时才返回 true
  return result[DEV_MODE_KEY] === true;
}

/**
 * 设置开发者模式状态，并通知所有订阅者
 * @returns 是否写入成功；失败时不通知订阅者（状态未真正变更）
 */
export async function setDevModeEnabled(enabled: boolean): Promise<boolean> {
  const result = await safeStorageSet({ [DEV_MODE_KEY]: enabled });
  if (!result.ok) return false;
  emitDevModeChanged(enabled);
  return true;
}

/**
 * 切换开发者模式状态
 * @returns 切换后的新状态；写入失败时状态未变更，返回当前状态
 */
export async function toggleDevMode(): Promise<boolean> {
  const current = await isDevModeEnabled();
  const newState = !current;
  const ok = await setDevModeEnabled(newState);
  return ok ? newState : current;
}

// ---------------------------------------------------------------------------
// 点击计数器
// ---------------------------------------------------------------------------

/**
 * 开发者模式点击计数器
 *
 * 用于检测用户在短时间内连续点击 Logo 的行为。
 * 在组件中创建实例，每次点击调用 recordClick()。
 *
 * @example
 * const counter = new DevModeClickCounter();
 * img.addEventListener('click', async () => {
 *   if (await counter.recordClick()) {
 *     // 已达到阈值，开启开发者模式
 *     showToast('开发者模式已开启');
 *   }
 * });
 */
export class DevModeClickCounter {
  private clicks: number[] = [];

  /**
   * 记录一次点击
   * @returns 是否达到阈值并开启了开发者模式
   */
  async recordClick(): Promise<boolean> {
    const now = Date.now();

    // 清理过期点击（超过 CLICK_TIMEOUT 的）
    this.clicks = this.clicks.filter((t) => now - t < CLICK_TIMEOUT);

    // 添加当前点击
    this.clicks.push(now);

    // 检查是否达到阈值
    if (this.clicks.length >= CLICK_THRESHOLD) {
      // 检查当前是否已经是开发者模式
      const alreadyEnabled = await isDevModeEnabled();
      if (alreadyEnabled) {
        // 已经是开发者模式，则关闭
        await setDevModeEnabled(false);
        this.reset();
        return false; // 返回 false 表示关闭了开发者模式
      } else {
        // 开启开发者模式
        await setDevModeEnabled(true);
        this.reset();
        return true; // 返回 true 表示开启了开发者模式
      }
    }

    return false;
  }

  /**
   * 获取当前点击次数（仅计算未过期的）
   */
  getClickCount(): number {
    const now = Date.now();
    this.clicks = this.clicks.filter((t) => now - t < CLICK_TIMEOUT);
    return this.clicks.length;
  }

  /**
   * 重置计数器
   */
  reset(): void {
    this.clicks = [];
  }

  /**
   * 获取距离触发还需要的点击次数
   */
  getRemainingClicks(): number {
    return Math.max(0, CLICK_THRESHOLD - this.getClickCount());
  }
}

// ---------------------------------------------------------------------------
// 常量导出（供外部使用）
// ---------------------------------------------------------------------------

export const DEV_MODE_CONFIG = {
  CLICK_THRESHOLD,
  CLICK_TIMEOUT,
} as const;
