/**
 * 统一日志模块 — chrome.storage.local 持久化存储
 *
 * 合并所有日志系统为统一接口：
 * - auth: 认证流程日志
 * - script: 脚本执行日志
 * - ext: 扩展运行时日志
 * - system: 系统/控制台日志
 *
 * 使用 storage.local 而非内存，是因为 background service worker 和
 * options/popup 页面是不同的 JS 运行环境，无法共享内存。
 */

import { safeStorageSet } from "./safe-storage";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 日志类别 */
export type LogCategory = "auth" | "script" | "ext" | "system";

/** 日志级别 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 统一日志条目 */
export interface LogEntry {
  /** 唯一 ID */
  id: string;
  /** 日志类别 */
  category: LogCategory;
  /** 日志级别 */
  level: LogLevel;
  /** 日志消息 */
  message: string;
  /** 时间戳 */
  timestamp: number;
  /** 扩展 ID（ext 类别专用） */
  extId?: string;
  /** 账号信息（auth 类别专用） */
  account?: { name: string; username: string };
  /** 请求数据（调试用） */
  request?: unknown;
  /** 响应数据（调试用） */
  response?: unknown;
  /** 错误信息 */
  error?: string;
  /** 额外数据 */
  extra?: Record<string, unknown>;
}

/** 日志写入上下文 */
export interface LogContext {
  category?: LogCategory;
  extId?: string;
  account?: { name: string; username: string };
  request?: unknown;
  response?: unknown;
  error?: string;
  extra?: Record<string, unknown>;
}

/** 日志筛选条件 */
export interface LogFilter {
  categories?: LogCategory[];
  levels?: LogLevel[];
  startTime?: number;
  endTime?: number;
  keyword?: string;
  extId?: string;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const STORAGE_KEY = "devtools-logs";

/** 日志存储清理阈值（三维：条数 / 总字节 / 年龄，另加单条上限） */
export interface LogTrimLimits {
  /** 最大日志条数 */
  maxEntries: number;
  /** 全部日志总字节上限（超出即从最旧开始裁剪） */
  maxTotalBytes: number;
  /** 单条日志字节上限（超出即截断该条内容） */
  maxEntryBytes: number;
  /** 日志最大保留时长（毫秒），过期即清除 */
  maxAgeMs: number;
}

export const LOG_TRIM_LIMITS: LogTrimLimits = {
  maxEntries: 500,
  maxTotalBytes: 1024 * 1024, // 1 MB
  maxEntryBytes: 16 * 1024, // 16 KB
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 天
};

/** 超大负载被丢弃时的占位符 */
const TRUNCATED_PLACEHOLDER = "[内容过大，已截断]";

// ---------------------------------------------------------------------------
// 三维清理（纯函数，便于测试）
// ---------------------------------------------------------------------------

/** UTF-8 编码器（chrome.storage 按 UTF-8 字节计量配额，CJK 字符每字 3 字节） */
const textEncoder = new TextEncoder();

/** 估算单条日志的 UTF-8 字节数 */
function estimateEntryBytes(entry: LogEntry): number {
  try {
    return textEncoder.encode(JSON.stringify(entry)).length;
  } catch {
    // 存在循环引用等无法序列化的内容时视为超大，触发截断
    return Number.POSITIVE_INFINITY;
  }
}

/** 截断字符串到指定长度并附加标记 */
function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…(已截断)`;
}

/**
 * 截断单条超大日志，确保其序列化后不超过 maxEntryBytes。
 * 分级策略：先截断长文本字段 → 再替换大型负载（request/response）→
 * 再替换 extra → 最后兜底硬截断 message。关键字段（id/category/level/timestamp）始终保留。
 */
export function truncateLogEntry(
  entry: LogEntry,
  maxBytes: number = LOG_TRIM_LIMITS.maxEntryBytes,
): LogEntry {
  if (estimateEntryBytes(entry) <= maxBytes) return entry;

  // 截断长度按 maxBytes 比例推导，保证任意 maxBytes 下截断后都能落入上限
  const result: LogEntry = { ...entry };
  result.message = truncateString(result.message, Math.floor(maxBytes / 4));
  if (result.error) result.error = truncateString(result.error, Math.floor(maxBytes / 8));
  if (estimateEntryBytes(result) <= maxBytes) return result;

  if (result.request !== undefined) result.request = TRUNCATED_PLACEHOLDER;
  if (result.response !== undefined) result.response = TRUNCATED_PLACEHOLDER;
  if (estimateEntryBytes(result) <= maxBytes) return result;

  if (result.extra !== undefined) result.extra = { _truncated: true };
  if (estimateEntryBytes(result) <= maxBytes) return result;

  // 兜底：极端情况下硬截断剩余长文本
  result.message = truncateString(result.message, Math.floor(maxBytes / 8));
  if (result.error) result.error = truncateString(result.error, Math.floor(maxBytes / 16));
  return result;
}

/**
 * 按三维阈值清理日志列表（输入为新→旧排序，输出保持该顺序）：
 * 1. 清除超过 maxAgeMs 的过期日志
 * 2. 保留最新的 maxEntries 条
 * 3. 总字节超出 maxTotalBytes 时从最旧开始裁剪（最新一条始终保留）
 */
export function trimLogEntries(
  entries: LogEntry[],
  limits: LogTrimLimits = LOG_TRIM_LIMITS,
  now: number = Date.now(),
): LogEntry[] {
  const cutoff = now - limits.maxAgeMs;
  let kept = entries.filter((e) => e.timestamp >= cutoff);
  if (kept.length > limits.maxEntries) {
    kept = kept.slice(0, limits.maxEntries);
  }

  // 新→旧遍历，累计字节数，超出预算即丢弃剩余（更旧的）日志
  let totalBytes = 0;
  const result: LogEntry[] = [];
  for (const entry of kept) {
    const size = estimateEntryBytes(entry);
    if (result.length > 0 && totalBytes + size > limits.maxTotalBytes) break;
    totalBytes += size;
    result.push(entry);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 内部存储操作
// ---------------------------------------------------------------------------

async function readLogs(): Promise<LogEntry[]> {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  return (result[STORAGE_KEY] as LogEntry[]) || [];
}

/**
 * 持久化日志列表
 * 静默写入（notify: false）：日志系统自身失败不应弹提示干扰用户，
 * 且调用方 writeLog 本就有 try/catch 兜底
 * @returns 是否写入成功
 */
async function writeLogs(entries: LogEntry[]): Promise<boolean> {
  const result = await safeStorageSet({ [STORAGE_KEY]: entries }, { notify: false });
  return result.ok;
}

// ---------------------------------------------------------------------------
// 核心日志函数
// ---------------------------------------------------------------------------

/**
 * 写入一条日志（返回 Promise 以便测试/调用方等待写入完成；忽略返回值即 fire-and-forget）
 */
async function writeLog(
  level: LogLevel,
  message: string,
  ctx?: LogContext,
): Promise<void> {
  const entry = truncateLogEntry({
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    category: ctx?.category ?? "system",
    level,
    message,
    timestamp: Date.now(),
    extId: ctx?.extId,
    account: ctx?.account,
    request: ctx?.request,
    response: ctx?.response,
    error: ctx?.error,
    extra: ctx?.extra,
  });

  try {
    const entries = await readLogs();
    entries.unshift(entry);
    await writeLogs(trimLogEntries(entries));
  } catch {
    // 日志写入失败不影响主流程
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 统一日志接口
 *
 * @example
 * logger.info('用户登录成功', { category: 'auth', account: { name: '张三', username: 'zhangsan' } });
 * logger.error('脚本执行失败', { category: 'ext', extId: 'author@ext', error: 'timeout' });
 * logger.debug('API 响应', { category: 'system', extra: { status: 200 } });
 */
export const logger = {
  /** 调试级别日志 */
  debug(message: string, ctx?: LogContext): Promise<void> {
    return writeLog("debug", message, ctx);
  },

  /** 信息级别日志 */
  info(message: string, ctx?: LogContext): Promise<void> {
    return writeLog("info", message, ctx);
  },

  /** 警告级别日志 */
  warn(message: string, ctx?: LogContext): Promise<void> {
    return writeLog("warn", message, ctx);
  },

  /** 错误级别日志 */
  error(message: string, ctx?: LogContext): Promise<void> {
    return writeLog("error", message, ctx);
  },
};

/**
 * 获取日志列表
 */
export async function getLogs(filter?: LogFilter): Promise<LogEntry[]> {
  let entries = await readLogs();

  if (!filter) return entries;

  // 按类别筛选
  if (filter.categories?.length) {
    entries = entries.filter((e) => filter.categories!.includes(e.category));
  }

  // 按级别筛选
  if (filter.levels?.length) {
    entries = entries.filter((e) => filter.levels!.includes(e.level));
  }

  // 按时间范围筛选
  if (filter.startTime) {
    entries = entries.filter((e) => e.timestamp >= filter.startTime!);
  }
  if (filter.endTime) {
    entries = entries.filter((e) => e.timestamp <= filter.endTime!);
  }

  // 按关键词搜索
  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.message.toLowerCase().includes(kw) ||
        e.error?.toLowerCase().includes(kw) ||
        e.extId?.toLowerCase().includes(kw),
    );
  }

  // 按扩展 ID 筛选
  if (filter.extId) {
    entries = entries.filter((e) => e.extId === filter.extId);
  }

  return entries;
}

/**
 * 清空日志
 * @param category 指定类别则只清空该类别，否则清空全部
 * @returns 是否写入成功；失败时调用方可提示用户重试
 */
export async function clearLogs(category?: LogCategory): Promise<boolean> {
  if (!category) {
    return writeLogs([]);
  }

  const entries = await readLogs();
  const filtered = entries.filter((e) => e.category !== category);
  return writeLogs(filtered);
}

/**
 * 获取日志统计
 */
export async function getLogStats(): Promise<Record<LogCategory, number>> {
  const entries = await readLogs();
  const stats: Record<LogCategory, number> = {
    auth: 0,
    script: 0,
    ext: 0,
    system: 0,
  };
  for (const entry of entries) {
    stats[entry.category]++;
  }
  return stats;
}

/**
 * 导出日志为 JSON 字符串
 */
export async function exportLogs(filter?: LogFilter): Promise<string> {
  const entries = await getLogs(filter);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: entries.length,
      entries,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// 类别专用快捷方法
// ---------------------------------------------------------------------------

/**
 * 认证流程日志快捷方法
 */
export const authLog = {
  debug(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.debug(message, { ...ctx, category: "auth" });
  },
  info(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.info(message, { ...ctx, category: "auth" });
  },
  warn(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.warn(message, { ...ctx, category: "auth" });
  },
  error(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.error(message, { ...ctx, category: "auth" });
  },
};

/**
 * 系统日志快捷方法
 */
export const systemLog = {
  debug(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.debug(message, { ...ctx, category: "system" });
  },
  info(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.info(message, { ...ctx, category: "system" });
  },
  warn(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.warn(message, { ...ctx, category: "system" });
  },
  error(message: string, ctx?: Omit<LogContext, "category">): void {
    logger.error(message, { ...ctx, category: "system" });
  },
};
