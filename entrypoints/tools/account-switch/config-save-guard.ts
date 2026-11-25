import type { AccountSwitchConfig } from "./types";

/**
 * 配置页加载失败（例如存储不可读）时，
 * 响应式表单停在空集合上。此时任何保存补丁都会把空 accounts/domains 写回，
 * 造成静默数据丢失。
 *
 * 保存入口统一经过此守卫：只有成功加载过配置才允许生成写请求。
 */
export function guardConfigSavePatch(
  loadError: string,
  patch: Partial<AccountSwitchConfig>,
): Partial<AccountSwitchConfig> | null {
  return loadError ? null : patch;
}
