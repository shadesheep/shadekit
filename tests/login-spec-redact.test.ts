/**
 * spec/redact — 日志脱敏（ADR-0015 D8）
 *
 * 纯函数。敏感字段黑名单：password / passwd / pwd / token / refresh_token /
 * authorization / cookie / set-cookie / secret / x-*-token，命中即替换为 `***`。
 * **`sign` 不在黑名单**（一次性请求签名，是排查签名失败的主要线索）。
 *
 * 应用于 request.headers / request.body / response.body：可解析为 JSON 的
 * 逐字段处理，否则整串替换。`log.reveal` 白名单不在此层——它由执行器在
 * 拥有 spec 与绑定表的上下文里收集进 `request.revealed`，黑名单总是优先。
 */
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  isSensitiveKey,
  redactHeaders,
  redactTextBody,
} from "../entrypoints/tools/account-switch/spec/redact";

// ---------------------------------------------------------------------------
// 黑名单判定
// ---------------------------------------------------------------------------

describe('isSensitiveKey — 敏感字段黑名单（ADR-0015 D8）', () => {
  it('精确命中黑名单名称（大小写不敏感）', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('Password')).toBe(true);
    expect(isSensitiveKey('passwd')).toBe(true);
    expect(isSensitiveKey('pwd')).toBe(true);
    expect(isSensitiveKey('token')).toBe(true);
    expect(isSensitiveKey('refresh_token')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('cookie')).toBe(true);
    expect(isSensitiveKey('set-cookie')).toBe(true);
    expect(isSensitiveKey('secret')).toBe(true);
  });

  it('x-*-token 通配：x- 前缀 + -token 后缀', () => {
    expect(isSensitiveKey('x-csrf-token')).toBe(true);
    expect(isSensitiveKey('X-Auth-Token')).toBe(true);
    expect(isSensitiveKey('x-access-token')).toBe(true);
  });

  it('不在黑名单（含 sign）保持可见', () => {
    expect(isSensitiveKey('sign')).toBe(false);
    expect(isSensitiveKey('username')).toBe(false);
    expect(isSensitiveKey('xstr')).toBe(false);
    expect(isSensitiveKey('nonce')).toBe(false);
    expect(isSensitiveKey('loginType')).toBe(false);
    expect(isSensitiveKey('x-')).toBe(false);
    expect(isSensitiveKey('-token')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 请求头脱敏
// ---------------------------------------------------------------------------

describe('redactHeaders — 请求头逐字段脱敏', () => {
  it('命中黑名单的 header 值替换，保留其余', () => {
    const out = redactHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer abc123',
      'Set-Cookie': 'sid=sec; HttpOnly',
      nonce: '12345',
      username: 'alice',
    });
    expect(out).toEqual({
      'Content-Type': 'application/json',
      Authorization: REDACTED,
      'Set-Cookie': REDACTED,
      nonce: '12345',
      username: 'alice',
    });
  });

  it('sign 与 x-*-token 之外的 x- 头不受影响', () => {
    const out = redactHeaders({ sign: '2cf2', 'x-user': 'alice' });
    expect(out).toEqual({ sign: '2cf2', 'x-user': 'alice' });
  });
});

// ---------------------------------------------------------------------------
// 请求体 / 响应体脱敏（JSON 逐字段 / 非 JSON 整串）
// ---------------------------------------------------------------------------

describe('redactTextBody — 结构化遍历', () => {
  it('JSON 对象：逐字段，黑名单 key 的值替换，非敏感保留', () => {
    const raw = JSON.stringify({
      loginType: '1',
      username: 'alice',
      password: 'p@ss',
      xstr: 'aGVsbG8=',
      nested: { token: 'secret', foo: 'bar' },
    });
    const out = redactTextBody(raw);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.username).toBe('alice');
    expect(parsed.xstr).toBe('aGVsbG8=');
    expect((parsed.nested as Record<string, unknown>).token).toBe(REDACTED);
    expect((parsed.nested as Record<string, unknown>).foo).toBe('bar');
  });

  it('JSON 数组：逐元素处理', () => {
    const out = redactTextBody(
      JSON.stringify([{ token: 'a' }, { password: 'b', keep: 1 }]),
    );
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed[0].token).toBe(REDACTED);
    expect(parsed[1].password).toBe(REDACTED);
    expect(parsed[1].keep).toBe(1);
  });

  it('response 的 refresh_token 深路径也命中；sign 保留', () => {
    const raw = JSON.stringify({
      data: { sign: 'ab12cd', refresh_token: 'y', 'x-csrf-token': 't' },
    });
    const parsed = JSON.parse(redactTextBody(raw)) as {
      data: Record<string, unknown>;
    };
    expect(parsed.data.sign).toBe('ab12cd'); // sign 不在黑名单
    expect(parsed.data.refresh_token).toBe(REDACTED);
    expect(parsed.data['x-csrf-token']).toBe(REDACTED);
  });

  it('非 JSON：整串替换为占位符', () => {
    expect(redactTextBody('alice:p@ss&keep=me')).toBe(REDACTED);
  });

  it('JSON 字符串叶子：值本身是 JSON 时也逐字段处理', () => {
    const raw = JSON.stringify({ payload: '{"token":"s3cret"}' });
    const parsed = JSON.parse(redactTextBody(raw)) as {
      payload: string;
    };
    const inner = JSON.parse(parsed.payload) as Record<string, unknown>;
    expect(inner.token).toBe(REDACTED);
  });

  it('空串保持为空', () => {
    expect(redactTextBody('')).toBe('');
  });

  it('非 JSON 但无内容以外的情况：JSON 附加值（数字）返回原值不会崩', () => {
    expect(() => redactTextBody('42')).not.toThrow();
  });
});