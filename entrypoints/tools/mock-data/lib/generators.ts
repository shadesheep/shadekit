/**
 * 模拟数据工具的字段类型注册表与批量生成入口。
 *
 * 每种字段类型以 FieldTypeDef 声明：参数 schema（供 UI 动态渲染）+
 * generate 函数。UI 输入的参数统一为 string|number，生成器内部用
 * num()/str() 容错取值，保证非法输入不会中断整批生成。
 */
import {
  CURRENCIES,
  DEPARTMENTS,
  DOMAIN_SUFFIXES,
  EMAIL_DOMAINS,
  EVAL_METHODS,
  FILE_EXTENSIONS,
  MIME_TYPES,
  POSITIONS,
  SECTION_NAMES,
  TENDER_METHODS,
  USER_AGENTS,
  generateAddress,
  generateBankCard,
  generateCompany,
  generateIdCard,
  generateName,
  generateProjectName,
  generateUrl,
  generateUscc,
  pick,
  randomDigits,
  randomFloat,
  randomInt,
  randomString,
  toChineseCapital,
} from './data-pools';
import type {
  CategoryDef,
  FieldTypeDef,
  GenContext,
  MockField,
} from './types';

// ─── 参数容错取值 ───────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
  return s || fallback;
}

/** 解析可能为 JSON 字面量的文本：'123'→123、'true'→true，失败回退原字符串 */
function parseLiteral(raw: string): unknown {
  const s = raw.trim();
  if (!s) return '';
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** 枚举文本 → 候选数组：支持逗号（中英文）、顿号、竖线、空白分隔 */
export function parseEnumValues(raw: string): unknown[] {
  return raw
    .split(/[,，、|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseLiteral);
}

// ─── 日期格式化 ─────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDateTime(d: Date, format: string): string | number {
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  switch (format) {
    case 'datetime':
      return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    case 'timestamp':
      return d.getTime();
    case 'timestamp_s':
      return Math.floor(d.getTime() / 1000);
    default:
      return date;
  }
}

function randomDateBetween(startRaw: unknown, endRaw: unknown): Date {
  const start = new Date(str(startRaw, '2020-01-01'));
  const startMs = Number.isNaN(start.getTime())
    ? new Date('2020-01-01').getTime()
    : start.getTime();
  const endStr = str(endRaw, '');
  const end = endStr ? new Date(endStr) : new Date();
  const endMs = Number.isNaN(end.getTime()) ? Date.now() : end.getTime();
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  return new Date(lo + Math.random() * (hi - lo));
}

// ─── 字符集 ─────────────────────────────────────────────────

const CHARSETS: Record<string, string> = {
  alnum: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numeric: '0123456789',
  hex: '0123456789abcdef',
  cn: '的一是不了我在人有他这中大来上个国和地说到为子时年得出就那要和会可也你对生能而子那好于心得着然没都成看只发当平地们道还实做作种开面总事',
};

// ─── 分类与字段类型注册表 ────────────────────────────────────

export const CATEGORIES: CategoryDef[] = [
  { id: 'basic', label: '基础', icon: 'i-lucide-sliders-horizontal' },
  { id: 'person', label: '人员', icon: 'i-lucide-user' },
  { id: 'business', label: '企业', icon: 'i-lucide-building-2' },
  { id: 'tender', label: '招投标', icon: 'i-lucide-gavel' },
  { id: 'tech', label: '技术', icon: 'i-lucide-cpu' },
];

export const FIELD_TYPES: FieldTypeDef[] = [
  // ── 基础 ──
  {
    id: 'increment',
    label: '自增序号',
    category: 'basic',
    defaultKey: 'id',
    params: [
      { name: 'start', label: '起始', kind: 'number', default: 1 },
      { name: 'step', label: '步长', kind: 'number', default: 1 },
      { name: 'pad', label: '补零位数', kind: 'number', default: 0, min: 0, max: 12 },
    ],
    generate: (p, ctx) => {
      const value = num(p.start, 1) + ctx.index * num(p.step, 1);
      const pad = Math.trunc(num(p.pad, 0));
      return pad > 0 ? String(value).padStart(pad, '0') : value;
    },
  },
  {
    id: 'fixed',
    label: '固定值',
    category: 'basic',
    defaultKey: 'fixed',
    params: [
      {
        name: 'value',
        label: '值',
        kind: 'text',
        default: '',
        placeholder: '支持 JSON 字面量，如 123 / true / [1,2]',
      },
    ],
    generate: (p) => parseLiteral(String(p.value ?? '')),
  },
  {
    id: 'int',
    label: '随机整数',
    category: 'basic',
    defaultKey: 'num',
    params: [
      { name: 'min', label: '最小', kind: 'number', default: 1 },
      { name: 'max', label: '最大', kind: 'number', default: 1000 },
    ],
    generate: (p) => randomInt(num(p.min, 1), num(p.max, 1000)),
  },
  {
    id: 'float',
    label: '随机小数',
    category: 'basic',
    defaultKey: 'amount',
    params: [
      { name: 'min', label: '最小', kind: 'number', default: 0 },
      { name: 'max', label: '最大', kind: 'number', default: 1000 },
      { name: 'precision', label: '小数位', kind: 'number', default: 2, min: 0, max: 6 },
    ],
    generate: (p) =>
      randomFloat(num(p.min, 0), num(p.max, 1000), num(p.precision, 2)),
  },
  {
    id: 'boolean',
    label: '布尔值',
    category: 'basic',
    defaultKey: 'flag',
    params: [],
    generate: () => Math.random() < 0.5,
  },
  {
    id: 'enum',
    label: '枚举值',
    category: 'basic',
    defaultKey: 'status',
    params: [
      {
        name: 'values',
        label: '候选值',
        kind: 'text',
        default: '草稿,已提交,已审核',
        placeholder: '以逗号/空格/竖线分隔',
      },
    ],
    generate: (p) => {
      const values = parseEnumValues(String(p.values ?? ''));
      return values.length ? pick(values) : '';
    },
  },
  {
    id: 'string',
    label: '随机字符串',
    category: 'basic',
    defaultKey: 'text',
    params: [
      { name: 'length', label: '长度', kind: 'number', default: 8, min: 1, max: 200 },
      {
        name: 'charset',
        label: '字符集',
        kind: 'select',
        default: 'alnum',
        options: [
          { value: 'alnum', label: '字母+数字' },
          { value: 'alpha', label: '纯字母' },
          { value: 'numeric', label: '纯数字' },
          { value: 'hex', label: '十六进制' },
          { value: 'cn', label: '中文' },
        ],
      },
    ],
    generate: (p) => {
      const len = Math.min(Math.max(Math.trunc(num(p.length, 8)), 1), 200);
      const cs = CHARSETS[str(p.charset, 'alnum')] ?? CHARSETS.alnum;
      return randomString(len, cs);
    },
  },
  {
    id: 'date',
    label: '日期时间',
    category: 'basic',
    defaultKey: 'date',
    params: [
      { name: 'start', label: '起始', kind: 'text', default: '2020-01-01', placeholder: 'YYYY-MM-DD' },
      { name: 'end', label: '截止', kind: 'text', default: '', placeholder: '留空为今天' },
      {
        name: 'format',
        label: '格式',
        kind: 'select',
        default: 'date',
        options: [
          { value: 'date', label: 'YYYY-MM-DD' },
          { value: 'datetime', label: 'YYYY-MM-DD HH:mm:ss' },
          { value: 'timestamp', label: '时间戳(毫秒)' },
          { value: 'timestamp_s', label: '时间戳(秒)' },
        ],
      },
    ],
    generate: (p) =>
      formatDateTime(randomDateBetween(p.start, p.end), str(p.format, 'date')),
  },

  // ── 人员 ──
  {
    id: 'name',
    label: '姓名',
    category: 'person',
    defaultKey: 'name',
    params: [],
    generate: () => generateName(),
  },
  {
    id: 'gender',
    label: '性别',
    category: 'person',
    defaultKey: 'gender',
    params: [],
    generate: () => (Math.random() < 0.5 ? '男' : '女'),
  },
  {
    id: 'age',
    label: '年龄',
    category: 'person',
    defaultKey: 'age',
    params: [
      { name: 'min', label: '最小', kind: 'number', default: 18 },
      { name: 'max', label: '最大', kind: 'number', default: 60 },
    ],
    generate: (p) => randomInt(num(p.min, 18), num(p.max, 60)),
  },
  {
    id: 'phone',
    label: '手机号',
    category: 'person',
    defaultKey: 'phone',
    params: [],
    generate: () => {
      const prefixes = [
        '130', '131', '132', '133', '135', '136', '137', '138', '139',
        '150', '151', '152', '155', '156', '157', '158', '159',
        '166', '175', '176', '177', '178',
        '180', '181', '182', '183', '185', '186', '187', '188', '189',
        '191', '198', '199',
      ];
      return pick(prefixes) + randomDigits(8);
    },
  },
  {
    id: 'idCard',
    label: '身份证号',
    category: 'person',
    defaultKey: 'idCard',
    params: [],
    generate: () => generateIdCard(),
  },
  {
    id: 'email',
    label: '邮箱',
    category: 'person',
    defaultKey: 'email',
    params: [],
    generate: () =>
      `${randomString(randomInt(6, 12), 'abcdefghijklmnopqrstuvwxyz0123456789')}@${pick(EMAIL_DOMAINS)}`,
  },
  {
    id: 'address',
    label: '地址',
    category: 'person',
    defaultKey: 'address',
    params: [],
    generate: () => generateAddress(),
  },

  // ── 企业 ──
  {
    id: 'company',
    label: '公司名称',
    category: 'business',
    defaultKey: 'company',
    params: [],
    generate: () => generateCompany(),
  },
  {
    id: 'uscc',
    label: '统一社会信用代码',
    category: 'business',
    defaultKey: 'uscc',
    params: [],
    generate: () => generateUscc(),
  },
  {
    id: 'department',
    label: '部门',
    category: 'business',
    defaultKey: 'department',
    params: [],
    generate: () => pick(DEPARTMENTS),
  },
  {
    id: 'position',
    label: '职位',
    category: 'business',
    defaultKey: 'position',
    params: [],
    generate: () => pick(POSITIONS),
  },
  {
    id: 'salary',
    label: '薪资',
    category: 'business',
    defaultKey: 'salary',
    params: [
      { name: 'min', label: '最小', kind: 'number', default: 5000 },
      { name: 'max', label: '最大', kind: 'number', default: 30000 },
    ],
    generate: (p) => randomInt(num(p.min, 5000), num(p.max, 30000)),
  },
  {
    id: 'bankCard',
    label: '银行卡号',
    category: 'business',
    defaultKey: 'bankCard',
    params: [],
    generate: () => generateBankCard(),
  },
  {
    id: 'price',
    label: '价格',
    category: 'business',
    defaultKey: 'price',
    params: [
      { name: 'min', label: '最小', kind: 'number', default: 1 },
      { name: 'max', label: '最大', kind: 'number', default: 9999 },
      { name: 'precision', label: '小数位', kind: 'number', default: 2, min: 0, max: 6 },
    ],
    generate: (p) =>
      randomFloat(num(p.min, 1), num(p.max, 9999), num(p.precision, 2)),
  },
  {
    id: 'currency',
    label: '货币代码',
    category: 'business',
    defaultKey: 'currency',
    params: [],
    generate: () => pick(CURRENCIES),
  },

  // ── 招投标 ──
  {
    id: 'projectName',
    label: '项目名称',
    category: 'tender',
    defaultKey: 'projectName',
    params: [],
    generate: () => generateProjectName(),
  },
  {
    id: 'projectCode',
    label: '项目编号',
    category: 'tender',
    defaultKey: 'projectCode',
    params: [
      { name: 'prefix', label: '前缀', kind: 'text', default: 'E' },
    ],
    generate: (p) => {
      const prefix = str(p.prefix, 'E').replace(/[^A-Za-z0-9]/g, '') || 'E';
      const now = new Date();
      const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
      return `${prefix}${ymd}${randomDigits(4)}`;
    },
  },
  {
    id: 'sectionName',
    label: '标段名称',
    category: 'tender',
    defaultKey: 'sectionName',
    params: [],
    generate: () => pick(SECTION_NAMES),
  },
  {
    id: 'sectionCode',
    label: '标段编号',
    category: 'tender',
    defaultKey: 'sectionCode',
    params: [
      { name: 'prefix', label: '前缀', kind: 'text', default: 'E' },
    ],
    generate: (p) => {
      const prefix = str(p.prefix, 'E').replace(/[^A-Za-z0-9]/g, '') || 'E';
      const now = new Date();
      const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
      return `${prefix}${ymd}${randomDigits(4)}-0${randomInt(1, 3)}`;
    },
  },
  {
    id: 'tenderMethod',
    label: '招标方式',
    category: 'tender',
    defaultKey: 'tenderMethod',
    params: [],
    generate: () => pick(TENDER_METHODS),
  },
  {
    id: 'evalMethod',
    label: '评标办法',
    category: 'tender',
    defaultKey: 'evalMethod',
    params: [],
    generate: () => pick(EVAL_METHODS),
  },
  {
    id: 'budget',
    label: '预算金额',
    category: 'tender',
    defaultKey: 'budget',
    params: [
      { name: 'min', label: '最小(元)', kind: 'number', default: 100000 },
      { name: 'max', label: '最大(元)', kind: 'number', default: 50000000 },
    ],
    generate: (p) => randomFloat(num(p.min, 100000), num(p.max, 50000000), 2),
  },
  {
    id: 'bondAmount',
    label: '投标保证金',
    category: 'tender',
    defaultKey: 'bondAmount',
    params: [
      { name: 'min', label: '最小(元)', kind: 'number', default: 5000 },
      { name: 'max', label: '最大(元)', kind: 'number', default: 500000 },
    ],
    generate: (p) => randomFloat(num(p.min, 5000), num(p.max, 500000), 2),
  },
  {
    id: 'moneyCn',
    label: '金额大写',
    category: 'tender',
    defaultKey: 'amountCn',
    params: [
      { name: 'min', label: '最小(元)', kind: 'number', default: 10000 },
      { name: 'max', label: '最大(元)', kind: 'number', default: 10000000 },
    ],
    generate: (p) =>
      toChineseCapital(randomFloat(num(p.min, 10000), num(p.max, 10000000), 2)),
  },
  {
    id: 'score',
    label: '评审得分',
    category: 'tender',
    defaultKey: 'score',
    params: [
      { name: 'min', label: '最低分', kind: 'number', default: 60 },
      { name: 'max', label: '最高分', kind: 'number', default: 100 },
    ],
    generate: (p) => randomFloat(num(p.min, 60), num(p.max, 100), 1),
  },
  {
    id: 'openBidTime',
    label: '开标时间',
    category: 'tender',
    defaultKey: 'openBidTime',
    params: [
      { name: 'days', label: '未来天数', kind: 'number', default: 30, min: 1, max: 365 },
    ],
    generate: (p) => {
      const days = Math.max(1, Math.trunc(num(p.days, 30)));
      const d = new Date(Date.now() + randomInt(1, days) * 86400000);
      // 开标时间通常为工作时段整点/半点
      d.setHours(pick([9, 10, 11, 14, 15, 16]), pick([0, 30]), 0, 0);
      return formatDateTime(d, 'datetime');
    },
  },

  // ── 技术 ──
  {
    id: 'uuid',
    label: 'UUID',
    category: 'tech',
    defaultKey: 'uuid',
    params: [],
    generate: () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
  },
  {
    id: 'ip',
    label: 'IP 地址',
    category: 'tech',
    defaultKey: 'ip',
    params: [],
    generate: () =>
      `${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`,
  },
  {
    id: 'mac',
    label: 'MAC 地址',
    category: 'tech',
    defaultKey: 'mac',
    params: [],
    generate: () => {
      const parts: string[] = [];
      for (let i = 0; i < 6; i++) {
        parts.push(randomString(2, '0123456789ABCDEF'));
      }
      return parts.join(':');
    },
  },
  {
    id: 'url',
    label: 'URL',
    category: 'tech',
    defaultKey: 'url',
    params: [],
    generate: () => generateUrl(),
  },
  {
    id: 'domain',
    label: '域名',
    category: 'tech',
    defaultKey: 'domain',
    params: [],
    generate: () =>
      `${randomString(randomInt(5, 12), 'abcdefghijklmnopqrstuvwxyz')}.${pick(DOMAIN_SUFFIXES)}`,
  },
  {
    id: 'userAgent',
    label: 'User-Agent',
    category: 'tech',
    defaultKey: 'userAgent',
    params: [],
    generate: () => pick(USER_AGENTS),
  },
  {
    id: 'token',
    label: 'Token',
    category: 'tech',
    defaultKey: 'token',
    params: [
      { name: 'length', label: '长度', kind: 'number', default: 32, min: 8, max: 128 },
    ],
    generate: (p) =>
      randomString(Math.min(Math.max(Math.trunc(num(p.length, 32)), 8), 128)),
  },
  {
    id: 'password',
    label: '随机密码',
    category: 'tech',
    defaultKey: 'password',
    params: [
      { name: 'length', label: '长度', kind: 'number', default: 12, min: 6, max: 64 },
    ],
    generate: (p) =>
      randomString(
        Math.min(Math.max(Math.trunc(num(p.length, 12)), 6), 64),
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*',
      ),
  },
  {
    id: 'color',
    label: '颜色值',
    category: 'tech',
    defaultKey: 'color',
    params: [],
    generate: () => `#${randomString(6, '0123456789ABCDEF')}`,
  },
  {
    id: 'filename',
    label: '文件名',
    category: 'tech',
    defaultKey: 'filename',
    params: [],
    generate: () =>
      `${randomString(randomInt(5, 12), 'abcdefghijklmnopqrstuvwxyz')}.${pick(FILE_EXTENSIONS)}`,
  },
  {
    id: 'mimeType',
    label: 'MIME 类型',
    category: 'tech',
    defaultKey: 'mimeType',
    params: [],
    generate: () => pick(MIME_TYPES),
  },
];

const TYPE_INDEX = new Map(FIELD_TYPES.map((t) => [t.id, t]));

export function getFieldType(typeId: string): FieldTypeDef | undefined {
  return TYPE_INDEX.get(typeId);
}

export function getCategoryLabel(categoryId: string): string {
  return CATEGORIES.find((c) => c.id === categoryId)?.label ?? categoryId;
}

/** 类型的默认参数对象 */
export function defaultParams(def: FieldTypeDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.params) out[p.name] = p.default;
  return out;
}

let rowSeq = 0;

/** 生成稳定行 id（同一页面会话内唯一即可） */
export function nextRowId(): string {
  rowSeq += 1;
  return `f_${Date.now().toString(36)}_${rowSeq}`;
}

/** 基于类型默认键名生成不重复的输出键名：name → name2 → name3 … */
export function nextKey(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}${i}`)) i += 1;
  return `${base}${i}`;
}

/** 依据类型创建一行字段配置（键名自动去重、参数取默认值） */
export function createField(
  typeId: string,
  existingKeys: ReadonlySet<string>,
): MockField | null {
  const def = getFieldType(typeId);
  if (!def) return null;
  return {
    id: nextRowId(),
    key: nextKey(def.defaultKey, existingKeys),
    type: def.id,
    params: defaultParams(def),
  };
}

/**
 * 清洗从存储恢复的字段配置：
 * - 丢弃已不存在的类型
 * - 补齐缺失 id / 默认参数
 */
export function sanitizeFields(raw: unknown): MockField[] {
  if (!Array.isArray(raw)) return [];
  const out: MockField[] = [];
  const seenKeys = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Partial<MockField>;
    const def = f.type ? getFieldType(f.type) : undefined;
    if (!def) continue;
    const key =
      typeof f.key === 'string' && f.key.trim()
        ? f.key.trim()
        : nextKey(def.defaultKey, seenKeys);
    seenKeys.add(key);
    out.push({
      id: typeof f.id === 'string' && f.id ? f.id : nextRowId(),
      key,
      type: def.id,
      params: { ...defaultParams(def), ...(f.params ?? {}) },
    });
  }
  return out;
}

/**
 * 批量生成数据行。
 * 调用方须保证 fields 非空且 key 已校验（UI 层负责查重/查空）。
 */
export function generateRows(
  fields: readonly MockField[],
  count: number,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const total = Math.min(Math.max(Math.trunc(count), 1), 1000);
  for (let i = 0; i < total; i++) {
    const ctx: GenContext = { index: i };
    const row: Record<string, unknown> = {};
    for (const field of fields) {
      const def = getFieldType(field.type);
      if (!def || !field.key) continue;
      row[field.key] = def.generate(field.params, ctx);
    }
    rows.push(row);
  }
  return rows;
}
