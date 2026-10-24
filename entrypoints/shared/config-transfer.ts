/**
 * 「全部工具设置」整包导入导出（选项页专用）
 *
 * 独立于 tool-config.ts，是因为本模块需要 import 工具注册表
 * （tool-definitions.ts 里全是 Vue 组件的动态 import）。tool-config 被
 * content script 引用，把注册表拉进去会让单文件构建变成 code-splitting
 * 而失败——故整包能力收在这里，只有 options 页 import。
 *
 * 载荷按**注册表白名单**构造，而非 `devtools-` 前缀（对齐 ADR-0016 D1）：
 * 存储里还有大量以 `devtools-` 开头的非配置数据——统一日志（`devtools-logs`，
 * 含请求/响应轨迹）、迁移标记、已删子系统的残留键。前缀匹配会把它们当作
 * 配置导出，导入时还会回灌。白名单方向保证未来新增任何非配置 key
 * （缓存 / 锁 / 计数器）自动免疫。
 */

import { allTools } from './tool-definitions';
import { CONFIG_VERSION, keyFor } from './tool-config';
import { safeStorageSet } from './safe-storage';

const STORAGE_PREFIX = 'devtools-';

/**
 * 跨工具共享的配置 id（不属于任何单个工具，但属于「全部工具设置」）。
 * `state` = 工具开关，`theme` = 主题偏好。
 */
const SHARED_CONFIG_IDS = ['state', 'theme'] as const;

/** 配置 id 是否属于「全部工具设置」白名单 */
export function isExportableConfigId(id: string): boolean {
  return (
    (SHARED_CONFIG_IDS as readonly string[]).includes(id) ||
    allTools.some((t) => t.id === id)
  );
}

/**
 * 导出全部工具设置：只收白名单内的 key ——
 * 各注册工具的配置 + `state` + `theme`，外加用于识别 schema 的 `__version`。
 */
export async function getAllConfig(): Promise<Record<string, unknown>> {
  const result = await chrome.storage.local.get(null);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (!k.startsWith(STORAGE_PREFIX)) continue;
    const id = k.slice(STORAGE_PREFIX.length);
    if (!isExportableConfigId(id)) continue;
    out[id] = v;
  }
  // 附加版本信息，便于导出时识别 schema
  out.__version = CONFIG_VERSION;
  return out;
}

/**
 * 批量写入全部工具配置（导入场景）：按白名单过滤后写入。
 * 导出文件里夹带的日志与死键不会回灌存储。
 * 迁移链由调用方在写入前执行（`migrateConfig`）。
 * @returns 是否写入成功；失败时已通过 toast 提示用户
 */
export async function setAllConfig(
  data: Record<string, unknown>,
): Promise<boolean> {
  const toSet: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    // 跳过元信息字段
    if (k === '__version') continue;
    if (!isExportableConfigId(k)) continue;
    toSet[keyFor(k)] = v;
  }
  const result = await safeStorageSet(toSet);
  return result.ok;
}
