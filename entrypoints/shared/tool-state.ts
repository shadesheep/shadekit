import { keyFor, updateConfig } from './tool-config';

/**
 * 工具启用状态管理
 * 独立存储 key，不与任何工具的配置共享同一 key。
 *
 * 读写统一走 keyFor(STATE_TOOL_ID)，单一数据源；
 * 写入走 updateConfig 的「读最新 → 字段级合并 → 写回」，
 * 多开 options 页同时开关不同工具时互不覆盖。
 */
const STATE_TOOL_ID = 'state';
const TOOL_STATE_KEY = keyFor(STATE_TOOL_ID);

interface ToolState {
  [toolId: string]: boolean;
}

/**
 * 查询某个工具是否已启用
 * @param toolId 工具 ID
 * @param defaultEnabled 未配置时的默认值
 */
export async function isToolEnabled(
  toolId: string,
  defaultEnabled = true,
): Promise<boolean> {
  const result = await chrome.storage.local.get([TOOL_STATE_KEY]);
  const state = (result[TOOL_STATE_KEY] ?? {}) as ToolState;
  if (toolId in state) return !!state[toolId];
  return defaultEnabled;
}

/**
 * 设置工具的启用状态
 * 增量合并写入：读最新 → 只更新目标工具字段 → 写回，不影响其他工具的状态。
 * @returns 是否写入成功；失败时已通过 toast 提示用户
 */
export async function setToolEnabled(
  toolId: string,
  enabled: boolean,
): Promise<boolean> {
  return updateConfig<ToolState>(STATE_TOOL_ID, { [toolId]: enabled });
}

/**
 * 获取所有工具的启用状态
 */
export async function getAllToolStates(): Promise<ToolState> {
  const result = await chrome.storage.local.get([TOOL_STATE_KEY]);
  return (result[TOOL_STATE_KEY] ?? {}) as ToolState;
}
