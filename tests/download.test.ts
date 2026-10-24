import { describe, expect, it } from 'vitest';
import { buildDownloadName } from '../entrypoints/shared/download';

describe('buildDownloadName', () => {
  it('拼接基础名与扩展名', () => {
    expect(buildDownloadName('formatted', 'json')).toBe('formatted.json');
  });

  it('带时间戳时生成 基础名-YYYYMMDD-HHmmss 格式', () => {
    const now = new Date(2026, 7, 13, 9, 5, 3); // 2026-08-13 09:05:03
    expect(buildDownloadName('formatted', 'json', now)).toBe(
      'formatted-20260813-090503.json',
    );
  });

  it('时间戳补零', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5); // 2026-01-02 03:04:05
    expect(buildDownloadName('data', 'json', now)).toBe(
      'data-20260102-030405.json',
    );
  });

  it('基础名为空时回退为 download', () => {
    expect(buildDownloadName('', 'json')).toBe('download.json');
    expect(buildDownloadName('  ', 'json')).toBe('download.json');
  });

  it('剔除基础名中非法文件名字符', () => {
    expect(buildDownloadName('a/b\\c:d*e?f"g<h>i|j', 'json')).toBe(
      'abcdefghij.json',
    );
  });
});
