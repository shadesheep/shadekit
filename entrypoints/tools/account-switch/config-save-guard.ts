import type { AccountSwitchConfig } from "./types";

/**
 * 配置页加载失败（例如旧主密码/未知保险库元数据返回 VAULT_UNAVAILABLE）时，
 * 响应式表单停在空集合上。此时任何保存补丁都会把空 accounts/domains 写回，
 * 随后的孤儿清理还会删除仍被引用的密文 —— 造成静默数据丢失。
 *
 * 保存入口统一经过此守卫：只有成功加载过配置才允许生成写请求。
 */
export function guardConfigSavePatch(
  loadError: string,
  patch: Partial<AccountSwitchConfig>,
): Partial<AccountSwitchConfig> | null {
  return loadError ? null : patch;
}
