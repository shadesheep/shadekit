/**
 * 声明式字段注册表与批量生成入口。
 * 所有随机值均由 GenContext.rng 驱动；约束、场景和递归结构在统一包装层处理。
 */

import type { IdCardDate } from "./data-pools";
import {
  generateBankCard,
  generateIdCard,
  generateUscc,
  idCardBirthDateForAge,
  toChineseCapital,
} from "./data-pools";
import {
  DOMAIN_SUFFIXES,
  FILE_EXTENSIONS,
  generateUrl,
  MIME_TYPES,
  USER_AGENTS,
} from "./domains/tech";
import {
  generateProjectName,
  SECTION_NAMES,
  TENDER_METHODS,
} from "./domains/tender";
import {
  generateAddress,
  generateCompany,
  generateEmail,
  generateName,
  generatePhone,
  getLocaleData,
} from "./locales";
import type { RandomSource } from "./random";
import {
  createRandom,
  defaultRandom,
  pick,
  randomDigits,
  randomInt,
  randomString,
} from "./random";
import type {
  CategoryDef,
  DateCompareDirection,
  DateComparePrecision,
  DateComparisonRule,
  FieldParamDef,
  FieldTypeDef,
  GenContext,
  GenerateOptions,
  InputFormat,
  InputRule,
  InputValueType,
  LengthRule,
  LocaleId,
  MockField,
  MockScenario,
  NumericRule,
} from "./types";

export { createRandom } from "./random";
export const MAX_ROWS = 100000;
const MAX_UNIQUE_ATTEMPTS = 100;
export const SEEDED_REFERENCE_TIME = Date.UTC(2024, 0, 1, 9, 0, 0);

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
export function parseLengths(raw: unknown): number[] {
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

const EMOJI_CHARS = [
  "😀",
  "😂",
  "😊",
  "😎",
  "🤖",
  "🚀",
  "🌈",
  "🍀",
  "🎯",
  "💡",
  "📦",
  "🔒",
] as const;

/** 按 Unicode 码点计数；中文与 emoji 均计 1，与生成时写入的字符数一致。 */
export function charLength(value: string): number {
  return Array.from(value).length;
}

function randomStringOfLength(
  length: number,
  charset: string,
  rng: RandomSource,
): string {
  const size = Math.max(0, Math.trunc(length));
  if (charset === "emoji") {
    let out = "";
    for (let index = 0; index < size; index += 1) {
      out += pick(EMOJI_CHARS, rng);
    }
    return out;
  }
  return randomString(size, CHARSETS[charset] ?? CHARSETS.alnum, rng);
}

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

export interface NumericDefaults {
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

/** 本机 IANA 时区；无法获取时回退到运行环境本地时间。 */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

/** 校验并归一化生成上下文时区，非法值回退到本机时区。 */
export function normalizeTimeZone(raw?: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value && validTimeZone(value) ? value : localTimeZone();
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function dateParts(date: Date, timeZone = "local"): DateParts {
  if (timeZone === "local" || !validTimeZone(timeZone)) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      millisecond: date.getMilliseconds(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
    millisecond: date.getMilliseconds(),
  };
}

/** 把指定时区的墙上时间换算为时间戳；跨 DST 时取换算后的稳定时区偏移。 */
function epochFromParts(parts: DateParts, timeZone: string): number {
  if (timeZone === "local" || !validTimeZone(timeZone)) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ).getTime();
  }
  const base = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  const offsetAt = (instant: number) => {
    const observed = dateParts(new Date(instant), timeZone);
    const wholeSecond = instant - (((instant % 1000) + 1000) % 1000);
    return (
      Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
      ) - wholeSecond
    );
  };
  const firstOffset = offsetAt(base);
  const epoch = base - firstOffset;
  const offset = offsetAt(epoch);
  return offset === firstOffset ? epoch : base - offset;
}

/** 解析日期文本；无时区后缀的文本按指定时区的墙上时间解释。 */
export function parseDateTimeText(
  text: string,
  timeZone = "local",
): number | undefined {
  const source = text.trim();
  const match = source.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (match) {
    const parts: DateParts = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] ?? 0),
      minute: Number(match[5] ?? 0),
      second: Number(match[6] ?? 0),
      millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
    };
    if (
      parts.month < 1 ||
      parts.month > 12 ||
      parts.day < 1 ||
      parts.day > 31 ||
      parts.hour > 23 ||
      parts.minute > 59 ||
      parts.second > 59
    ) {
      return undefined;
    }
    return epochFromParts(parts, timeZone);
  }
  const parsed = Date.parse(source);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function formatDateTime(
  date: Date,
  format: string,
  timeZone = "local",
): string | number {
  if (format === "timestamp") return date.getTime();
  if (format === "timestamp_s") return Math.floor(date.getTime() / 1000);
  const parts = dateParts(date, validTimeZone(timeZone) ? timeZone : "local");
  const dateText = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  return format === "datetime"
    ? `${dateText} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`
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

const STEP_UNITS: Record<string, number> = {
  day: 86400000,
  hour: 3600000,
  minute: 60000,
  second: 1000,
};

function dateValue(params: Record<string, unknown>, ctx: GenContext): Date {
  const timeZone = str(params.timezone, "local");
  const workdays = str(params.workdays, "false") === "true";
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
  const sourceKey = String(
    (params.sourceKeys as Record<string, string> | undefined)?.source ?? "",
  );
  if (!sourceKey || !Object.hasOwn(ctx.row, sourceKey)) {
    throw new Error(
      `派生字段引用的来源字段「${sourceKey || "(空)"}」不存在或尚未生成`,
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
    const requestedZone = str(params.timezone, "local");
    const timeZone = validTimeZone(requestedZone) ? requestedZone : "local";
    const sourceInstant =
      source instanceof Date
        ? source.getTime()
        : typeof source === "number"
          ? source
          : parseDateTimeText(String(source), timeZone);
    if (sourceInstant === undefined || Number.isNaN(sourceInstant))
      throw new Error(`字段「${sourceKey}」不是有效日期`);
    const amount = num(params.amount, 1);
    const unit = str(params.unit, "day");
    const result = new Date(
      sourceInstant + amount * (STEP_UNITS[unit] ?? STEP_UNITS.day),
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
    return formatDateTime(result, format, timeZone);
  }
  if (typeof source === "object" && source !== null)
    return JSON.parse(JSON.stringify(source));
  return source;
}

/** 身份证按年龄来源反推出生日期、按性别来源决定顺序码奇偶，再补校验位。 */
function idCardValue(params: Record<string, unknown>, ctx: GenContext): string {
  const sourceKeys =
    (params.sourceKeys as Record<string, string> | undefined) ?? {};
  const rng = contextRng(ctx);
  let birthDate: IdCardDate | undefined;
  const ageKey = sourceKeys.age;
  if (ageKey) {
    const age = ctx.row[ageKey];
    if (
      typeof age !== "number" ||
      !Number.isInteger(age) ||
      age < 0 ||
      age > 150
    ) {
      throw new Error(
        `年龄来源「${ageKey}」的值「${String(age ?? "")}」无法生成身份证，需要 0 到 150 的整数`,
      );
    }
    const [year, month, day] = formatDateTime(
      new Date(ctx.now ?? Date.now()),
      "date",
      ctx.timeZone,
    )
      .toString()
      .split("-")
      .map(Number);
    birthDate = idCardBirthDateForAge(age, { year, month, day }, rng);
  }
  const genderKey = sourceKeys.gender;
  let male: boolean | undefined;
  if (genderKey) {
    const gender = ctx.row[genderKey];
    const data = getLocaleData(contextLocale(ctx));
    if (gender === data.male) male = true;
    else if (gender === data.female) male = false;
    else {
      throw new Error(
        `性别来源「${genderKey}」的值「${String(gender ?? "")}」无法生成身份证`,
      );
    }
  }
  return generateIdCard(rng, { birthDate, male });
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
          { value: "emoji", label: "Emoji" },
        ],
      },
    ],
    generate: (params, ctx) => {
      const rng = contextRng(ctx);
      return randomStringOfLength(
        pick(parseLengths(params.length), rng),
        str(params.charset, "alnum"),
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
      { name: "sourceKey", label: "来源字段", kind: "text", default: "" },
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
    sources: [{ name: "source", label: "来源字段", required: true }],
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
    sources: [
      { name: "age", label: "年龄来源", types: ["age", "int"] },
      { name: "gender", label: "性别来源", types: ["gender", "enum"] },
    ],
    generate: idCardValue,
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
    sources: [{ name: "region", label: "地区来源", types: ["address"] }],
    generate: (params, ctx) => {
      const regionKey = (
        params.sourceKeys as Record<string, string> | undefined
      )?.region;
      if (!regionKey)
        return generateProjectName(contextLocale(ctx), contextRng(ctx));
      const region = ctx.row[regionKey];
      if (typeof region !== "string" || !region.trim()) {
        throw new Error(`地区来源「${regionKey}」不是有效地址`);
      }
      return generateProjectName(contextLocale(ctx), contextRng(ctx), region);
    },
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
      const offset = randomInt(1, days, rng);
      const date = new Date((ctx.now ?? Date.now()) + offset * 86400000);
      date.setHours(
        pick([9, 10, 11, 14, 15, 16], rng),
        pick([0, 30], rng),
        0,
        0,
      );
      return formatDateTime(date, "datetime");
    },
  },
  {
    id: "registrationDeadline",
    label: "报名截止时间",
    category: "tender",
    defaultKey: "registrationDeadline",
    params: [
      {
        name: "days",
        label: "未来天数",
        kind: "number",
        default: 30,
        min: 1,
        max: 365,
      },
      {
        name: "timezone",
        label: "时区",
        kind: "text",
        default: "local",
        placeholder: "local / UTC / Asia/Shanghai",
      },
    ],
    generate: (params, ctx) => {
      const rng = contextRng(ctx);
      const days = Math.max(1, Math.trunc(num(params.days, 30)));
      const requestedZone = str(params.timezone, "local");
      const timeZone = validTimeZone(requestedZone) ? requestedZone : "local";
      const offset = randomInt(1, days, rng);
      const wall = dateParts(
        new Date((ctx.now ?? Date.now()) + offset * 86400000),
        timeZone,
      );
      const date = new Date(
        epochFromParts(
          {
            ...wall,
            hour: pick([9, 10, 11, 14, 15, 16], rng),
            minute: pick([0, 30], rng),
            second: 0,
            millisecond: 0,
          },
          timeZone,
        ),
      );
      return formatDateTime(date, "datetime", timeZone);
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
    constraints: { unique: false },
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
    if (def.id === "enum" && param.name === "values" && Array.isArray(value)) {
      out[param.name] = value.filter(
        (item) =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      );
      continue;
    }
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
    (def.id === "date" ||
      def.id === "derived" ||
      def.id === "registrationDeadline") &&
    !validTimeZone(String(out.timezone ?? "local"))
  ) {
    out.timezone = "local";
  }
  return out;
}

/** 保留原始数值，语义校验（区间/精度）留给界面报错，不静默纠正。 */
function sanitizeNumericRule(raw: unknown): NumericRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const rule: NumericRule = {};
  for (const name of ["min", "max", "precision"] as const) {
    const value = source[name];
    if (value === undefined || value === null || value === "") continue;
    const parsed =
      typeof value === "number" ? value : Number(String(value).trim());
    if (Number.isFinite(parsed)) rule[name] = parsed;
  }
  return Object.keys(rule).length ? rule : undefined;
}

/** 与数值规则同理：保留原始数字，语义校验交给界面报错。 */
function sanitizeLengthRule(raw: unknown): LengthRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const rule: LengthRule = {};
  for (const name of ["min", "max"] as const) {
    const value = source[name];
    if (value === undefined || value === null || value === "") continue;
    const parsed =
      typeof value === "number" ? value : Number(String(value).trim());
    if (Number.isFinite(parsed)) rule[name] = parsed;
  }
  return Object.keys(rule).length ? rule : undefined;
}

const INPUT_TYPES: Record<InputValueType, true> = {
  string: true,
  number: true,
  integer: true,
  boolean: true,
  object: true,
  array: true,
};
const INPUT_FORMATS: Record<InputFormat, true> = { email: true };

/** 布尔规则保留显式 false（关闭必填/不允许 null 等），避免被当成未配置。 */
function sanitizeInputRule(raw: unknown): InputRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const rule: InputRule = {};
  for (const name of ["required", "nullable", "nonEmpty"] as const) {
    if (typeof source[name] === "boolean") rule[name] = source[name];
  }
  if (
    typeof source.type === "string" &&
    INPUT_TYPES[source.type as InputValueType]
  ) {
    rule.type = source.type as InputValueType;
  }
  if (
    typeof source.format === "string" &&
    INPUT_FORMATS[source.format as InputFormat]
  ) {
    rule.format = source.format as InputFormat;
  }
  if (Array.isArray(source.enumValues) && source.enumValues.length) {
    try {
      rule.enumValues = JSON.parse(JSON.stringify(source.enumValues));
    } catch {
      // 非 JSON 值无法随模板持久化，忽略该规则。
    }
  }
  return Object.keys(rule).length ? rule : undefined;
}

const DATE_DIRECTIONS: Record<DateCompareDirection, true> = {
  after: true,
  before: true,
  notBefore: true,
  notAfter: true,
};
const DATE_PRECISIONS: Record<DateComparePrecision, true> = {
  day: true,
  hour: true,
  minute: true,
  second: true,
};

function sanitizeDateRule(
  raw: unknown,
  byId: ReadonlyMap<string, MockField>,
  byKey: ReadonlyMap<string, MockField | undefined>,
): DateComparisonRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const fieldId =
    typeof source.fieldId === "string" && source.fieldId
      ? source.fieldId
      : byKey.get(String(source.fieldKey ?? "").trim())?.id;
  if (!fieldId || !byId.has(fieldId)) return undefined;
  const direction = String(source.direction ?? "");
  const precision = String(source.precision ?? "");
  if (
    !DATE_DIRECTIONS[direction as DateCompareDirection] ||
    !DATE_PRECISIONS[precision as DateComparePrecision]
  ) {
    return undefined;
  }
  return {
    fieldId,
    direction: direction as DateCompareDirection,
    precision: precision as DateComparePrecision,
  };
}

function sanitizeFieldList(raw: unknown): MockField[] {
  if (!Array.isArray(raw)) return [];
  const out: MockField[] = [];
  const sourceKeysByField = new Map<string, Record<string, string>>();
  const rawDateRules = new Map<string, unknown>();
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
        unique:
          rawConstraints.unique === true ||
          rawConstraints.unique === "true" ||
          rawConstraints.unique === 1,
      },
    };
    const numericRule = sanitizeNumericRule(source.numericRule);
    const lengthRule = sanitizeLengthRule(source.lengthRule);
    if (lengthRule) field.lengthRule = lengthRule;
    if (numericRule) field.numericRule = numericRule;
    const inputRule = sanitizeInputRule(source.inputRule);
    if (inputRule) field.inputRule = inputRule;
    if (source.dateRule !== undefined) {
      rawDateRules.set(field.id, source.dateRule);
    }
    if (typeof source.label === "string" && source.label.trim()) {
      field.label = source.label.trim();
    }
    if (typeof source.enabled === "boolean") field.enabled = source.enabled;
    const explicitSourceIds = source.sourceFieldIds;
    if (
      explicitSourceIds &&
      typeof explicitSourceIds === "object" &&
      !Array.isArray(explicitSourceIds)
    ) {
      const ids: Record<string, string> = {};
      for (const [role, value] of Object.entries(explicitSourceIds)) {
        if (typeof value === "string" && value) ids[role] = value;
      }
      if (Object.keys(ids).length) field.sourceFieldIds = ids;
    }
    if (typeof source.sourceFieldId === "string" && source.sourceFieldId) {
      field.sourceFieldIds = {
        ...field.sourceFieldIds,
        source: source.sourceFieldId,
      };
    }
    const rawParams =
      source.params && typeof source.params === "object"
        ? (source.params as Record<string, unknown>)
        : {};
    const keyMap: Record<string, string> = {};
    const rawSources = source.sources;
    if (
      rawSources &&
      typeof rawSources === "object" &&
      !Array.isArray(rawSources)
    ) {
      for (const [role, value] of Object.entries(rawSources)) {
        if (typeof value === "string" && value.trim()) {
          keyMap[role] = value.trim();
        }
      }
    }
    if (def.id === "derived" && str(rawParams.sourceKey, "")) {
      keyMap.source = str(rawParams.sourceKey, "");
    }
    if (Object.keys(keyMap).length) {
      sourceKeysByField.set(field.id, keyMap);
    }
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
  const byKey = indexFieldsByKey(out);
  const byId = new Map(out.map((field) => [field.id, field]));
  for (const field of out) {
    const declared = getFieldType(field.type)?.sources ?? [];
    const keys = sourceKeysByField.get(field.id) ?? {};
    const resolved: Record<string, string> = {};
    for (const sourceDef of declared) {
      const explicit = field.sourceFieldIds?.[sourceDef.name];
      const bound = explicit ?? byKey.get(keys[sourceDef.name] ?? "")?.id;
      if (bound) resolved[sourceDef.name] = bound;
    }
    if (Object.keys(resolved).length) field.sourceFieldIds = resolved;
    else delete field.sourceFieldIds;
    // 旧 key 只用于载入时迁移，无法绑定的来源由用户重新选择。
    delete field.params.sourceKey;
  }
  for (const [fieldId, rawRule] of rawDateRules) {
    const field = byId.get(fieldId);
    const rule = sanitizeDateRule(rawRule, byId, byKey);
    if (field && rule) field.dateRule = rule;
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

/** 字段类型是否支持数值生成与校验规则。 */
export function isNumericFieldType(typeId: string): boolean {
  return Object.hasOwn(NUMERIC_DEFAULTS, typeId);
}

/** 数值类型的取样默认值（整数标记与缺省精度）。 */
export function numericDefaults(typeId: string): NumericDefaults | undefined {
  return NUMERIC_DEFAULTS[typeId];
}

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
    registrationDeadline: "not-a-date",
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
    // 边界模式：偶数行取最短长度、奇数行取最长长度（极端长度边界），
    // 但内容用随机字符填充，避免所有行输出同一静止串（如 aaaaaaaa）。
    const length =
      ctx.index % 2 === 0 ? Math.min(...lengths) : Math.max(...lengths);
    return randomStringOfLength(
      length,
      str(field.params.charset, "alnum"),
      ctx.rng ?? defaultRandom,
    );
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
  timeZone: string;
  uniqueValues: Map<string, Set<string>>;
  overrides?: Record<string, unknown>;
  omitFieldIds?: ReadonlySet<string>;
  lengthOverrides?: Record<string, number>;
}

interface PlannedField extends MockField {
  childPlan?: FieldPlan;
}

interface FieldPlan {
  keys: string[];
  ordered: PlannedField[];
  preserveKeyOrder: boolean;
}

interface DependencyError {
  path: string;
  message: string;
}

function indexFieldsByKey(fields: readonly MockField[]) {
  const enabled = new Map<string, MockField | undefined>();
  const disabled = new Map<string, MockField | undefined>();
  for (const field of fields) {
    const key = field.key.trim();
    if (!key) continue;
    const index = field.enabled === false ? disabled : enabled;
    index.set(key, index.has(key) ? undefined : field);
  }
  for (const [key, field] of disabled) {
    if (!enabled.has(key)) enabled.set(key, field);
  }
  return enabled;
}

/** 每个对象独立解析同级依赖，预先保存计算顺序和输出顺序。 */
function planFields(
  fields: readonly MockField[],
  errors: Map<string, DependencyError>,
  prefix = "",
): FieldPlan {
  const enabled = fields.filter(
    (field) => field.enabled !== false && field.key && getFieldType(field.type),
  );
  const byId = new Map(fields.map((field) => [field.id, field]));
  const byKey = indexFieldsByKey(fields);
  const ordered: PlannedField[] = [];
  const done = new Set<MockField>();
  const visiting = new Set<MockField>();
  const report = (field: MockField, message: string) =>
    errors.set(field.id, { path: prefix + field.key, message });

  function visit(field: MockField) {
    if (done.has(field)) return;
    if (visiting.has(field)) {
      const path = [...visiting];
      const cycle = path.slice(path.indexOf(field));
      const names = [...cycle, field].map((item) => item.key).join(" → ");
      for (const item of cycle) {
        report(item, `来源字段存在循环引用（${names}）`);
      }
      return;
    }

    visiting.add(field);
    let params = field.params;
    const declaredSources = getFieldType(field.type)?.sources ?? [];
    if (declaredSources.length) {
      const resolved: Record<string, string> = {};
      for (const sourceDef of declaredSources) {
        const explicitId = field.sourceFieldIds?.[sourceDef.name];
        const legacyKey =
          sourceDef.name === "source" ? str(params.sourceKey, "") : "";
        const source = explicitId ? byId.get(explicitId) : byKey.get(legacyKey);
        if (!source?.key.trim() || !getFieldType(source.type)) {
          if (sourceDef.required || explicitId || legacyKey) {
            report(
              field,
              explicitId || legacyKey
                ? `${sourceDef.label}不存在或字段名无效，请重新选择`
                : `请选择${sourceDef.label}`,
            );
          }
          continue;
        }
        if (source === field) {
          report(field, `${sourceDef.label}不能引用自身`);
          continue;
        }
        if (source.enabled === false) {
          report(field, `${sourceDef.label}「${source.key}」已禁用`);
          continue;
        }
        if (sourceDef.types && !sourceDef.types.includes(source.type)) {
          const types = sourceDef.types
            .map((typeId) => getFieldType(typeId)?.label ?? typeId)
            .join(" / ");
          report(
            field,
            `${sourceDef.label}「${source.key}」类型不兼容（需要 ${types}）`,
          );
          continue;
        }
        resolved[sourceDef.name] = source.key;
        visit(source);
      }
      params = { ...params, sourceKeys: resolved };
    }
    const childPlan =
      (field.type === "object" || field.type === "array") && field.children
        ? planFields(field.children, errors, `${prefix}${field.key}.`)
        : undefined;
    ordered.push({ ...field, params, childPlan });
    visiting.delete(field);
    done.add(field);
  }

  for (const field of enabled) visit(field);
  const keys = [...new Set(enabled.map((field) => field.key))];
  const objectKeys = Object.keys(
    Object.fromEntries(keys.map((key) => [key, null])),
  );
  return {
    keys,
    ordered,
    preserveKeyOrder: keys.some((key, index) => key !== objectKeys[index]),
  };
}

export function fieldDependencyErrors(
  fields: readonly MockField[],
): ReadonlyMap<string, DependencyError> {
  const errors = new Map<string, DependencyError>();
  planFields(fields, errors);
  return errors;
}

function prepareGeneration(fields: readonly MockField[]): FieldPlan {
  const errors = new Map<string, DependencyError>();
  const plan = planFields(fields, errors);
  const error = errors.values().next().value;
  if (error) throw new Error(`字段「${error.path}」：${error.message}`);
  return plan;
}

function uniqueKey(value: unknown): string {
  return `${typeof value}:${JSON.stringify(value) ?? String(value)}`;
}

function generateObject(
  plan: FieldPlan,
  ctx: GenContext,
  state: GenerationState,
  prefix: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null);
  const localCtx = { ...ctx, row: values };
  const emitted = new Set<string>();
  for (const field of plan.ordered) {
    if (state.omitFieldIds?.has(field.id)) continue;
    values[field.key] = generateConstrained(
      field,
      localCtx,
      state,
      prefix + field.key,
    );
    emitted.add(field.key);
  }
  const keys = plan.keys.filter((key) => emitted.has(key));
  const row = Object.fromEntries(keys.map((key) => [key, values[key]]));
  if (!plan.preserveKeyOrder) return row;

  // 普通对象会把整数索引键提前并按数值排序。
  return new Proxy(row, {
    ownKeys(target) {
      const remaining = new Set(Reflect.ownKeys(target));
      return [...keys.filter((key) => remaining.delete(key)), ...remaining];
    },
  });
}

/** 按指定个数生成数组；对象元素执行子字段及其依赖，空数组返回 []。 */
function generateArray(
  field: PlannedField,
  length: number,
  ctx: GenContext,
  state: GenerationState,
  path: string,
): unknown[] {
  const size = Math.max(0, Math.trunc(length));
  const array: unknown[] = [];
  for (let itemIndex = 0; itemIndex < size; itemIndex += 1) {
    const itemPath = `${path}[${itemIndex}]`;
    if (field.childPlan) {
      array.push(generateObject(field.childPlan, ctx, state, `${itemPath}.`));
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

function generateRaw(
  field: PlannedField,
  ctx: GenContext,
  state: GenerationState,
  path: string,
): unknown {
  if (field.type === "object") {
    return field.childPlan
      ? generateObject(field.childPlan, ctx, state, `${path}.`)
      : {};
  }
  if (field.type === "array") {
    const min = Math.max(0, Math.trunc(num(field.params.minItems, 1)));
    const max = Math.max(min, Math.trunc(num(field.params.maxItems, 3)));
    const length =
      state.lengthOverrides && Object.hasOwn(state.lengthOverrides, field.id)
        ? state.lengthOverrides[field.id]
        : ctx.scenario === "boundary"
          ? ctx.index % 2 === 0
            ? min
            : max
          : randomInt(min, max, state.rng);
    return generateArray(field, length, ctx, state, path);
  }
  const def = getFieldType(field.type);
  return def ? def.generate(field.params, ctx) : undefined;
}

function generateConstrained(
  field: PlannedField,
  ctx: GenContext,
  state: GenerationState,
  path: string,
): unknown {
  if (state.overrides && Object.hasOwn(state.overrides, field.id)) {
    return state.overrides[field.id];
  }
  if (state.lengthOverrides && Object.hasOwn(state.lengthOverrides, field.id)) {
    const length = state.lengthOverrides[field.id];
    if (field.type === "string") {
      return randomStringOfLength(
        length,
        str(field.params.charset, "alnum"),
        state.rng,
      );
    }
    if (field.type === "array") {
      return generateArray(field, length, ctx, state, path);
    }
  }
  const unique = field.constraints?.unique === true;
  const uniqueScope = field.id ? `id:${field.id}` : path;
  let seen = unique ? state.uniqueValues.get(uniqueScope) : undefined;
  if (unique && !seen) {
    seen = new Set<string>();
    state.uniqueValues.set(uniqueScope, seen);
  }
  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
    let value: unknown;
    try {
      if (state.scenario === "invalid") {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw message.startsWith("字段「")
        ? error
        : new Error(`字段「${path}」：${message}`);
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

/** seed 生成使用固定基准时刻，未指定 seed 时取当前时间。 */
export function generationReferenceTime(seed?: string): number {
  return seed === undefined ? Date.now() : SEEDED_REFERENCE_TIME;
}

function createState(options: GenerateOptions): GenerationState {
  return {
    rng: createRandom(options.seed),
    locale: options.locale === "en-US" ? "en-US" : "zh-CN",
    scenario: ["normal", "boundary", "invalid"].includes(options.scenario ?? "")
      ? (options.scenario as MockScenario)
      : "normal",
    uniqueValues: new Map(),
    now: generationReferenceTime(options.seed),
    timeZone: normalizeTimeZone(options.timeZone),
    overrides: options.overrides,
    omitFieldIds: options.omitFieldIds
      ? new Set(options.omitFieldIds)
      : undefined,
    lengthOverrides: options.lengthOverrides,
  };
}

function generateOneRow(
  plan: FieldPlan,
  index: number,
  previousRow: Record<string, unknown> | undefined,
  state: GenerationState,
): Record<string, unknown> {
  const ctx: GenContext = {
    index,
    rng: state.rng,
    row: {},
    previousRow,
    locale: state.locale,
    scenario: state.scenario,
    now: state.now,
    timeZone: state.timeZone,
  };
  return generateObject(plan, ctx, state, "");
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
  const plan = prepareGeneration(fields);
  const total = normalizedCount(count);
  const startIndex = normalizedStartIndex(options.startIndex);
  const state = createState(options);
  const rows: Record<string, unknown>[] = [];
  let previousRow: Record<string, unknown> | undefined;
  for (let index = 0; index < startIndex + total; index += 1) {
    const row = generateOneRow(plan, index, previousRow, state);
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
  const plan = prepareGeneration(fields);
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
    const row = generateOneRow(plan, index, previousRow, state);
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
