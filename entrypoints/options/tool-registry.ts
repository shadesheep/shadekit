import { allTools } from '../shared/tool-definitions';
import type { ToolConfigSection } from '../shared/types';
import { configComponentLoaders } from './config-components';

/**
 * 从统一工具注册表派生 Options 配置页侧边栏。
 * 组件加载器按 toolId 从 options 专属映射补齐，保持注册表本身不含 UI 引用。
 */
export function getConfigSections(): ToolConfigSection[] {
  return allTools
    .filter((t) => t.configSection)
    .map((t) => ({
      ...t.configSection!,
      component: configComponentLoaders[t.id],
    }));
}

/**
 * 获取所有工具列表（用于 ToolMarket 总览页）
 */
export { allTools };
