import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 日志存储三维清理测试
 *
 * 覆盖：
 * - trimLogEntries：按条数 / 总字节 / 30 天年龄三维裁剪，保最新弃最旧，顺序不变
 * - truncateLogEntry：单条超大日志的分级截断策略
 * - 写入路径集成：logger 写入时自动应用三维清理
 */

// ---------------------------------------------------------------------------
// chrome.storage.local 内存 fake
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (k in store) out[k] = store[k];
        }
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
    },
  },
});

import {
  logger,
  getLogs,
  trimLogEntries,
  truncateLogEntry,
  LOG_TRIM_LIMITS,
  type LogEntry,
} from '../entrypoints/shared/logger';

const STORAGE_KEY = 'devtools-logs';

const utf8Bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

let seq = 0;
function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  seq += 1;
  return {
    id: `log_${seq}`,
    category: 'system',
    level: 'info',
    message: `message ${seq}`,
    timestamp: 1_000_000 + seq,
    ...overrides,
  };
}

beforeEach(() => {
  store = {};
  seq = 0;
});

// ---------------------------------------------------------------------------
// trimLogEntries 纯函数
// ---------------------------------------------------------------------------

describe('trimLogEntries', () => {
  const limits = {
    ...LOG_TRIM_LIMITS,
    maxEntries: 3,
    maxTotalBytes: 100 * 1024,
  };
  const NOW = 1_000_000_000;

  it('未超任何阈值时原样保留，顺序不变', () => {
    // 新→旧
    const entries = [
      makeEntry({ timestamp: NOW - 100 }),
      makeEntry({ timestamp: NOW - 200 }),
    ];
    const result = trimLogEntries(entries, limits, NOW);
    expect(result.map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it('超过最大条数时裁剪最旧，保留最新且顺序正确', () => {
    const entries = [
      makeEntry({ id: 'newest', timestamp: NOW - 100 }),
      makeEntry({ id: 'mid', timestamp: NOW - 200 }),
      makeEntry({ id: 'older', timestamp: NOW - 300 }),
      makeEntry({ id: 'oldest', timestamp: NOW - 400 }),
    ];
    const result = trimLogEntries(entries, limits, NOW);
    expect(result.map((e) => e.id)).toEqual(['newest', 'mid', 'older']);
  });

  it('超过 30 天年龄的日志被清除', () => {
    const entries = [
      makeEntry({ id: 'fresh', timestamp: NOW - 1000 }),
      makeEntry({
        id: 'expired',
        timestamp: NOW - limits.maxAgeMs - 1000,
      }),
    ];
    const result = trimLogEntries(entries, limits, NOW);
    expect(result.map((e) => e.id)).toEqual(['fresh']);
  });

  it('恰好处于年龄边界的日志保留', () => {
    const entries = [makeEntry({ timestamp: NOW - limits.maxAgeMs })];
    const result = trimLogEntries(entries, limits, NOW);
    expect(result).toHaveLength(1);
  });

  it('超过总字节数时从最旧开始裁剪，直到落入预算', () => {
    // 每条 message 约 500 字节 → 单条 JSON 约 560 字节
    const big = 'x'.repeat(500);
    const entries = [
      makeEntry({ id: 'newest', timestamp: NOW - 100, message: big }),
      makeEntry({ id: 'mid', timestamp: NOW - 200, message: big }),
      makeEntry({ id: 'oldest', timestamp: NOW - 300, message: big }),
    ];
    const tightLimits = { ...limits, maxEntries: 100, maxTotalBytes: 1200 };
    const result = trimLogEntries(entries, tightLimits, NOW);
    // 预算只够两条
    expect(result.map((e) => e.id)).toEqual(['newest', 'mid']);
  });

  it('即使唯一一条（最新）日志超过字节预算也保留', () => {
    const entries = [
      makeEntry({ id: 'newest', timestamp: NOW - 100, message: 'x'.repeat(5000) }),
      makeEntry({ id: 'oldest', timestamp: NOW - 200, message: 'x'.repeat(5000) }),
    ];
    const tightLimits = { ...limits, maxEntries: 100, maxTotalBytes: 100 };
    const result = trimLogEntries(entries, tightLimits, NOW);
    expect(result.map((e) => e.id)).toEqual(['newest']);
  });

  it('三维同时超限时全部生效', () => {
    const entries = [
      makeEntry({ id: 'a', timestamp: NOW - 100 }),
      makeEntry({ id: 'b', timestamp: NOW - 200 }),
      makeEntry({ id: 'c', timestamp: NOW - 300 }),
      makeEntry({ id: 'd', timestamp: NOW - 400 }),
      makeEntry({ id: 'expired', timestamp: NOW - limits.maxAgeMs - 1 }),
    ];
    const result = trimLogEntries(entries, limits, NOW);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// truncateLogEntry 单条截断
// ---------------------------------------------------------------------------

describe('truncateLogEntry', () => {
  const MAX = LOG_TRIM_LIMITS.maxEntryBytes;

  it('普通大小的日志原样返回', () => {
    const entry = makeEntry({ message: 'hello', error: 'boom' });
    expect(truncateLogEntry(entry)).toEqual(entry);
  });

  it('超长 message 被截断并带标记', () => {
    const entry = makeEntry({ message: 'm'.repeat(MAX * 2) });
    const result = truncateLogEntry(entry);
    expect(result.message.length).toBeLessThan(entry.message.length);
    expect(result.message).toContain('已截断');
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX);
  });

  it('CJK 多字节字符按 UTF-8 字节计量，截断后仍不超上限', () => {
    // '汉' 每字 3 字节（UTF-8），但 String.length 只算 1 —— 验证按真实字节截断
    const entry = makeEntry({ message: '汉'.repeat(MAX) });
    const result = truncateLogEntry(entry);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX);
  });

  it('超大 request/response 负载被替换为截断占位符', () => {
    const entry = makeEntry({
      message: 'ok',
      request: { body: 'r'.repeat(MAX * 2) },
      response: { body: 's'.repeat(MAX * 2) },
    });
    const result = truncateLogEntry(entry);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX);
    // 负载不再包含原始大字符串
    expect(JSON.stringify(result)).not.toContain('r'.repeat(1000));
    expect(JSON.stringify(result)).not.toContain('s'.repeat(1000));
  });

  it('超大 extra 字段被替换为截断占位符', () => {
    const entry = makeEntry({
      message: 'ok',
      extra: { dump: 'e'.repeat(MAX * 2) },
    });
    const result = truncateLogEntry(entry);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX);
    expect(JSON.stringify(result)).not.toContain('e'.repeat(1000));
  });

  it('截断后仍保留 id / category / level / timestamp 等关键字段', () => {
    const entry = makeEntry({
      category: 'auth',
      level: 'error',
      message: 'm'.repeat(MAX * 4),
      error: 'x'.repeat(MAX * 4),
    });
    const result = truncateLogEntry(entry);
    expect(result.id).toBe(entry.id);
    expect(result.category).toBe('auth');
    expect(result.level).toBe('error');
    expect(result.timestamp).toBe(entry.timestamp);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(MAX);
  });
});

// ---------------------------------------------------------------------------
// 写入路径集成：logger 写入时自动清理
// ---------------------------------------------------------------------------

describe('logger 写入时三维清理', () => {
  it('已有日志达到条数上限时，写入新日志裁掉最旧一条', async () => {
    const now = Date.now();
    const existing = Array.from({ length: LOG_TRIM_LIMITS.maxEntries }, (_, i) =>
      makeEntry({ id: `old_${i}`, timestamp: now - i * 1000 }),
    );
    store[STORAGE_KEY] = existing;

    await logger.info('brand new');

    const logs = await getLogs();
    expect(logs).toHaveLength(LOG_TRIM_LIMITS.maxEntries);
    expect(logs[0].message).toBe('brand new');
    // 最旧的一条被淘汰
    expect(logs.some((l) => l.id === `old_${LOG_TRIM_LIMITS.maxEntries - 1}`)).toBe(false);
    // 次新旧的仍在
    expect(logs.some((l) => l.id === `old_${LOG_TRIM_LIMITS.maxEntries - 2}`)).toBe(true);
  });

  it('写入时顺带清除超过 30 天的历史日志', async () => {
    const now = Date.now();
    store[STORAGE_KEY] = [
      makeEntry({ id: 'fresh', timestamp: now - 1000 }),
      makeEntry({
        id: 'expired',
        timestamp: now - LOG_TRIM_LIMITS.maxAgeMs - 60_000,
      }),
    ];

    await logger.info('trigger');

    const logs = await getLogs();
    expect(logs.some((l) => l.id === 'expired')).toBe(false);
    expect(logs.some((l) => l.id === 'fresh')).toBe(true);
    expect(logs[0].message).toBe('trigger');
  });

  it('写入超大日志时被截断，不会撑爆存储', async () => {
    await logger.error('boom', {
      error: 'e'.repeat(LOG_TRIM_LIMITS.maxEntryBytes * 4),
      extra: { dump: 'd'.repeat(LOG_TRIM_LIMITS.maxEntryBytes * 4) },
    });

    const logs = await getLogs();
    expect(logs).toHaveLength(1);
    expect(utf8Bytes(logs[0])).toBeLessThanOrEqual(
      LOG_TRIM_LIMITS.maxEntryBytes,
    );
  });

  it('总字节超限时丢弃最旧日志，最新日志完整保留', async () => {
    const now = Date.now();
    // 构造一批合计超过 maxTotalBytes 的历史日志
    const perEntry = 8 * 1024;
    const count = Math.ceil(LOG_TRIM_LIMITS.maxTotalBytes / perEntry) + 2;
    const existing = Array.from({ length: count }, (_, i) =>
      makeEntry({
        id: `bulk_${i}`,
        timestamp: now - i * 1000,
        message: 'x'.repeat(perEntry),
      }),
    );
    store[STORAGE_KEY] = existing;

    await logger.info('fresh entry');

    const logs = await getLogs();
    const totalBytes = JSON.stringify(logs).length;
    expect(logs[0].message).toBe('fresh entry');
    // 总大小应回落到预算附近（最新一条必保留，允许单条超出）
    expect(totalBytes).toBeLessThan(
      LOG_TRIM_LIMITS.maxTotalBytes + LOG_TRIM_LIMITS.maxEntryBytes + 1024,
    );
    // 最旧的若干条已被淘汰
    expect(logs.some((l) => l.id === `bulk_${count - 1}`)).toBe(false);
    // 顺序仍为新→旧
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i - 1].timestamp).toBeGreaterThanOrEqual(logs[i].timestamp);
    }
  });
});
