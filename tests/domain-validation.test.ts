import { describe, it, expect } from 'vitest';
import {
  validateDomainUrl,
  isDuplicateDomain,
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
  };

  it('检出已存在的域名', () => {
    expect(isDuplicateDomain(domains, 'http://localhost:8888', null)).toBe(true);
  });

  it('首尾空白不影响重复判定', () => {
    expect(isDuplicateDomain(domains, '  http://localhost:8888 ', null)).toBe(true);
  });

  it('新域名不重复', () => {
    expect(isDuplicateDomain(domains, 'http://localhost:9999', null)).toBe(false);
  });

  it('编辑时排除自身（URL 未改不算重复）', () => {
    expect(
      isDuplicateDomain(domains, 'http://localhost:8888', 'http://localhost:8888'),
    ).toBe(false);
  });

  it('编辑时改成其他已存在域名算重复', () => {
    expect(
      isDuplicateDomain(domains, 'https://example.com', 'http://localhost:8888'),
    ).toBe(true);
  });

  it('空值不算重复（由格式校验负责）', () => {
    expect(isDuplicateDomain(domains, '', null)).toBe(false);
  });
});
