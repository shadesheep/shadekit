import { describe, expect, it } from 'vitest';
import type { DomainConfig } from '../entrypoints/tools/account-switch/types';
import {
  hasWildcardHostname,
  parseQuickLoginSelection,
} from '../entrypoints/tools/account-switch/utils/quick-login-target';

const DEFAULT_DOMAIN = 'http://*.dev.ebidding.net.cn:16800';
const CURRENT_URL = 'https://chn.zcjb.com.cn/ebidding/#/base/resetPasswords';
const DOMAINS: Record<string, DomainConfig> = {
  'https://*.zcjb.com.cn': { name: '生产', loginMethod: 'ebs-v6', tags: [] },
  [DEFAULT_DOMAIN]: {
    name: '开发',
    loginMethod: 'ebs-v6',
    debugRedirect: 'http://localhost:8888/ebidding/#/',
    debugRedirectEnabled: true,
    tags: [],
  },
};

describe('快捷登录目标选择', () => {
  it('纯账号文本优先使用命中环境的当前页面，而非默认环境', () => {
    const result = parseQuickLoginSelection(
      'sxxmjl01',
      CURRENT_URL,
      DEFAULT_DOMAIN,
      DOMAINS,
    );

    expect(result).toMatchObject({
      url: CURRENT_URL,
      username: 'sxxmjl01',
      hasUrl: false,
      targetSource: 'current-page',
    });
  });

  it('当前页面未匹配环境时回退默认环境', () => {
    const result = parseQuickLoginSelection(
      'admin/secret',
      'https://unconfigured.example.com/page',
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
    const explicit = 'http://foo.dev.ebidding.net.cn:16800/login';
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
        'https://unconfigured.example.com/page',
        '',
        DOMAINS,
      ),
    ).toBeNull();
  });
});

describe('快捷登录通配符目标防护', () => {
  it('识别主机名通配符及 Chromium 编码形式', () => {
    expect(hasWildcardHostname(DEFAULT_DOMAIN)).toBe(true);
    expect(hasWildcardHostname('http://%2A.dev.ebidding.net.cn:16800')).toBe(true);
  });

  it('具体主机和路径中的星号不误判', () => {
    expect(hasWildcardHostname('https://chn.zcjb.com.cn/ebidding/*')).toBe(false);
  });
});
