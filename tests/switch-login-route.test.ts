/**
 * handleSwitchAccount 的 extension 页登录路由（options/popup）：
 *
 * 从扩展页发起登录时 sender.tab 缺省、活动 tab 是扩展页自身（TAB_RESTRICTED），
 * 无法在其上注入/执行。此时按账号首环境解析「可打开的具体 URL」：
 * - 环境 key 是具体地址（非通配符）→ 直接可打开
 * - 环境 key 是通配符 → 不可自动打开，返回明确提示而非底层报错
 *   （v1.1.4 起不再从环境配置里兜底）
 *
 * 断言落在纯函数 resolveOpenableUrl（URL 推导收口此处），
 * 避免为真实 new-tab 登录整条链（建 tab / runAuthFlow / setupAuthTab）做重桩。
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
});
