/**
 * 框架自动生成的 id 判定（ADR-0013 D4 补充）
 *
 * Element Plus 的 `el-id-9759-21`、React 18 `:r1:`、Radix `«r1»` 等都按全局
 * 计数器在渲染时生成，刷新 / 路由变化后就是另一串数字。它们在**当前文档内**
 * 是唯一的，若不排除，候选排序会把它们当成最稳的定位推荐，配方一保存就
 * `ELEMENT_NOT_FOUND`（v1.1.4 管理后台登录表单回归）。
 *
 * ⚠️ `target-picker.ts` 的 `pickerInPage` 与 `login-form-scan.ts` 的
 * `scanLoginFormInPage` 会被序列化注入页面，**不能引用本模块**，各自内联了
 * 一份同源实现；一致性由 `tests/target-picker.test.ts` 固化。
 */

const PATTERNS: RegExp[] = [
  /^el-id-\d+(-\d+)?$/, // Element Plus
  /^:r[0-9a-z]+:$/i, // React 18+ useId
  /^«r[0-9a-z]+»$/i, // Radix / React 19
  /^(radix|mui|ember|ext-gen|ui-id|yui|react-select|downshift|headlessui|a11y)[-_:«]*r?\d+/i,
  // 通用兜底：前缀 + 长数字串（计数器 / 时间戳）。阈值取 5 位，
  // 避免把 `section2024` 这类带年份的语义 id 误判为自动生成。
  /^[a-z][a-z_-]{0,16}\d{5,}([-_]\d+)*$/i,
];

/** id 是否由框架自动生成（不稳定，不能作为定位） */
export function isVolatileId(id: string): boolean {
  const value = id.trim();
  if (!value) return false;
  return PATTERNS.some((pattern) => pattern.test(value));
}

/** CSS 定位里是否写死了自动生成的 id（如 `#el-id-9759-21`） */
export function containsVolatileId(css: string): boolean {
  const matches = css.match(/#((?:\\.|[^\s>+~,.#:[\]])+)/g);
  if (!matches) return false;
  return matches.some((token) =>
    isVolatileId(token.slice(1).replace(/\\(.)/g, "$1")),
  );
}
