/**
 * SQL 代码格式化（基于 sql-formatter 库）。
 *
 * 支持 sql-formatter 提供的全部方言（含 transactsql/tsql 别名）：
 * bigquery / clickhouse / db2 / db2i / duckdb / hive / mariadb / mysql / n1ql /
 * plsql / postgresql / redshift / singlestoredb / snowflake / spark / sql /
 * sqlite / tidb / transactsql / trino / tsql。未指定方言时默认使用通用 `sql`。
 */
import {
  formatDialect,
  bigquery,
  clickhouse,
  db2,
  db2i,
  duckdb,
  hive,
  mariadb,
  mysql,
  n1ql,
  plsql,
  postgresql,
  redshift,
  singlestoredb,
  snowflake,
  spark,
  sql,
  sqlite,
  tidb,
  transactsql,
  trino,
  type DialectOptions,
  type SqlLanguage,
} from 'sql-formatter';

export type SqlDialect = SqlLanguage;

/** 方言名 → sql-formatter 方言配置对象。tsql 为 transactsql 的别名。 */
const DIALECTS: Record<SqlDialect, DialectOptions> = {
  sql,
  bigquery,
  clickhouse,
  db2,
  db2i,
  duckdb,
  hive,
  mariadb,
  mysql,
  n1ql,
  plsql,
  postgresql,
  redshift,
  singlestoredb,
  snowflake,
  spark,
  sqlite,
  tidb,
  transactsql,
  tsql: transactsql,
  trino,
};

/** 全部受支持方言名。 */
export const SQL_DIALECTS: SqlDialect[] = Object.keys(DIALECTS) as SqlDialect[];

/** 模糊匹配方言名：忽略大小写与连字符/下划线，如 "MsSql" / "transact-sql" → 对应方言。 */
function normalizeDialect(dialect?: string): SqlDialect {
  const key = (dialect ?? 'sql').toLowerCase().replace(/[-_]/g, '');
  return (key in DIALECTS ? key : 'sql') as SqlDialect;
}

/**
 * 格式化 SQL 代码
 * @param text - SQL 文本
 * @param step - 缩进大小，默认 4 空格
 * @param dialect - 目标 SQL 方言，默认 `sql`（通用），可按需传入如 `mysql`、`postgresql`、`transactsql`
 * @returns 格式化后的 SQL
 */
export function beautifySql(text: string, step: number | string = 4, dialect: SqlDialect = 'sql'): string {
  const tabWidth = typeof step === 'string' ? step.length : step;
  return formatDialect(text, {
    dialect: DIALECTS[normalizeDialect(dialect)],
    tabWidth,
    keywordCase: 'upper',
    linesBetweenQueries: 2,
  });
}