/**
 * 扩展页没有可执行的活动网页时，handleSwitchAccount 的入口地址回退：
 *
 * 活动 tab 是扩展页自身（TAB_RESTRICTED），
 * 无法在其上注入/执行。此时按账号首环境解析「可打开的具体 URL」：
 * - 环境 key 是具体地址（非通配符）→ 直接可打开
 * - 环境 key 是通配符 → 不可自动打开，返回明确提示而非底层报错
 *   （v1.1.4 起不再从环境配置里兜底）
 *
 * 本文件只验证 resolveOpenableUrl 的 URL 推导；活动网页登录路由由
 * account-background-security.test.ts 与 e2e/switch/popup.spec.ts 覆盖。
 */
import { describe, it, expect } from 'vitest';

import { resolveOpenableUrl } from '../entrypoints/tools/account-switch/background-handler';

describe('resolveOpenableUrl — extension 页登录的可打开 URL 推导', () => {
  it('环境 key 是具体地址（非通配符）→ 直接用它', async () => {
    expect(await resolveOpenableUrl('https://ops.example.com:10008/')).toBe(
      'https://ops.example.com:10008/',
    );
  });

  it('环境 key 是通配符 → null（调用方给明确提示，不再从环境配置兜底）', async () => {
    expect(await resolveOpenableUrl('https://*.example.com')).toBeNull();
  });

  it('空 key → null', async () => {
    expect(await resolveOpenableUrl('')).toBeNull();
  });

  it('通配符环境配置了具体入口地址 → 打开入口', async () => {
    expect(
      await resolveOpenableUrl(
        'https://*.example.com',
        'https://app.example.com/management/#/login',
      ),
    ).toBe('https://app.example.com/management/#/login');
  });

  it('入口地址含通配符 → 仍不可打开', async () => {
    expect(
      await resolveOpenableUrl('https://*.example.com', 'https://*.example.com/login'),
    ).toBeNull();
  });

  it('具体环境也优先使用配置的入口地址', async () => {
    expect(
      await resolveOpenableUrl(
        'https://app.example.com/management',
        'https://app.example.com/management/#/login',
      ),
    ).toBe('https://app.example.com/management/#/login');
  });
});
