/**
 * 模拟数据导出器：把生成的行数组转换为 JSON / JSONL / CSV / SQL / XML。
 *
 * 相比 FeHelper 原版的改进：
 * - SQL 按列做类型推断（INT / DECIMAL / TINYINT / VARCHAR / TEXT），
 *   而非一律 VARCHAR(255)；列名与表名用反引号引用，允许中文键名；
 *   多行合并为单条 INSERT（VALUES 分组），不再每行一条。
 * - 新增 JSONL（JSON Lines）格式，便于大数据量按行处理。
 * - CSV 对数组/对象值序列化为 JSON 字符串并正确转义引号/换行。
 * - XML 标签名做合法性清洗（非法字符移除、非字母开头补前缀）。
 */
import type { OutputFormat } from './types';

// ─── 通用 ───────────────────────────────────────────────────

/** 输出值 → 标量文本（对象/数组序列化为 JSON） */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 列集合：首行键序为准，后续行新增键追加（正常情况下各行键一致） */
function collectColumns(rows: readonly Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols;
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// ─── JSON / JSONL ───────────────────────────────────────────

export function toJSON(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

export function toJSONL(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

// ─── CSV ────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  const s = scalarText(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows: readonly Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = collectColumns(rows);
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => csvCell(row[c])).join(','));
  }
  return lines.join('\n');
}

// ─── SQL ────────────────────────────────────────────────────

type SqlColumnType = 'int' | 'decimal' | 'bool' | 'string' | 'text';

function inferColumnType(values: unknown[]): SqlColumnType {
  let allInt = true;
  let allNum = true;
  let allBool = true;
  let maxLen = 0;
  let seen = false;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    seen = true;
    if (typeof v === 'boolean') {
      allInt = false;
      allNum = false;
      continue;
    }
    allBool = false;
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) allInt = false;
      continue;
    }
    allInt = false;
    allNum = false;
    maxLen = Math.max(maxLen, scalarText(v).length);
  }
  if (!seen) return 'string';
  if (allBool) return 'bool';
  if (allInt) return 'int';
  if (allNum) return 'decimal';
  return maxLen > 255 ? 'text' : 'string';
}

const SQL_TYPE_SQL: Record<SqlColumnType, string> = {
  int: 'INT',
  decimal: 'DECIMAL(18,2)',
  bool: 'TINYINT(1)',
  string: 'VARCHAR(255)',
  text: 'TEXT',
};

function sqlIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${scalarText(value).replace(/'/g, "''")}'`;
}

export function toSQL(
  rows: readonly Record<string, unknown>[],
  tableName: string,
): string {
  if (!rows.length) return '';
  const table = (tableName || 'mock_data').replace(/`/g, '');
  const cols = collectColumns(rows);
  const types = cols.map((c) => inferColumnType(rows.map((r) => r[c])));

  const ddl =
    `-- 表结构（按生成值推断列类型）\nCREATE TABLE ${sqlIdent(table)} (\n` +
    cols.map((c, i) => `  ${sqlIdent(c)} ${SQL_TYPE_SQL[types[i]]}`).join(',\n') +
    '\n);\n\n-- 数据插入\n';

  const colList = cols.map(sqlIdent).join(', ');
  const valueGroups = rows.map(
    (row) => `(${cols.map((c) => sqlValue(row[c])).join(', ')})`,
  );
  return `${ddl}INSERT INTO ${sqlIdent(table)} (${colList}) VALUES\n${valueGroups.join(',\n')};\n`;
}

// ─── XML ────────────────────────────────────────────────────

function xmlEscape(value: unknown): string {
  return scalarText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML 标签名清洗：移除非 [A-Za-z0-9_.-] 字符，非字母/下划线开头补 f_ */
export function xmlTagName(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_.-]/g, '');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `f_${cleaned || 'field'}`;
}

export function toXML(rows: readonly Record<string, unknown>[]): string {
  if (!rows.length) return '';
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<list>\n';
  rows.forEach((row, index) => {
    xml += `  <item id="${index + 1}">\n`;
    for (const [key, value] of Object.entries(row)) {
      const tag = xmlTagName(key);
      xml += `    <${tag}>${xmlEscape(value)}</${tag}>\n`;
    }
    xml += '  </item>\n';
  });
  return `${xml}</list>`;
}

// ─── 统一入口 ───────────────────────────────────────────────

export const FORMAT_META: Record<
  OutputFormat,
  { label: string; ext: string; mime: string }
> = {
  json: { label: 'JSON', ext: 'json', mime: 'application/json' },
  jsonl: { label: 'JSONL', ext: 'jsonl', mime: 'application/x-ndjson' },
  csv: { label: 'CSV', ext: 'csv', mime: 'text/csv' },
  sql: { label: 'SQL', ext: 'sql', mime: 'application/sql' },
  xml: { label: 'XML', ext: 'xml', mime: 'application/xml' },
};

export function exportData(
  rows: readonly Record<string, unknown>[],
  format: OutputFormat,
  tableName = 'mock_data',
): string {
  switch (format) {
    case 'jsonl':
      return toJSONL(rows);
    case 'csv':
      return toCSV(rows);
    case 'sql':
      return toSQL(rows, tableName);
    case 'xml':
      return toXML(rows);
    default:
      return toJSON(rows);
  }
}
