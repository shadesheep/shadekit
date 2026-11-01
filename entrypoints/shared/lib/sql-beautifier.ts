/**
 * SQL 代码格式化（基于 sql-formatter 库）
 */
import { formatDialect, sql } from 'sql-formatter';

/**
 * 格式化 SQL 代码
 * @param text - SQL 文本
 * @param step - 缩进大小，默认 4 空格
 * @returns 格式化后的 SQL
 */
export function beautifySql(text: string, step: number | string = 4): string {
  const tabWidth = typeof step === 'string' ? step.length : step;
  // formatDialect + 单一 sql 方言：避免把 sql-formatter 的 20 种方言全部打进包
  return formatDialect(text, {
    dialect: sql,
    tabWidth,
    keywordCase: 'upper',
    linesBetweenQueries: 2,
  });
}
