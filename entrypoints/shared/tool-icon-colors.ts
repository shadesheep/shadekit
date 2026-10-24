/**
 * 工具图标语义色
 * 按 tool.id 返回 design-tokens.css 中对应的 --tool-{key}-start/end CSS 变量渐变。
 * 已知特例：json-formatter 工具的 token 前缀为 json-format（Task 1 定义时截短）。
 */

const TOOL_TOKEN_KEY: Record<string, string> = {
  'account-switch': 'account-switch',
  'json-formatter': 'json-format',
  'json-diff': 'json-diff',
  'image-base64': 'image-base64',
  'code-beautify': 'code-beautify',
  'mock-data': 'mock-data',
};

/**
 * 返回工具图标的渐变背景（用于 :style 绑定）。
 * 未知 tool.id 回退到品牌主色渐变。
 */
export function toolIconGradient(toolId: string): string {
  const key = TOOL_TOKEN_KEY[toolId];
  if (!key) {
    return 'linear-gradient(135deg, var(--primary-start), var(--primary-end))';
  }
  return `linear-gradient(135deg, var(--tool-${key}-start), var(--tool-${key}-end))`;
}
