import { describe, it, expect } from 'vitest';
import {
  validateDomainUrl,
  isDuplicateDomain,
  validateEntryUrl,
  validateMatchPath,
} from '../entrypoints/tools/account-switch/utils/validate-domain';
import type { DomainConfig } from '../entrypoints/tools/account-switch/types';

describe('validateDomainUrl', () => {
  it('接受合法 http/https URL', () => {
    expect(validateDomainUrl('http://localhost:8888')).toBeNull();
    expect(validateDomainUrl('https://example.com')).toBeNull();
    expect(validateDomainUrl('https://example.com/path?x=1')).toBeNull();
    expect(validateDomainUrl('http://192.168.1.1:8080')).toBeNull();
  });

  it('接受通配符子域名写法（matchDomain 支持的既有合法配置）', () => {
    expect(validateDomainUrl('https://*.example.com')).toBeNull();
    expect(validateDomainUrl('http://*.*.example.com:8080')).toBeNull();
  });

  it('接受无协议的通配符写法（normalizeDomain 支持的既有合法配置）', () => {
    expect(validateDomainUrl('*.example.com')).toBeNull();
    expect(validateDomainUrl('*.*.example.com:8080')).toBeNull();
  });

  it('忽略首尾空白', () => {
    expect(validateDomainUrl('  https://example.com  ')).toBeNull();
  });

  it('空值报错', () => {
    expect(validateDomainUrl('')).toBe('请输入域名 URL');
    expect(validateDomainUrl('   ')).toBe('请输入域名 URL');
  });

  it('缺少协议报错', () => {
    expect(validateDomainUrl('example.com')).toBe('URL 需以 http:// 或 https:// 开头');
    expect(validateDomainUrl('localhost:8888')).toBe('URL 需以 http:// 或 https:// 开头');
  });

  it('非 http/https 协议报错', () => {
    expect(validateDomainUrl('ftp://example.com')).toBe('仅支持 http/https 协议');
    expect(validateDomainUrl('javascript:alert(1)')).toBe('URL 需以 http:// 或 https:// 开头');
  });

  it('格式非法报错', () => {
    expect(validateDomainUrl('http://')).toBe('URL 格式不正确，例: http://localhost:8888');
    expect(validateDomainUrl('http://exa mple.com')).toBe('URL 格式不正确，例: http://localhost:8888');
    expect(validateDomainUrl('http://host:abc')).toBe('URL 格式不正确，例: http://localhost:8888');
  });
});

describe('isDuplicateDomain', () => {
  const domains: Record<string, DomainConfig> = {
    'http://localhost:8888': { name: '本地', tags: [] },
    'https://example.com': { name: '示例', tags: [] },
    'https://example.com/management': {
      name: '管理端',
      tags: [],
      matchPath: '/management',
    },
  };

  it('检出已存在的域名', () => {
    expect(isDuplicateDomain(domains, 'http://localhost:8888', '', null)).toBe(true);
  });

  it('首尾空白不影响重复判定', () => {
    expect(isDuplicateDomain(domains, '  http://localhost:8888 ', '', null)).toBe(true);
  });

  it('新域名不重复', () => {
    expect(isDuplicateDomain(domains, 'http://localhost:9999', '', null)).toBe(false);
  });

  it('按 origin 归一化比对：同一 host 的登录页地址也算重复', () => {
    expect(
      isDuplicateDomain(
        domains,
        'http://localhost:8888/management/#/login',
        '',
        null,
      ),
    ).toBe(true);
  });

  it('同 origin 但路径作用域不同 → 不重复', () => {
    expect(
      isDuplicateDomain(domains, 'https://example.com', '/ebidding', null),
    ).toBe(false);
  });

  it('同 origin 且路径作用域相同 → 重复', () => {
    expect(
      isDuplicateDomain(domains, 'https://example.com', '/management', null),
    ).toBe(true);
  });

  it('存量路径 key 没有 matchPath 时，同路径的新环境仍算 key 冲突', () => {
    const legacy: Record<string, DomainConfig> = {
      'https://example.com/management': { name: '存量', tags: [] },
    };
    expect(
      isDuplicateDomain(legacy, 'https://example.com', '/management', null),
    ).toBe(true);
  });

  it('编辑时规范化自身 key 不算重复', () => {
    expect(
      isDuplicateDomain(domains, 'http://localhost:8888/', '', 'http://localhost:8888'),
    ).toBe(false);
  });

  it('编辑时排除自身（URL 未改不算重复）', () => {
    expect(
      isDuplicateDomain(domains, 'http://localhost:8888', '', 'http://localhost:8888'),
    ).toBe(false);
  });

  it('编辑时改成其他已存在域名算重复', () => {
    expect(
      isDuplicateDomain(domains, 'https://example.com', '', 'http://localhost:8888'),
    ).toBe(true);
  });

  it('空值不算重复（由格式校验负责）', () => {
    expect(isDuplicateDomain(domains, '', '', null)).toBe(false);
  });
});

describe('validateMatchPath', () => {
  it('空值 / 根路径合法', () => {
    expect(validateMatchPath('')).toBeNull();
    expect(validateMatchPath('   ')).toBeNull();
    expect(validateMatchPath('/')).toBeNull();
  });

  it('以 / 开头的路径合法（含尾斜杠）', () => {
    expect(validateMatchPath('/management')).toBeNull();
    expect(validateMatchPath('/management/')).toBeNull();
  });

  it('缺少前导 / 报错', () => {
    expect(validateMatchPath('management')).toContain('以 / 开头');
  });

  it('含 query / hash / 空白 / // 报错', () => {
    expect(validateMatchPath('/management?x=1')).toContain('查询');
    expect(validateMatchPath('/management#/login')).toContain('查询');
    expect(validateMatchPath('/man agement')).toContain('空白');
    expect(validateMatchPath('//management')).toContain('//');
  });
});

describe('validateEntryUrl', () => {
  const key = 'https://app.example.com';
  const matchPath = '/management';

  it('空值合法', () => {
    expect(validateEntryUrl(key, matchPath, '')).toBeNull();
  });

  it('落在路径作用域内的地址合法', () => {
    expect(
      validateEntryUrl(key, matchPath, 'https://app.example.com/management/#/login'),
    ).toBeNull();
  });

  it('不在路径作用域内报错', () => {
    expect(
      validateEntryUrl(key, matchPath, 'https://app.example.com/ebidding'),
    ).toContain('路径作用域');
  });

  it('通配符主机被拒', () => {
    expect(
      validateEntryUrl('https://*.example.com', '', 'https://*.example.com/login'),
    ).toContain('通配符');
  });

  it('非法地址被拒', () => {
    expect(validateEntryUrl(key, '', 'not-a-url')).toBeTruthy();
  });

  it('缺少环境地址被拒', () => {
    expect(validateEntryUrl('', '', 'https://app.example.com/login')).toContain(
      '请先填写',
    );
  });
});
