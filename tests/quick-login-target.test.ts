import { describe, expect, it } from 'vitest';
import type { DomainConfig } from '../entrypoints/tools/account-switch/types';
import {
  hasWildcardHostname,
  parseQuickLoginSelection,
} from '../entrypoints/tools/account-switch/utils/quick-login-target';

const DEFAULT_DOMAIN = 'http://*.dev.example.com:16800';
const CURRENT_URL = 'https://app.example.com/app/#/base/resetPasswords';
const DOMAINS: Record<string, DomainConfig> = {
  'https://*.example.com': { name: '生产', loginMethod: 'generic', tags: [] },
  [DEFAULT_DOMAIN]: {
    name: '开发',
    loginMethod: 'generic',
    debugRedirect: 'http://localhost:8888/app/#/',
    debugRedirectEnabled: true,
    tags: [],
  },
};

describe('快捷登录目标选择', () => {
  it('纯账号文本优先使用命中环境的当前页面，而非默认环境', () => {
    const result = parseQuickLoginSelection(
      'demo-user',
      CURRENT_URL,
      DEFAULT_DOMAIN,
      DOMAINS,
    );

    expect(result).toMatchObject({
      url: CURRENT_URL,
      username: 'demo-user',
      hasUrl: false,
      targetSource: 'current-page',
    });
  });

  it('同一 origin 的路径子页面：保留 pathname 以命中对应环境', () => {
    const pathDomains: Record<string, DomainConfig> = {
      'https://app.example.com/management': {
        name: '管理端',
        loginMethod: 'generic',
        matchPath: '/management',
        tags: [],
      },
      'https://app.example.com/ebidding': {
        name: '招采端',
        loginMethod: 'generic',
        matchPath: '/ebidding',
        tags: [],
      },
    };
    const pageUrl = 'https://app.example.com/ebidding/list';
    expect(
      parseQuickLoginSelection('demo-user', pageUrl, '', pathDomains),
    ).toMatchObject({
      url: pageUrl,
      targetSource: 'current-page',
    });
  });

  it('当前页面未匹配环境时回退默认环境', () => {
    const result = parseQuickLoginSelection(
      'admin/secret',
      'https://unconfigured.test/page',
      DEFAULT_DOMAIN,
      DOMAINS,
    );

    expect(result).toMatchObject({
      url: DEFAULT_DOMAIN,
      hasUrl: false,
      targetSource: 'default',
    });
  });

  it('显式 URL 优先于当前页面和默认环境', () => {
    const explicit = 'http://foo.dev.example.com:16800/login';
    const result = parseQuickLoginSelection(
      `${explicit} admin/secret`,
      CURRENT_URL,
      DEFAULT_DOMAIN,
      DOMAINS,
    );

    expect(result).toMatchObject({
      url: explicit,
      hasUrl: true,
      targetSource: 'explicit',
    });
  });

  it('受限页面不参与匹配，仍使用默认环境', () => {
    const result = parseQuickLoginSelection(
      'admin/secret',
      'chrome://extensions/',
      DEFAULT_DOMAIN,
      DOMAINS,
    );

    expect(result).toMatchObject({ url: DEFAULT_DOMAIN, hasUrl: false });
  });

  it('当前页面无匹配且未配置默认环境时交回调用方打开面板', () => {
    expect(
      parseQuickLoginSelection(
        'admin/secret',
        'https://unconfigured.test/page',
        '',
        DOMAINS,
      ),
    ).toBeNull();
  });
});

describe('快捷登录通配符目标防护', () => {
  it('识别主机名通配符及 Chromium 编码形式', () => {
    expect(hasWildcardHostname(DEFAULT_DOMAIN)).toBe(true);
    expect(hasWildcardHostname('http://%2A.dev.example.com:16800')).toBe(true);
  });

  it('具体主机和路径中的星号不误判', () => {
    expect(hasWildcardHostname('https://app.example.com/app/*')).toBe(false);
  });
});
