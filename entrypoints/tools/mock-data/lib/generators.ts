/**
 * 声明式字段注册表与批量生成入口。
 * 所有随机值均由 GenContext.rng 驱动；约束、场景和递归结构在统一包装层处理。
 */
import {
  generateBankCard,
  generateIdCard,
  generateUscc,
  toChineseCapital,
} from "./data-pools";
import {
  EVAL_METHODS,
  SECTION_NAMES,
  TENDER_METHODS,
  generateProjectName,
} from "./domains/tender";
import {
  DOMAIN_SUFFIXES,
  FILE_EXTENSIONS,
  MIME_TYPES,
  USER_AGENTS,
  generateUrl,
} from "./domains/tech";
import {
  generateAddress,
  generateCompany,
  generateEmail,
  generateName,
  generatePhone,
  getLocaleData,
} from "./locales";
import {
  createRandom,
  defaultRandom,
  pick,
  randomDigits,
  randomInt,
  randomString,
} from "./random";
import type { RandomSource } from "./random";
import type {
  CategoryDef,
  FieldParamDef,
  FieldTypeDef,
  GenContext,
  GenerateOptions,
  LocaleId,
  MockField,
  MockScenario,
} from "./types";

export { createRandom } from "./random";
export const MAX_ROWS = 100000;
const MAX_UNIQUE_ATTEMPTS = 100;
const SEEDED_REFERENCE_TIME = Date.UTC(2024, 0, 1, 9, 0, 0);

function num(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const parsed =
    typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown, fallback: string): string {
  const parsed =
    typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return parsed || fallback;
}

function contextRng(ctx: GenContext): RandomSource {
  return ctx.rng ?? defaultRandom;
}

function contextLocale(ctx: GenContext): LocaleId {
  return ctx.locale === "en-US" ? "en-US" : "zh-CN";
}

function parseLiteral(raw: string): unknown {
  const source = raw.trim();
  if (!source) return "";
  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}

/** 枚举文本 → 候选数组：支持逗号（中英文）、顿号、竖线、空白分隔。 */
export function parseEnumValues(raw: string): unknown[] {
  return raw
    .split(/[,，、|\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseLiteral);
}

function enumValues(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : parseEnumValues(String(raw ?? ""));
}

function weightedEnum(
  values: unknown[],
  rawWeights: unknown,
  rng: RandomSource,
): unknown {
  if (!values.length) return "";
  const weights = Array.isArray(rawWeights)
    ? rawWeights.map((value) => num(value, 0))
    : String(rawWeights ?? "")
        .split(/[,，、|\s]+/)
        .map((value) => num(value, 0));
  const usable =
    weights.length === values.length && weights.every((weight) => weight >= 0)
      ? weights
      : [];
  const total = usable.reduce((sum, weight) => sum + weight, 0);
  if (!total) return pick(values, rng);
  let cursor = rng() * total;
  for (let i = 0; i < values.length; i += 1) {
    cursor -= usable[i];
    if (cursor < 0) return values[i];
  }
  return values[values.length - 1];
}

/** 支持 8、1,3,8-12 等长度集合，所有长度限制在 1..200。 */
function parseLengths(raw: unknown): number[] {
  const lengths: number[] = [];
  for (const token of String(raw ?? "8").split(/[,，、|]+/)) {
    const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) continue;
    const first = Math.min(Math.max(Number(match[1]), 1), 200);
    const last = Math.min(Math.max(Number(match[2] ?? match[1]), 1), 200);
    for (
      let length = Math.min(first, last);
      length <= Math.max(first, last);
      length += 1
    ) {
      lengths.push(length);
    }
  }
  return lengths.length ? lengths : [8];
}

const CHARSETS: Record<string, string> = {
  alnum: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  alpha: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numeric: "0123456789",
  hex: "0123456789abcdef",
  cn: "的一是不了我在人有他这中大来上个国和地说到为子时年得出就那要和会可也你对生能而子那好于心得着然没都成看只发当平地们道还实做作种开面总事",
};

function numericParams(
  min: number,
  max: number,
  precision?: number,
): FieldParamDef[] {
  const params: FieldParamDef[] = [
    { name: "min", label: "最小", kind: "number", default: min },
    { name: "max", label: "最大", kind: "number", default: max },
  ];
  if (precision !== undefined) {
    params.push({
      name: "precision",
      label: "小数位",
      kind: "number",
      default: precision,
      min: 0,
      max: 6,
    });
  }
  params.push(
    {
      name: "distribution",
      label: "分布",
      kind: "select",
      default: "uniform",
      options: [
        { value: "uniform", label: "均匀分布" },
        { value: "normal", label: "正态分布" },
        { value: "exponential", label: "指数分布" },
      ],
    },
    {
      name: "mean",
      label: "正态均值",
      kind: "number",
      default: (min + max) / 2,
    },
    {
      name: "stdDev",
      label: "正态标准差",
      kind: "number",
      default: Math.max((max - min) / 6, 0.000001),
      min: 0,
    },
    {
      name: "lambda",
      label: "指数率 λ",
      kind: "number",
      default: 1,
      min: 0.000001,
    },
  );
  return params;
}

interface NumericDefaults {
  min: number;
  max: number;
  precision: number;
  integer: boolean;
}

function numericValue(
  params: Record<string, unknown>,
  ctx: GenContext,
  defaults: NumericDefaults,
): number {
  const min = num(params.min, defaults.min);
  const max = num(params.max, defaults.max);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const rng = contextRng(ctx);
  const distribution = str(params.distribution, "uniform");
  let value: number;
  if (distribution === "normal") {
    const u1 = Math.max(rng(), Number.EPSILON);
    const u2 = rng();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    value =
      num(params.mean, (lo + hi) / 2) +
      normal * Math.max(0, num(params.stdDev, (hi - lo) / 6));
  } else if (distribution === "exponential") {
    const lambda = Math.max(num(params.lambda, 1), 0.000001);
    value =
      lo +
      (-Math.log(Math.max(1 - rng(), Number.EPSILON)) / lambda) *
        ((hi - lo) / 4);
  } else {
    value = lo + rng() * (hi - lo);
  }
  value = Math.min(Math.max(value, lo), hi);
  const precision = Math.min(
    Math.max(Math.trunc(num(params.precision, defaults.precision)), 0),
    6,
  );
  return defaults.integer
    ? Math.round(value)
    : Number(value.toFixed(precision));
}

function numericBoundary(
  params: Record<string, unknown>,
  ctx: GenContext,
  defaults: NumericDefaults,
): number {
  const min = num(params.min, defaults.min);
  const max = num(params.max, defaults.max);
  const value = ctx.index % 2 === 0 ? Math.min(min, max) : Math.max(min, max);
  const precision = Math.min(
    Math.max(Math.trunc(num(params.precision, defaults.precision)), 0),
    6,
  );
  return defaults.integer
    ? Math.round(value)
    : Number(value.toFixed(precision));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function validTimeZone(timeZone: string): boolean {
  if (timeZone === "local") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function formatDateTime(
  date: Date,
  format: string,
  timeZone = "local",
): string | number {
  if (format === "timestamp") return date.getTime();
  if (format === "timestamp_s") return Math.floor(date.getTime() / 1000);
  const zone = validTimeZone(timeZone) ? timeZone : "local";
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  let day = date.getDate();
  let hour = date.getHours();
  let minute = date.getMinutes();
  let second = date.getSeconds();
  if (zone !== "local") {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values: Record<string, number> = {};
    for (const part of parts) {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    }
    year = values.year;
    month = values.month;
    day = values.day;
    hour = values.hour;
    minute = values.minute;
    second = values.second;
  }
  const dateText = `${year}-${pad2(month)}-${pad2(day)}`;
  return format === "datetime"
    ? `${dateText} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
    : dateText;
}

function dateParam(raw: unknown, fallback: string): number {
  const parsed = new Date(str(raw, fallback)).getTime();
  return Number.isNaN(parsed) ? new Date(fallback).getTime() : parsed;
}

function randomDateBetween(
  startRaw: unknown,
  endRaw: unknown,
  rng: RandomSource,
  now: number,
): Date {
  const startMs = dateParam(startRaw, "2020-01-01");
  const endText = str(endRaw, "");
  const parsedEnd = endText ? new Date(endText).getTime() : now;
  const endMs = Number.isNaN(parsedEnd) ? now : parsedEnd;
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  return new Date(lo + rng() * (hi - lo));
}

function weekday(date: Date, timeZone: string): number {
  if (timeZone === "local") return date.getDay();
  const text = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: validTimeZone(timeZone) ? timeZone : "UTC",
  }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(text);
}

function addBusinessDays(
  startMs: number,
  days: number,
  timeZone: string,
): number {
  let result = startMs;
  while (
    weekday(new Date(result), timeZone) === 0 ||
    weekday(new Date(result), timeZone) === 6
  ) {
    result += 86400000;
  }
  const wholeWeeks = Math.floor(days / 5);
  let remainder = days % 5;
  result += wholeWeeks * 7 * 86400000;
  while (remainder > 0) {
    result += 86400000;
    const day = weekday(new Date(result), timeZone);
    if (day !== 0 && day !== 6) remainder -= 1;
  }
  return result;
}

const STEP_UNITS: Record<string, number> = {
  day: 86400000,
  hour: 3600000,
  minute: 60000,
  second: 1000,
};

function dateValue(params: Record<string, unknown>, ctx: GenContext): Date {
  const timeZone = str(params.timezone, "local");
  const workdays = str(params.workdays, "false") === "true";
  if (ctx.scenario === "timeSeries") {
    const start = dateParam(params.start, "2020-01-01");
    const step = Math.max(1, Math.trunc(num(params.step, 1)));
    const unit = str(params.stepUnit, "day");
    const amount = step * ctx.index;
    if (workdays && unit === "day")
      return new Date(addBusinessDays(start, amount, timeZone));
    let result = start + amount * (STEP_UNITS[unit] ?? STEP_UNITS.day);
    if (workdays) {
      while (
        weekday(new Date(result), timeZone) === 0 ||
        weekday(new Date(result), timeZone) === 6
      ) {
        result += 86400000;
      }
    }
    return new Date(result);
  }
  const date = randomDateBetween(
    params.start,
    params.end,
    contextRng(ctx),
    ctx.now ?? Date.now(),
  );
  if (workdays) {
    let result = date.getTime();
    while (weekday(date, timeZone) === 0 || weekday(date, timeZone) === 6) {
      result += 86400000;
      date.setTime(result);
    }
  }
  return date;
}

function derivedValue(
  params: Record<string, unknown>,
  ctx: GenContext,
): unknown {
  const sourceKey = str(params.sourceKey, "");
  if (!sourceKey || !Object.hasOwn(ctx.row, sourceKey)) {
    throw new Error(
      `派生字段引用的 sourceKey「${sourceKey || "(空)"}」不存在或尚未生成`,
    );
  }
  const source = ctx.row[sourceKey];
  const transform = str(params.transform, "copy");
  if (transform === "uppercase") return String(source).toUpperCase();
  if (transform === "lowercase") return String(source).toLowerCase();
  if (transform === "stringify")
    return typeof source === "object" ? JSON.stringify(source) : String(source);
  if (transform === "chineseCapital") return toChineseCapital(Number(source));
  if (transform === "idCardBirthDate") {
    const idCard = String(source);
    if (!/^\d{17}[\dXx]$/.test(idCard))
      throw new Error(`字段「${sourceKey}」不是有效的 18 位身份证号`);
    return `${idCard.slice(6, 10)}-${idCard.slice(10, 12)}-${idCard.slice(12, 14)}`;
  }
  if (transform === "idCardGender") {
    const idCard = String(source);
    if (!/^\d{17}[\dXx]$/.test(idCard))
      throw new Error(`字段「${sourceKey}」不是有效的 18 位身份证号`);
    const data = getLocaleData(contextLocale(ctx));
    return Number(idCard[16]) % 2 === 1 ? data.male : data.female;
  }
  if (transform === "dateAfter") {
    const sourceDate =
      source instanceof Date ? source : new Date(source as string | number);
    if (Number.isNaN(sourceDate.getTime()))
      throw new Error(`字段「${sourceKey}」不是有效日期`);
    const amount = num(params.amount, 1);
    const unit = str(params.unit, "day");
    const result = new Date(
      sourceDate.getTime() + amount * (STEP_UNITS[unit] ?? STEP_UNITS.day),
    );
    const requestedFormat = str(params.format, "auto");
    const format =
      requestedFormat === "auto"
        ? typeof source === "number"
          ? "timestamp"
          : /^\d{4}-\d{2}-\d{2}$/.test(String(source))
            ? "date"
            : "datetime"
        : requestedFormat;
    return formatDateTime(result, format, str(params.timezone, "local"));
  }
  if (typeof source === "object" && source !== null)
    return JSON.parse(JSON.stringify(source));
  return source;
}

export const CATEGORIES: CategoryDef[] = [
  { id: "basic", label: "基础", icon: "i-lucide-sliders-horizontal" },
  { id: "person", label: "人员", icon: "i-lucide-user" },
  { id: "business", label: "企业", icon: "i-lucide-building-2" },
  { id: "tender", label: "招投标", icon: "i-lucide-gavel" },
  { id: "tech", label: "技术", icon: "i-lucide-cpu" },
];

export const FIELD_TYPES: FieldTypeDef[] = [
  {
    id: "increment",
    label: "自增序号",
    category: "basic",
    defaultKey: "id",
    params: [
      { name: "start", label: "起始", kind: "number", default: 1 },
      { name: "step", label: "步长", kind: "number", default: 1 },
      {
        name: "pad",
        label: "补零位数",
        kind: "number",
        default: 0,
        min: 0,
        max: 12,
      },
    ],
    generate: (params, ctx) => {
      const value = num(params.start, 1) + ctx.index * num(params.step, 1);
      const pad = Math.trunc(num(params.pad, 0));
      return pad > 0 ? String(value).padStart(pad, "0") : value;
    },
  },
  {
    id: "fixed",
    label: "固定值",
    category: "basic",
    defaultKey: "fixed",
    params: [
      {
        name: "value",
        label: "值",
        kind: "text",
        default: "",
        placeholder: "支持 JSON 字面量，如 123 / true / [1,2]",
      },
    ],
    generate: (params) => parseLiteral(String(params.value ?? "")),
  },
  {
    id: "int",
    label: "随机整数",
    category: "basic",
    defaultKey: "num",
    params: numericParams(1, 1000),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 1,
        max: 1000,
        precision: 0,
        integer: true,
      }),
  },
  {
    id: "float",
    label: "随机小数",
    category: "basic",
    defaultKey: "amount",
    params: numericParams(0, 1000, 2),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 0,
        max: 1000,
        precision: 2,
        integer: false,
      }),
  },
  {
    id: "boolean",
    label: "布尔值",
    category: "basic",
    defaultKey: "flag",
    params: [],
    generate: (_params, ctx) => contextRng(ctx)() < 0.5,
  },
  {
    id: "enum",
    label: "枚举值",
    category: "basic",
    defaultKey: "status",
    params: [
      {
        name: "values",
        label: "候选值",
        kind: "text",
        default: "草稿,已提交,已审核",
        placeholder: "以逗号/空格/竖线分隔",
      },
      {
        name: "weights",
        label: "权重（可选）",
        kind: "text",
        default: "",
        placeholder: "与候选值一一对应，如 1,3,6",
      },
    ],
    generate: (params, ctx) =>
      weightedEnum(enumValues(params.values), params.weights, contextRng(ctx)),
  },
  {
    id: "string",
    label: "随机字符串",
    category: "basic",
    defaultKey: "text",
    params: [
      {
        name: "length",
        label: "长度集合",
        kind: "text",
        default: "8",
        placeholder: "如 1,3,8-12",
      },
      {
        name: "charset",
        label: "字符集",
        kind: "select",
        default: "alnum",
        options: [
          { value: "alnum", label: "字母+数字" },
          { value: "alpha", label: "纯字母" },
          { value: "numeric", label: "纯数字" },
          { value: "hex", label: "十六进制" },
          { value: "cn", label: "中文" },
        ],
      },
    ],
    generate: (params, ctx) => {
      const rng = contextRng(ctx);
      return randomString(
        pick(parseLengths(params.length), rng),
        CHARSETS[str(params.charset, "alnum")] ?? CHARSETS.alnum,
        rng,
      );
    },
  },
  {
    id: "date",
    label: "日期时间",
    category: "basic",
    defaultKey: "date",
    params: [
      {
        name: "start",
        label: "起始",
        kind: "text",
        default: "2020-01-01",
        placeholder: "YYYY-MM-DD",
      },
      {
        name: "end",
        label: "截止",
        kind: "text",
        default: "",
        placeholder: "留空为参考当前时间",
      },
      {
        name: "format",
        label: "格式",
        kind: "select",
        default: "date",
        options: [
          { value: "date", label: "YYYY-MM-DD" },
          { value: "datetime", label: "YYYY-MM-DD HH:mm:ss" },
          { value: "timestamp", label: "时间戳(毫秒)" },
          { value: "timestamp_s", label: "时间戳(秒)" },
        ],
      },
      {
        name: "step",
        label: "时间序列步长",
        kind: "number",
        default: 1,
        min: 1,
      },
      {
        name: "stepUnit",
        label: "步长单位",
        kind: "select",
        default: "day",
        options: [
          { value: "day", label: "天" },
          { value: "hour", label: "小时" },
          { value: "minute", label: "分钟" },
          { value: "second", label: "秒" },
        ],
      },
      {
        name: "workdays",
        label: "仅工作日",
        kind: "select",
        default: "false",
        options: [
          { value: "false", label: "否" },
          { value: "true", label: "是" },
        ],
      },
      {
        name: "timezone",
        label: "时区",
        kind: "text",
        default: "local",
        placeholder: "local / UTC / Asia/Shanghai",
      },
    ],
    generate: (params, ctx) =>
      formatDateTime(
        dateValue(params, ctx),
        str(params.format, "date"),
        str(params.timezone, "local"),
      ),
  },
  {
    id: "derived",
    label: "派生字段",
    category: "basic",
    defaultKey: "derived",
    params: [
      { name: "sourceKey", label: "来源字段 key", kind: "text", default: "" },
      {
        name: "transform",
        label: "转换",
        kind: "select",
        default: "copy",
        options: [
          { value: "copy", label: "复制" },
          { value: "uppercase", label: "转大写" },
          { value: "lowercase", label: "转小写" },
          { value: "stringify", label: "字符串化" },
          { value: "chineseCapital", label: "人民币大写" },
          { value: "idCardBirthDate", label: "身份证出生日期" },
          { value: "idCardGender", label: "身份证性别" },
          { value: "dateAfter", label: "日期偏移" },
        ],
      },
      { name: "amount", label: "日期偏移量", kind: "number", default: 1 },
      {
        name: "unit",
        label: "日期偏移单位",
        kind: "select",
        default: "day",
        options: [
          { value: "day", label: "天" },
          { value: "hour", label: "小时" },
          { value: "minute", label: "分钟" },
          { value: "second", label: "秒" },
        ],
      },
      {
        name: "format",
        label: "日期输出格式",
        kind: "select",
        default: "auto",
        options: [
          { value: "auto", label: "跟随来源" },
          { value: "date", label: "日期" },
          { value: "datetime", label: "日期时间" },
          { value: "timestamp", label: "毫秒时间戳" },
          { value: "timestamp_s", label: "秒时间戳" },
        ],
      },
      { name: "timezone", label: "时区", kind: "text", default: "local" },
    ],
    generate: derivedValue,
  },
  {
    id: "object",
    label: "嵌套对象",
    category: "basic",
    defaultKey: "object",
    params: [],
    generate: () => ({}),
  },
  {
    id: "array",
    label: "数组",
    category: "basic",
    defaultKey: "items",
    params: [
      {
        name: "itemType",
        label: "标量元素类型",
        kind: "text",
        default: "string",
        placeholder: "提供 children 时忽略",
      },
      {
        name: "minItems",
        label: "最少元素",
        kind: "number",
        default: 1,
        min: 0,
        max: 100,
      },
      {
        name: "maxItems",
        label: "最多元素",
        kind: "number",
        default: 3,
        min: 0,
        max: 100,
      },
    ],
    generate: () => [],
  },
  {
    id: "name",
    label: "姓名",
    category: "person",
    defaultKey: "name",
    params: [],
    generate: (_params, ctx) =>
      generateName(contextLocale(ctx), contextRng(ctx)),
  },
  {
    id: "gender",
    label: "性别",
    category: "person",
    defaultKey: "gender",
    params: [],
    generate: (_params, ctx) => {
      const data = getLocaleData(contextLocale(ctx));
      return contextRng(ctx)() < 0.5 ? data.male : data.female;
    },
  },
  {
    id: "age",
    label: "年龄",
    category: "person",
    defaultKey: "age",
    params: numericParams(18, 60),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 18,
        max: 60,
        precision: 0,
        integer: true,
      }),
  },
  {
    id: "phone",
    label: "手机号",
    category: "person",
    defaultKey: "phone",
    params: [],
    generate: (_params, ctx) =>
      generatePhone(contextLocale(ctx), contextRng(ctx)),
  },
  {
    id: "idCard",
    label: "身份证号",
    category: "person",
    defaultKey: "idCard",
    params: [],
    generate: (_params, ctx) => generateIdCard(contextRng(ctx)),
  },
  {
    id: "email",
    label: "邮箱",
    category: "person",
    defaultKey: "email",
    params: [],
    generate: (_params, ctx) =>
      generateEmail(contextLocale(ctx), contextRng(ctx)),
  },
  {
    id: "address",
    label: "地址",
    category: "person",
    defaultKey: "address",
    params: [],
    generate: (_params, ctx) =>
      generateAddress(contextLocale(ctx), contextRng(ctx)),
  },
  {
    id: "company",
    label: "公司名称",
    category: "business",
    defaultKey: "company",
    params: [],
    generate: (_params, ctx) =>
      generateCompany(contextLocale(ctx), contextRng(ctx)),
  },
  {
    id: "uscc",
    label: "统一社会信用代码",
    category: "business",
    defaultKey: "uscc",
    params: [],
    generate: (_params, ctx) => generateUscc(contextRng(ctx)),
  },
  {
    id: "department",
    label: "部门",
    category: "business",
    defaultKey: "department",
    params: [],
    generate: (_params, ctx) =>
      pick(getLocaleData(contextLocale(ctx)).departments, contextRng(ctx)),
  },
  {
    id: "position",
    label: "职位",
    category: "business",
    defaultKey: "position",
    params: [],
    generate: (_params, ctx) =>
      pick(getLocaleData(contextLocale(ctx)).positions, contextRng(ctx)),
  },
  {
    id: "salary",
    label: "薪资",
    category: "business",
    defaultKey: "salary",
    params: numericParams(5000, 30000),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 5000,
        max: 30000,
        precision: 0,
        integer: true,
      }),
  },
  {
    id: "bankCard",
    label: "银行卡号",
    category: "business",
    defaultKey: "bankCard",
    params: [],
    generate: (_params, ctx) => generateBankCard(contextRng(ctx)),
  },
  {
    id: "price",
    label: "价格",
    category: "business",
    defaultKey: "price",
    params: numericParams(1, 9999, 2),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 1,
        max: 9999,
        precision: 2,
        integer: false,
      }),
  },
  {
    id: "currency",
    label: "货币代码",
    category: "business",
    defaultKey: "currency",
    params: [],
    generate: (_params, ctx) =>
      pick(getLocaleData(contextLocale(ctx)).currencies, contextRng(ctx)),
  },
  {
    id: "projectName",
    label: "项目名称",
    category: "tender",
    defaultKey: "projectName",
    params: [],
    generate: (_params, ctx) =>
      generateProjectName(contextLocale(ctx), contextRng(ctx)),
  },
  {
    id: "projectCode",
    label: "项目编号",
    category: "tender",
    defaultKey: "projectCode",
    params: [{ name: "prefix", label: "前缀", kind: "text", default: "E" }],
    generate: (params, ctx) => {
      const prefix =
        str(params.prefix, "E").replace(/[^A-Za-z0-9]/g, "") || "E";
      const now = new Date(ctx.now ?? Date.now());
      return `${prefix}${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${randomDigits(4, contextRng(ctx))}`;
    },
  },
  {
    id: "sectionName",
    label: "标段名称",
    category: "tender",
    defaultKey: "sectionName",
    params: [],
    generate: (_params, ctx) => pick(SECTION_NAMES, contextRng(ctx)),
  },
  {
    id: "sectionCode",
    label: "标段编号",
    category: "tender",
    defaultKey: "sectionCode",
    params: [{ name: "prefix", label: "前缀", kind: "text", default: "E" }],
    generate: (params, ctx) => {
      const prefix =
        str(params.prefix, "E").replace(/[^A-Za-z0-9]/g, "") || "E";
      const now = new Date(ctx.now ?? Date.now());
      const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
      const rng = contextRng(ctx);
      return `${prefix}${ymd}${randomDigits(4, rng)}-0${randomInt(1, 3, rng)}`;
    },
  },
  {
    id: "tenderMethod",
    label: "招标方式",
    category: "tender",
    defaultKey: "tenderMethod",
    params: [],
    generate: (_params, ctx) => pick(TENDER_METHODS, contextRng(ctx)),
  },
  {
    id: "evalMethod",
    label: "评标办法",
    category: "tender",
    defaultKey: "evalMethod",
    params: [],
    generate: (_params, ctx) => pick(EVAL_METHODS, contextRng(ctx)),
  },
  {
    id: "budget",
    label: "预算金额",
    category: "tender",
    defaultKey: "budget",
    params: numericParams(100000, 50000000, 2),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 100000,
        max: 50000000,
        precision: 2,
        integer: false,
      }),
  },
  {
    id: "bondAmount",
    label: "投标保证金",
    category: "tender",
    defaultKey: "bondAmount",
    params: numericParams(5000, 500000, 2),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 5000,
        max: 500000,
        precision: 2,
        integer: false,
      }),
  },
  {
    id: "moneyCn",
    label: "金额大写",
    category: "tender",
    defaultKey: "amountCn",
    params: numericParams(10000, 10000000, 2),
    generate: (params, ctx) =>
      toChineseCapital(
        numericValue(params, ctx, {
          min: 10000,
          max: 10000000,
          precision: 2,
          integer: false,
        }),
      ),
  },
  {
    id: "score",
    label: "评审得分",
    category: "tender",
    defaultKey: "score",
    params: numericParams(60, 100, 1),
    generate: (params, ctx) =>
      numericValue(params, ctx, {
        min: 60,
        max: 100,
        precision: 1,
        integer: false,
      }),
  },
  {
    id: "openBidTime",
    label: "开标时间",
    category: "tender",
    defaultKey: "openBidTime",
    params: [
      {
        name: "days",
        label: "未来天数",
        kind: "number",
        default: 30,
        min: 1,
        max: 365,
      },
    ],
    generate: (params, ctx) => {
      const rng = contextRng(ctx);
      const days = Math.max(1, Math.trunc(num(params.days, 30)));
      const offset =
        ctx.scenario === "timeSeries" ? ctx.index : randomInt(1, days, rng);
      const date = new Date((ctx.now ?? Date.now()) + offset * 86400000);
      date.setHours(
        ctx.scenario === "timeSeries" ? 9 : pick([9, 10, 11, 14, 15, 16], rng),
        ctx.scenario === "timeSeries" ? 0 : pick([0, 30], rng),
        0,
        0,
      );
      return formatDateTime(date, "datetime");
    },
  },
  {
    id: "uuid",
    label: "UUID",
    category: "tech",
    defaultKey: "uuid",
    params: [],
    generate: (_params, ctx) => {
      const rng = contextRng(ctx);
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const random = Math.floor(rng() * 16);
        return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
      });
    },
  },
  {
    id: "ip",
    label: "IP 地址",
    category: "tech",
    defaultKey: "ip",
    params: [],
    generate: (_params, ctx) => {
      const rng = contextRng(ctx);
      return `${randomInt(1, 255, rng)}.${randomInt(0, 255, rng)}.${randomInt(0, 255, rng)}.${randomInt(1, 255, rng)}`;
    },
  },
  {
    id: "mac",
    label: "MAC 地址",
    category: "tech",
    defaultKey: "mac",
    params: [],
    generate: (_params, ctx) => {
      const rng = contextRng(ctx);
      return Array.from({ length: 6 }, () =>
        randomString(2, "0123456789ABCDEF", rng),
      ).join(":");
    },
  },
  {
    id: "url",
    label: "URL",
    category: "tech",
    defaultKey: "url",
    params: [],
    generate: (_params, ctx) => generateUrl(contextRng(ctx)),
  },
  {
    id: "domain",
    label: "域名",
    category: "tech",
    defaultKey: "domain",
    params: [],
    generate: (_params, ctx) => {
      const rng = contextRng(ctx);
      return `${randomString(randomInt(5, 12, rng), "abcdefghijklmnopqrstuvwxyz", rng)}.${pick(DOMAIN_SUFFIXES, rng)}`;
    },
  },
  {
    id: "userAgent",
    label: "User-Agent",
    category: "tech",
    defaultKey: "userAgent",
    params: [],
    generate: (_params, ctx) => pick(USER_AGENTS, contextRng(ctx)),
  },
  {
    id: "token",
    label: "Token",
    category: "tech",
    defaultKey: "token",
    params: [
      {
        name: "length",
        label: "长度",
        kind: "number",
        default: 32,
        min: 8,
        max: 128,
      },
    ],
    generate: (params, ctx) =>
      randomString(
        Math.min(Math.max(Math.trunc(num(params.length, 32)), 8), 128),
        undefined,
        contextRng(ctx),
      ),
  },
  {
    id: "password",
    label: "随机密码",
    category: "tech",
    defaultKey: "password",
    params: [
      {
        name: "length",
        label: "长度",
        kind: "number",
        default: 12,
        min: 6,
        max: 64,
      },
    ],
    generate: (params, ctx) =>
      randomString(
        Math.min(Math.max(Math.trunc(num(params.length, 12)), 6), 64),
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*",
        contextRng(ctx),
      ),
  },
  {
    id: "color",
    label: "颜色值",
    category: "tech",
    defaultKey: "color",
    params: [],
    generate: (_params, ctx) =>
      `#${randomString(6, "0123456789ABCDEF", contextRng(ctx))}`,
  },
  {
    id: "filename",
    label: "文件名",
    category: "tech",
    defaultKey: "filename",
    params: [],
    generate: (_params, ctx) => {
      const rng = contextRng(ctx);
      return `${randomString(randomInt(5, 12, rng), "abcdefghijklmnopqrstuvwxyz", rng)}.${pick(FILE_EXTENSIONS, rng)}`;
    },
  },
  {
    id: "mimeType",
    label: "MIME 类型",
    category: "tech",
    defaultKey: "mimeType",
    params: [],
    generate: (_params, ctx) => pick(MIME_TYPES, contextRng(ctx)),
  },
];

const TYPE_INDEX = new Map(FIELD_TYPES.map((type) => [type.id, type]));

export function getFieldType(typeId: string): FieldTypeDef | undefined {
  return TYPE_INDEX.get(typeId);
}

export function getCategoryLabel(categoryId: string): string {
  return (
    CATEGORIES.find((category) => category.id === categoryId)?.label ??
    categoryId
  );
}

export function defaultParams(def: FieldTypeDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of def.params) out[param.name] = param.default;
  return out;
}

let rowSeq = 0;

export function nextRowId(): string {
  rowSeq += 1;
  return `f_${Date.now().toString(36)}_${rowSeq}`;
}

export function nextKey(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

export function createField(
  typeId: string,
  existingKeys: ReadonlySet<string>,
): MockField | null {
  const def = getFieldType(typeId);
  if (!def) return null;
  const field: MockField = {
    id: nextRowId(),
    key: nextKey(def.defaultKey, existingKeys),
    type: def.id,
    params: defaultParams(def),
    constraints: { nullRate: 0, unique: false, invalidRate: 0 },
  };
  if (def.id === "object") field.children = [];
  return field;
}

const TYPE_ALIASES: Record<string, string> = {
  integer: "int",
  number: "float",
  text: "string",
  datetime: "date",
  select: "enum",
  fullName: "name",
  mobile: "phone",
  mail: "email",
  nested: "object",
  list: "array",
  formula: "derived",
};

function sanitizeParams(
  def: FieldTypeDef,
  raw: unknown,
): Record<string, unknown> {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const param of def.params) {
    const value = source[param.name];
    if (param.kind === "number") {
      let normalized = num(value, Number(param.default));
      if (param.min !== undefined) normalized = Math.max(param.min, normalized);
      if (param.max !== undefined) normalized = Math.min(param.max, normalized);
      out[param.name] = normalized;
    } else if (param.kind === "select") {
      const candidate = String(value ?? param.default);
      out[param.name] = param.options?.some(
        (option) => option.value === candidate,
      )
        ? candidate
        : param.default;
    } else {
      out[param.name] =
        typeof value === "string" || typeof value === "number"
          ? String(value)
          : param.default;
    }
  }
  if (def.id === "array") {
    const itemType = String(out.itemType ?? "string");
    const itemDef = getFieldType(itemType);
    out.itemType =
      itemDef && !["object", "array", "derived"].includes(itemType)
        ? itemType
        : "string";
    const min = Math.trunc(num(out.minItems, 1));
    const max = Math.trunc(num(out.maxItems, 3));
    out.minItems = Math.min(min, max);
    out.maxItems = Math.max(min, max);
  }
  if (def.id === "string") out.length = parseLengths(out.length).join(",");
  if (
    (def.id === "date" || def.id === "derived") &&
    !validTimeZone(String(out.timezone ?? "local"))
  ) {
    out.timezone = "local";
  }
  return out;
}

function sanitizeFieldList(raw: unknown): MockField[] {
  if (!Array.isArray(raw)) return [];
  const out: MockField[] = [];
  const seenKeys = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const requestedType = String(source.type ?? "");
    const type = TYPE_ALIASES[requestedType] ?? requestedType;
    const def = getFieldType(type);
    if (!def) continue;
    const key =
      typeof source.key === "string" && source.key.trim()
        ? source.key.trim()
        : nextKey(def.defaultKey, seenKeys);
    seenKeys.add(key);
    const rawConstraints =
      source.constraints && typeof source.constraints === "object"
        ? (source.constraints as Record<string, unknown>)
        : source;
    const field: MockField = {
      id: typeof source.id === "string" && source.id ? source.id : nextRowId(),
      key,
      type: def.id,
      params: sanitizeParams(def, source.params),
      constraints: {
        nullRate: Math.min(Math.max(num(rawConstraints.nullRate, 0), 0), 1),
        unique:
          rawConstraints.unique === true ||
          rawConstraints.unique === "true" ||
          rawConstraints.unique === 1,
        invalidRate: Math.min(
          Math.max(num(rawConstraints.invalidRate, 0), 0),
          1,
        ),
      },
    };
    if (typeof source.label === "string" && source.label.trim()) {
      field.label = source.label.trim();
    }
    if (typeof source.enabled === "boolean") field.enabled = source.enabled;
    const rawParams =
      source.params && typeof source.params === "object"
        ? (source.params as Record<string, unknown>)
        : {};
    const children = source.children ?? source.fields ?? rawParams.children;
    if (
      def.id === "object" ||
      (def.id === "array" && Array.isArray(children))
    ) {
      field.children = sanitizeFieldList(children);
    }
    if (def.id === "array" && source.itemType !== undefined) {
      field.params = sanitizeParams(def, {
        ...rawParams,
        itemType: source.itemType,
      });
    }
    out.push(field);
  }
  return out;
}

/** 递归清洗持久化字段，迁移旧类型/children/约束写法并回退非法参数。 */
export function sanitizeFields(raw: unknown): MockField[] {
  return sanitizeFieldList(raw);
}

const NUMERIC_DEFAULTS: Record<string, NumericDefaults> = {
  int: { min: 1, max: 1000, precision: 0, integer: true },
  float: { min: 0, max: 1000, precision: 2, integer: false },
  age: { min: 18, max: 60, precision: 0, integer: true },
  salary: { min: 5000, max: 30000, precision: 0, integer: true },
  price: { min: 1, max: 9999, precision: 2, integer: false },
  budget: { min: 100000, max: 50000000, precision: 2, integer: false },
  bondAmount: { min: 5000, max: 500000, precision: 2, integer: false },
  moneyCn: { min: 10000, max: 10000000, precision: 2, integer: false },
  score: { min: 60, max: 100, precision: 1, integer: false },
};

function invalidValue(field: MockField, ctx: GenContext): unknown {
  const invalid: Record<string, unknown> = {
    increment: "not-a-number",
    int: "not-a-number",
    float: "not-a-number",
    age: "not-a-number",
    salary: "not-a-number",
    price: "not-a-number",
    budget: "not-a-number",
    bondAmount: "not-a-number",
    score: "not-a-number",
    moneyCn: "not-a-money-value",
    boolean: "not-a-boolean",
    enum: "__invalid__",
    string: "\u0000invalid",
    date: "not-a-date",
    openBidTime: "not-a-date",
    derived: "invalid-derived",
    object: "invalid-object",
    array: "invalid-array",
    name: "",
    gender: "unknown",
    phone: "123",
    idCard: "123456",
    email: "invalid-email",
    address: "",
    company: "",
    uscc: "INVALID-USCC",
    bankCard: "1234",
    uuid: "not-a-uuid",
    ip: "999.999.999.999",
    mac: "invalid-mac",
    url: "not a url",
    domain: "invalid domain",
    color: "#XYZ",
  };
  if (field.type === "phone" && contextLocale(ctx) === "en-US") return "+1-000";
  return invalid[field.type] ?? `invalid-${field.type}`;
}

function boundaryValue(field: MockField, ctx: GenContext): unknown {
  const numeric = NUMERIC_DEFAULTS[field.type];
  if (numeric) {
    const value = numericBoundary(field.params, ctx, numeric);
    return field.type === "moneyCn" ? toChineseCapital(value) : value;
  }
  if (
    field.type === "increment" ||
    field.type === "fixed" ||
    field.type === "derived"
  ) {
    return getFieldType(field.type)?.generate(field.params, ctx);
  }
  if (field.type === "boolean") return ctx.index % 2 === 0;
  if (field.type === "enum") {
    const values = enumValues(field.params.values);
    return values.length
      ? values[ctx.index % 2 === 0 ? 0 : values.length - 1]
      : "";
  }
  if (field.type === "string") {
    const lengths = parseLengths(field.params.length);
    const length =
      ctx.index % 2 === 0 ? Math.min(...lengths) : Math.max(...lengths);
    const charset =
      CHARSETS[str(field.params.charset, "alnum")] ?? CHARSETS.alnum;
    return charset[0].repeat(length);
  }
  if (field.type === "date") {
    const useStart = ctx.index % 2 === 0;
    const timestamp = useStart
      ? dateParam(field.params.start, "2020-01-01")
      : dateParam(
          field.params.end,
          new Date(ctx.now ?? Date.now()).toISOString(),
        );
    return formatDateTime(
      new Date(timestamp),
      str(field.params.format, "date"),
      str(field.params.timezone, "local"),
    );
  }
  if (field.type === "uuid") {
    return ctx.index % 2 === 0
      ? "00000000-0000-4000-8000-000000000000"
      : "ffffffff-ffff-4fff-bfff-ffffffffffff";
  }
  if (field.type === "ip")
    return ctx.index % 2 === 0 ? "0.0.0.0" : "255.255.255.255";
  if (field.type === "phone") {
    return contextLocale(ctx) === "zh-CN"
      ? ctx.index % 2 === 0
        ? "13000000000"
        : "19999999999"
      : ctx.index % 2 === 0
        ? "+1-202-555-0000"
        : "+1-917-555-9999";
  }
  if (field.type === "email")
    return ctx.index % 2 === 0 ? "a@example.com" : "boundary.user@example.com";
  return getFieldType(field.type)?.generate(field.params, ctx);
}

interface GenerationState {
  rng: RandomSource;
  locale: LocaleId;
  scenario: MockScenario;
  now: number;
  uniqueValues: Map<string, Set<string>>;
}

function uniqueKey(value: unknown): string {
  return `${typeof value}:${JSON.stringify(value) ?? String(value)}`;
}

function generateRaw(
  field: MockField,
  ctx: GenContext,
  state: GenerationState,
  path: string,
): unknown {
  if (field.type === "object") {
    const object: Record<string, unknown> = {};
    const childCtx: GenContext = { ...ctx, row: object };
    for (const child of field.children ?? []) {
      if (!child.key) continue;
      object[child.key] = generateConstrained(
        child,
        childCtx,
        state,
        `${path}.${child.key}`,
      );
    }
    return object;
  }
  if (field.type === "array") {
    const min = Math.max(0, Math.trunc(num(field.params.minItems, 1)));
    const max = Math.max(min, Math.trunc(num(field.params.maxItems, 3)));
    const length =
      ctx.scenario === "boundary"
        ? ctx.index % 2 === 0
          ? min
          : max
        : randomInt(min, max, state.rng);
    const array: unknown[] = [];
    for (let itemIndex = 0; itemIndex < length; itemIndex += 1) {
      const itemPath = `${path}[${itemIndex}]`;
      if (Array.isArray(field.children)) {
        const object: Record<string, unknown> = {};
        const childCtx: GenContext = { ...ctx, row: object };
        for (const child of field.children) {
          if (!child.key) continue;
          object[child.key] = generateConstrained(
            child,
            childCtx,
            state,
            `${itemPath}.${child.key}`,
          );
        }
        array.push(object);
      } else {
        const itemType = getFieldType(str(field.params.itemType, "string"));
        const itemField: MockField = {
          id: `${field.id}_item`,
          key: field.key,
          type:
            itemType && !["object", "array", "derived"].includes(itemType.id)
              ? itemType.id
              : "string",
          params: {},
        };
        array.push(generateConstrained(itemField, ctx, state, itemPath));
      }
    }
    return array;
  }
  const def = getFieldType(field.type);
  return def ? def.generate(field.params, ctx) : undefined;
}

function generateConstrained(
  field: MockField,
  ctx: GenContext,
  state: GenerationState,
  path: string,
): unknown {
  const nullRate = Math.min(
    Math.max(num(field.constraints?.nullRate, 0), 0),
    1,
  );
  if (nullRate > 0 && state.rng() < nullRate) return null;
  const invalidRate = Math.min(
    Math.max(num(field.constraints?.invalidRate, 0), 0),
    1,
  );
  const unique = field.constraints?.unique === true;
  const uniqueScope = field.id ? `id:${field.id}` : path;
  let seen = unique ? state.uniqueValues.get(uniqueScope) : undefined;
  if (unique && !seen) {
    seen = new Set<string>();
    state.uniqueValues.set(uniqueScope, seen);
  }
  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
    let value: unknown;
    if (
      state.scenario === "invalid" ||
      (invalidRate > 0 && state.rng() < invalidRate)
    ) {
      value = invalidValue(field, ctx);
    } else if (
      state.scenario === "boundary" &&
      field.type !== "object" &&
      field.type !== "array"
    ) {
      value = boundaryValue(field, ctx);
    } else {
      value = generateRaw(field, ctx, state, path);
    }
    if (!unique || value === null) return value;
    const key = uniqueKey(value);
    if (!seen?.has(key)) {
      seen?.add(key);
      return value;
    }
  }
  throw new Error(
    `字段「${path}」在第 ${ctx.index} 行生成唯一值失败：${MAX_UNIQUE_ATTEMPTS} 次重试后仍发生冲突`,
  );
}

function normalizedCount(count: number): number {
  return Math.min(
    Math.max(Math.trunc(Number.isFinite(count) ? count : 1), 1),
    MAX_ROWS,
  );
}

function normalizedStartIndex(startIndex: number | undefined): number {
  const valid =
    typeof startIndex === "number" && Number.isFinite(startIndex)
      ? startIndex
      : 0;
  return Math.max(0, Math.trunc(valid));
}

function createState(options: GenerateOptions): GenerationState {
  return {
    rng: createRandom(options.seed),
    locale: options.locale === "en-US" ? "en-US" : "zh-CN",
    scenario: ["normal", "boundary", "invalid", "timeSeries"].includes(
      options.scenario ?? "",
    )
      ? (options.scenario as MockScenario)
      : "normal",
    now: options.seed === undefined ? Date.now() : SEEDED_REFERENCE_TIME,
    uniqueValues: new Map(),
  };
}

function generateOneRow(
  fields: readonly MockField[],
  index: number,
  previousRow: Record<string, unknown> | undefined,
  state: GenerationState,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const ctx: GenContext = {
    index,
    rng: state.rng,
    row,
    previousRow,
    locale: state.locale,
    scenario: state.scenario,
    now: state.now,
  };
  for (const field of fields) {
    if (!field.key || !getFieldType(field.type)) continue;
    row[field.key] = generateConstrained(field, ctx, state, field.key);
  }
  return row;
}

/**
 * 批量生成数据行。startIndex 之前的行会在内部生成并丢弃，因此其 RNG、previousRow
 * 和 unique 状态与一次生成后切片完全等价。
 */
export function generateRows(
  fields: readonly MockField[],
  count: number,
  options: GenerateOptions = {},
): Record<string, unknown>[] {
  const total = normalizedCount(count);
  const startIndex = normalizedStartIndex(options.startIndex);
  const state = createState(options);
  const rows: Record<string, unknown>[] = [];
  let previousRow: Record<string, unknown> | undefined;
  for (let index = 0; index < startIndex + total; index += 1) {
    const row = generateOneRow(fields, index, previousRow, state);
    if (index >= startIndex) rows.push(row);
    previousRow = row;
  }
  return rows;
}

/** 分批生成；所有批次共享 RNG 与 unique 状态，且每个批次使用独立数组。 */
export async function* generateRowBatches(
  fields: readonly MockField[],
  count: number,
  options: GenerateOptions = {},
  batchSize = 250,
): AsyncGenerator<Record<string, unknown>[]> {
  const total = normalizedCount(count);
  const startIndex = normalizedStartIndex(options.startIndex);
  const size = Math.min(
    Math.max(Math.trunc(Number.isFinite(batchSize) ? batchSize : 250), 1),
    MAX_ROWS,
  );
  const state = createState(options);
  let previousRow: Record<string, unknown> | undefined;
  let batch: Record<string, unknown>[] = [];
  for (let index = 0; index < startIndex + total; index += 1) {
    const row = generateOneRow(fields, index, previousRow, state);
    previousRow = row;
    if (index < startIndex) continue;
    batch.push(row);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
