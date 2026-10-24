import { describe, it, expect } from 'vitest';

/**
 * parse-text 格式分支测试
 *
 * 覆盖 parseLoginText 支持的全部格式分支：
 * URL 在前/在后/无 URL、单行/多行凭证、分隔符（/、:、空格）、
 * 带标签、无协议 URL（localhost / IP / 域名）。
 */

import { parseLoginText } from '../entrypoints/tools/account-switch/utils/parse-text';

describe('parseLoginText — URL 在前', () => {
  it('带协议 URL 换行 账号/密码', () => {
    const result = parseLoginText('https://app.example.com\nadmin/secret');
    expect(result).toEqual({
      url: 'https://app.example.com',
      username: 'admin',
      password: 'secret',
      hasUrl: true,
    });
  });

  it('带协议 URL 空格 账号:密码（单行）', () => {
    const result = parseLoginText('https://app.example.com admin:secret');
    expect(result).toMatchObject({
      url: 'https://app.example.com',
      username: 'admin',
      password: 'secret',
      hasUrl: true,
    });
  });

  it('带协议 URL 空格 账号/密码（单行）', () => {
    const result = parseLoginText('https://app.example.com admin/secret');
    expect(result).toMatchObject({
      url: 'https://app.example.com',
      username: 'admin',
      password: 'secret',
      hasUrl: true,
    });
  });

  it('无协议 localhost:端口', () => {
    const result = parseLoginText('localhost:8080 admin/pass');
    expect(result).toMatchObject({
      url: 'http://localhost:8080',
      username: 'admin',
      password: 'pass',
      hasUrl: true,
    });
  });

  it('无协议 IP:端口/路径', () => {
    const result = parseLoginText('192.168.1.100:31135/login admin/pass');
    expect(result).toMatchObject({
      url: 'http://192.168.1.100:31135/login',
      hasUrl: true,
    });
  });

  it('无协议域名后跟凭证', () => {
    const result = parseLoginText('example.com/path admin/pass');
    expect(result).toMatchObject({
      url: 'https://example.com/path',
      username: 'admin',
      password: 'pass',
      hasUrl: true,
    });
  });
});

describe('parseLoginText — 凭证在前，URL 在后', () => {
  it('账号/密码 带协议 URL', () => {
    const result = parseLoginText('admin/secret https://app.example.com');
    expect(result).toMatchObject({
      url: 'https://app.example.com',
      username: 'admin',
      password: 'secret',
      hasUrl: true,
    });
  });

  it('账号/密码 无协议域名 URL', () => {
    const result = parseLoginText('admin/secret example.com');
    expect(result).toMatchObject({
      url: 'https://example.com',
      username: 'admin',
      password: 'secret',
      hasUrl: true,
    });
  });

  it('账号/密码 localhost:端口', () => {
    const result = parseLoginText('admin/secret localhost:8080');
    expect(result).toMatchObject({ url: 'http://localhost:8080', hasUrl: true });
  });

  it('账号/密码 IP 地址', () => {
    const result = parseLoginText('admin/secret 192.168.1.100');
    expect(result).toMatchObject({ url: 'http://192.168.1.100', hasUrl: true });
  });
});

describe('parseLoginText — 无 URL（使用 defaultDomain）', () => {
  it('纯 账号/密码', () => {
    const result = parseLoginText('admin/secret', 'https://default.com');
    expect(result).toEqual({
      url: 'https://default.com',
      username: 'admin',
      password: 'secret',
      hasUrl: false,
    });
  });

  it('账号 密码（空格分隔）', () => {
    const result = parseLoginText('admin secret', 'https://default.com');
    expect(result).toMatchObject({
      username: 'admin',
      password: 'secret',
      hasUrl: false,
    });
  });

  it('密码中包含空格（第一个空格分界）', () => {
    const result = parseLoginText('admin my pass word', 'https://default.com');
    expect(result).toMatchObject({ username: 'admin', password: 'my pass word' });
  });

  it('无分隔符 → 仅用户名，密码留空', () => {
    const result = parseLoginText('admin', 'https://default.com');
    expect(result).toMatchObject({ username: 'admin', password: undefined });
  });

  it('无 URL 且无 defaultDomain → null', () => {
    expect(parseLoginText('admin/secret')).toBeNull();
  });
});

describe('parseLoginText — 多行与标签格式', () => {
  it('三行格式：URL / 账号 / 密码', () => {
    const result = parseLoginText('https://app.example.com\nadmin\nsecret');
    expect(result).toMatchObject({
      url: 'https://app.example.com',
      username: 'admin',
      password: 'secret',
    });
  });

  it('带标签格式：账号:xxx 密码:xxx', () => {
    const result = parseLoginText(
      'https://app.example.com\n账号:admin\n密码:secret',
    );
    expect(result).toMatchObject({ username: 'admin', password: 'secret' });
  });

  it('带标签格式支持全角冒号', () => {
    const result = parseLoginText(
      'https://app.example.com\n账号：admin\n密码：secret',
    );
    expect(result).toMatchObject({ username: 'admin', password: 'secret' });
  });

  it('两行凭证：第一行含分隔符时优先按分隔符拆', () => {
    const result = parseLoginText('https://app.example.com\nadmin/secret\nextra');
    // 两行凭证：第一行可按 / 拆分 → 直接采用拆分结果
    expect(result).toMatchObject({ username: 'admin', password: 'secret' });
  });

  it('三行及以上凭证：倒数第二行为账号、最后一行为密码', () => {
    const result = parseLoginText('admin\nnote\nsecret', 'https://default.com');
    expect(result).toMatchObject({ username: 'note', password: 'secret' });
  });
});

describe('parseLoginText — 边界与误判防护', () => {
  it('空文本 → null', () => {
    expect(parseLoginText('')).toBeNull();
    expect(parseLoginText('   ')).toBeNull();
  });

  it('纯域名（无凭证）不识别为 URL → 走凭证解析', () => {
    // example.com 单行无其他内容：tryExtractUrl 要求 rest 非空，
    // 末尾提取同样要求 rest 非空 → 整体作为凭证（仅用户名）
    const result = parseLoginText('example.com', 'https://default.com');
    expect(result).toMatchObject({ hasUrl: false, url: 'https://default.com' });
  });
});
