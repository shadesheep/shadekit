/**
 * 模拟数据导出器：把生成的行数组转换为 JSON / JSONL / CSV / SQL / XML。
 * - SQL 支持 MySQL / PostgreSQL / SQLite 方言，按实际数字精度推断 DECIMAL；
 *   超出方言安全精度时改用 TEXT 并引用数字，避免隐式截断。
 * - 新增 JSONL（JSON Lines）格式，便于大数据量按行处理。
 * - CSV 支持自定义分隔符与 BOM，数组/对象序列化为 JSON 字符串。
 * - XML 标签名做合法、稳定且唯一的映射，并通过 data-key 保留原始键。
 * - 统一入口同时支持完整行数组与异步分批导出。
 */
import type { ExportOptions, OutputFormat } from "./types";

// ─── 通用 ───────────────────────────────────────────────────

/** 输出值 → 标量文本（对象/数组序列化为 JSON） */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
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
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

// ─── JSON / JSONL ───────────────────────────────────────────

export function toJSON(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

export function toJSONL(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

// ─── CSV ────────────────────────────────────────────────────

const CSV_BOM = "\uFEFF";

function csvDelimiter(options: ExportOptions): string {
  const delimiter = options.csvDelimiter ?? ",";
  return Array.from(delimiter).length === 1 &&
    delimiter !== '"' &&
    delimiter !== "\n" &&
    delimiter !== "\r"
    ? delimiter
    : ",";
}

function csvCell(value: unknown, delimiter: string): string {
  const s = scalarText(value);
  return s.includes(delimiter) || /["\n\r]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function toCSV(
  rows: readonly Record<string, unknown>[],
  options: ExportOptions = {},
): string {
  const bom = options.csvBom ? CSV_BOM : "";
  if (!rows.length) return bom;
  const delimiter = csvDelimiter(options);
  const cols = collectColumns(rows);
  const lines = [cols.map((c) => csvCell(c, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(cols.map((c) => csvCell(row[c], delimiter)).join(delimiter));
  }
  return bom + lines.join("\n");
}

// ─── SQL ────────────────────────────────────────────────────

type SqlDialect = NonNullable<ExportOptions["sqlDialect"]>;

interface SqlColumnType {
  sql: string;
  /** 高精度数字写入 TEXT 时必须引用，避免数据库再次转换及截断。 */
  quoteNumbers?: boolean;
}

interface DecimalShape {
  integerDigits: number;
  fractionDigits: number;
}

function decimalShape(value: number): DecimalShape {
  const [mantissa, exponentText] = Math.abs(value)
    .toString()
    .toLowerCase()
    .split("e");
  const exponent = Number(exponentText ?? 0);
  const point = mantissa.indexOf(".");
  const decimalPosition = (point < 0 ? mantissa.length : point) + exponent;
  const digits = mantissa.replace(".", "");
  return {
    integerDigits: Math.max(1, decimalPosition),
    fractionDigits: Math.max(0, digits.length - decimalPosition),
  };
}

const DECIMAL_LIMITS: Record<SqlDialect, { precision: number; scale: number }> =
  {
    mysql: { precision: 65, scale: 30 },
    postgres: { precision: 1000, scale: 1000 },
    sqlite: {
      precision: Number.POSITIVE_INFINITY,
      scale: Number.POSITIVE_INFINITY,
    },
  };

const SQL_BOOL_TYPE: Record<SqlDialect, string> = {
  mysql: "TINYINT(1)",
  postgres: "BOOLEAN",
  sqlite: "BOOLEAN",
};

function inferColumnType(
  values: unknown[],
  dialect: SqlDialect,
): SqlColumnType {
  let allInt = true;
  let allNum = true;
  let allBool = true;
  let maxLen = 0;
  let maxIntegerDigits = 0;
  let maxFractionDigits = 0;
  let minNumber = Number.POSITIVE_INFINITY;
  let maxNumber = Number.NEGATIVE_INFINITY;
  let seen = false;

  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    seen = true;
    if (typeof v === "boolean") {
      allInt = false;
      allNum = false;
      continue;
    }
    allBool = false;
    if (typeof v === "number") {
      if (!Number.isInteger(v)) allInt = false;
      const shape = decimalShape(v);
      maxIntegerDigits = Math.max(maxIntegerDigits, shape.integerDigits);
      maxFractionDigits = Math.max(maxFractionDigits, shape.fractionDigits);
      minNumber = Math.min(minNumber, v);
      maxNumber = Math.max(maxNumber, v);
      continue;
    }
    allInt = false;
    allNum = false;
    maxLen = Math.max(maxLen, scalarText(v).length);
  }

  if (!seen) return { sql: "VARCHAR(255)" };
  if (allBool) return { sql: SQL_BOOL_TYPE[dialect] };
  if (allNum) {
    if (allInt && minNumber >= -2147483648 && maxNumber <= 2147483647) {
      return { sql: "INT" };
    }
    const precision = Math.max(1, maxIntegerDigits + maxFractionDigits);
    const scale = maxFractionDigits;
    const limits = DECIMAL_LIMITS[dialect];
    if (precision > limits.precision || scale > limits.scale) {
      return { sql: "TEXT", quoteNumbers: true };
    }
    return { sql: `DECIMAL(${precision},${scale})` };
  }
  return { sql: maxLen > 255 ? "TEXT" : "VARCHAR(255)" };
}

/** 流式 DDL 只确定一次，使用保守类型容纳后续批次中更长或更高精度的值。 */
function inferStreamingColumnType(
  values: unknown[],
  dialect: SqlDialect,
): SqlColumnType {
  const inferred = inferColumnType(values, dialect);
  if (inferred.sql === "INT") return { sql: "BIGINT" };
  if (inferred.sql.startsWith("DECIMAL(")) return { sql: "DECIMAL(38,10)" };
  if (inferred.sql === "VARCHAR(255)") return { sql: "TEXT" };
  return inferred;
}

function sqlDialect(options: ExportOptions): SqlDialect {
  return options.sqlDialect ?? "mysql";
}

function sqlIdent(name: string, dialect: SqlDialect): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlValue(
  value: unknown,
  dialect: SqlDialect,
  quoteNumber = false,
): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return quoteNumber ? `'${String(value)}'` : String(value);
  }
  if (typeof value === "boolean") {
    if (dialect === "postgres") return value ? "TRUE" : "FALSE";
    return value ? "1" : "0";
  }
  return `'${scalarText(value).replace(/'/g, "''")}'`;
}

function sqlDdl(
  table: string,
  cols: readonly string[],
  types: readonly SqlColumnType[],
  dialect: SqlDialect,
): string {
  return (
    `-- 表结构（按生成值推断列类型）\nCREATE TABLE ${sqlIdent(table, dialect)} (\n` +
    cols
      .map((c, i) => `  ${sqlIdent(c, dialect)} ${types[i].sql}`)
      .join(",\n") +
    "\n);\n\n-- 数据插入\n"
  );
}

function sqlInsert(
  rows: readonly Record<string, unknown>[],
  table: string,
  cols: readonly string[],
  types: readonly SqlColumnType[],
  dialect: SqlDialect,
): string {
  const colList = cols.map((c) => sqlIdent(c, dialect)).join(", ");
  const valueGroups = rows.map(
    (row) =>
      `(${cols
        .map((c, i) => sqlValue(row[c], dialect, types[i].quoteNumbers))
        .join(", ")})`,
  );
  return `INSERT INTO ${sqlIdent(table, dialect)} (${colList}) VALUES\n${valueGroups.join(",\n")};\n`;
}

export function toSQL(
  rows: readonly Record<string, unknown>[],
  tableName: string,
  options: ExportOptions = {},
): string {
  if (!rows.length) return "";
  const dialect = sqlDialect(options);
  const table = tableName || "mock_data";
  const cols = collectColumns(rows);
  if (!cols.length) return "";
  const types = cols.map((c) =>
    inferColumnType(
      rows.map((r) => r[c]),
      dialect,
    ),
  );
  return (
    sqlDdl(table, cols, types, dialect) +
    sqlInsert(rows, table, cols, types, dialect)
  );
}

// ─── XML ────────────────────────────────────────────────────

function xmlEscape(value: unknown): string {
  return scalarText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * XML 标签名映射：非法字符以 Unicode 码点编码，避免中文等键名全部塌缩为同名。
 * 非字母/下划线开头补 f_；极少数编码冲突由 createXmlTagMapper 添加稳定序号。
 */
export function xmlTagName(key: string): string {
  let tag = "";
  for (const char of key) {
    tag += /[A-Za-z0-9_.-]/.test(char)
      ? char
      : `_u${char.codePointAt(0)!.toString(16)}_`;
  }
  return /^[A-Za-z_]/.test(tag) ? tag : `f_${tag || "field"}`;
}

function createXmlTagMapper(): (key: string) => string {
  const byKey = new Map<string, string>();
  const used = new Set<string>();
  return (key) => {
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    const base = xmlTagName(key);
    let tag = base;
    let suffix = 2;
    while (used.has(tag)) tag = `${base}_${suffix++}`;
    byKey.set(key, tag);
    used.add(tag);
    return tag;
  };
}

function xmlContainerName(value: string | undefined, fallback: string): string {
  return xmlTagName(value || fallback);
}

function xmlRow(
  row: Record<string, unknown>,
  index: number,
  itemTag: string,
  tagForKey: (key: string) => string,
): string {
  let xml = `  <${itemTag} id="${index}">\n`;
  for (const [key, value] of Object.entries(row)) {
    const tag = tagForKey(key);
    xml += `    <${tag} data-key="${xmlEscape(key)}">${xmlEscape(value)}</${tag}>\n`;
  }
  return `${xml}  </${itemTag}>\n`;
}

export function toXML(
  rows: readonly Record<string, unknown>[],
  options: ExportOptions = {},
): string {
  const rootTag = xmlContainerName(options.xmlRoot, "list");
  const itemTag = xmlContainerName(options.xmlItem, "item");
  const tagForKey = createXmlTagMapper();
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n`;
  rows.forEach((row, index) => {
    xml += xmlRow(row, index + 1, itemTag, tagForKey);
  });
  return `${xml}</${rootTag}>`;
}

// ─── 统一入口 ───────────────────────────────────────────────

export const FORMAT_META: Record<
  OutputFormat,
  { label: string; ext: string; mime: string }
> = {
  json: { label: "JSON", ext: "json", mime: "application/json" },
  jsonl: { label: "JSONL", ext: "jsonl", mime: "application/x-ndjson" },
  csv: { label: "CSV", ext: "csv", mime: "text/csv" },
  sql: { label: "SQL", ext: "sql", mime: "application/sql" },
  xml: { label: "XML", ext: "xml", mime: "application/xml" },
};

export function exportData(
  rows: readonly Record<string, unknown>[],
  format: OutputFormat,
  tableName = "mock_data",
  options: ExportOptions = {},
): string {
  switch (format) {
    case "jsonl":
      return toJSONL(rows);
    case "csv":
      return toCSV(rows, options);
    case "sql":
      return toSQL(rows, tableName, options);
    case "xml":
      return toXML(rows, options);
    default:
      return toJSON(rows);
  }
}

type RowBatches = AsyncIterable<readonly Record<string, unknown>[]>;

async function* jsonChunks(batches: RowBatches): AsyncGenerator<string> {
  let first = true;
  for await (const rows of batches) {
    let chunk = "";
    for (const row of rows) {
      const text = JSON.stringify(row, null, 2).replace(/^/gm, "  ");
      chunk += `${first ? "[\n" : ",\n"}${text}`;
      first = false;
    }
    if (chunk) yield chunk;
  }
  yield first ? "[]" : "\n]";
}

async function* jsonlChunks(batches: RowBatches): AsyncGenerator<string> {
  let first = true;
  for await (const rows of batches) {
    if (!rows.length) continue;
    const text = rows.map((row) => JSON.stringify(row)).join("\n");
    yield `${first ? "" : "\n"}${text}`;
    first = false;
  }
}

async function* csvChunks(
  batches: RowBatches,
  options: ExportOptions,
): AsyncGenerator<string> {
  if (options.csvBom) yield CSV_BOM;
  const delimiter = csvDelimiter(options);
  let cols: string[] | undefined;
  for await (const rows of batches) {
    if (!rows.length) continue;
    if (!cols) {
      cols = collectColumns(rows);
      const lines = [cols.map((c) => csvCell(c, delimiter)).join(delimiter)];
      for (const row of rows) {
        lines.push(cols.map((c) => csvCell(row[c], delimiter)).join(delimiter));
      }
      yield lines.join("\n");
    } else {
      const columns = cols;
      const lines = rows.map((row) =>
        columns.map((c) => csvCell(row[c], delimiter)).join(delimiter),
      );
      yield `\n${lines.join("\n")}`;
    }
  }
}

async function* sqlChunks(
  batches: RowBatches,
  tableName: string,
  options: ExportOptions,
): AsyncGenerator<string> {
  const dialect = sqlDialect(options);
  const table = tableName || "mock_data";
  let schema: { cols: string[]; types: SqlColumnType[] } | undefined;
  for await (const rows of batches) {
    if (!rows.length) continue;
    if (!schema) {
      const cols = collectColumns(rows);
      if (!cols.length) continue;
      schema = {
        cols,
        types: cols.map((c) =>
          inferStreamingColumnType(
            rows.map((r) => r[c]),
            dialect,
          ),
        ),
      };
      yield sqlDdl(table, schema.cols, schema.types, dialect);
    }
    yield sqlInsert(rows, table, schema.cols, schema.types, dialect);
  }
}

async function* xmlChunks(
  batches: RowBatches,
  options: ExportOptions,
): AsyncGenerator<string> {
  const rootTag = xmlContainerName(options.xmlRoot, "list");
  const itemTag = xmlContainerName(options.xmlItem, "item");
  const tagForKey = createXmlTagMapper();
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n`;
  let index = 0;
  for await (const rows of batches) {
    let chunk = "";
    for (const row of rows) chunk += xmlRow(row, ++index, itemTag, tagForKey);
    if (chunk) yield chunk;
  }
  yield `</${rootTag}>`;
}

/**
 * 异步分批导出。首个非空批次确定 CSV 表头与 SQL 列，SQL 使用保守类型，
 * 后续批次复用同一 schema，BOM、表头和 DDL 均只输出一次。
 */
export async function* exportDataChunks(
  batches: RowBatches,
  format: OutputFormat,
  tableName = "mock_data",
  options: ExportOptions = {},
): AsyncGenerator<string> {
  switch (format) {
    case "jsonl":
      yield* jsonlChunks(batches);
      return;
    case "csv":
      yield* csvChunks(batches, options);
      return;
    case "sql":
      yield* sqlChunks(batches, tableName, options);
      return;
    case "xml":
      yield* xmlChunks(batches, options);
      return;
    default:
      yield* jsonChunks(batches);
  }
}
