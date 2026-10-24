import { allTools } from '../shared/tool-definitions';
import type { ToolConfigSection } from '../shared/types';

/**
 * 从统一工具注册表派生 Options 配置页侧边栏
 */
export function getConfigSections(): ToolConfigSection[] {
  return allTools.filter((t) => t.configSection).map((t) => t.configSection!);
}

/**
 * 获取所有工具列表（用于 ToolMarket 总览页）
 */
export { allTools };
