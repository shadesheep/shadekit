/**
 * generic 保存时组合校验（ADR-0012）
 *
 * 纯函数：输入登录方式与扁平参数，输出可读错误（错误定位到具体配置项）。
 * 规则与执行器语义同源：
 * - successType ↔ successValue 联动（见 generic-recipe 的 migrateLegacySettle）
 * - 声明 authSource 时 authKey 必填（migrateLegacyAuth 的判定）
 * - successTimeout 必须为正数（limits.settleMs）
 * - loginPageUrl 支持绝对地址、相对路径与 {origin} 占位
 */
import { describe, expect, it } from 'vitest';
import { validateStrategyParams } from '../entrypoints/tools/account-switch/utils/validate-strategy';

function fields(
  result: ReturnType<typeof validateStrategyParams>,
): string[] {
  return result.map((e) => e.field);
}

describe('validateStrategyParams — 非 generic 策略', () => {
  it('不做 generic 规则校验', () => {
    expect(
      validateStrategyParams('custom-login', {
        successType: 'url',
        successValue: '',
        authSource: 'cookie',
      }),
    ).toEqual([]);
  });
});

describe('validateStrategyParams — successType / successValue 联动', () => {
  it('successType 留空视为默认（urlChanged），不要求 successValue', () => {
    expect(validateStrategyParams('generic', {})).toEqual([]);
    expect(
      validateStrategyParams('generic', { successValue: '' }),
    ).toEqual([]);
  });

  it.each(['url', 'selector', 'cookie', 'localStorage', 'timeout'])(
    '%s 必须填写判定值',
    (successType) => {
      const errors = validateStrategyParams('generic', { successType });
      expect(fields(errors)).toEqual(['successValue']);
      expect(errors[0].message).toContain('成功判定值');
    },
  );

  it('填写了判定值 → 通过', () => {
    expect(
      validateStrategyParams('generic', {
        successType: 'selector',
        successValue: '.welcome',
      }),
    ).toEqual([]);
  });

  it('timeout 的判定值必须是正数毫秒', () => {
    expect(
      fields(
        validateStrategyParams('generic', {
          successType: 'timeout',
          successValue: 'abc',
        }),
      ),
    ).toEqual(['successValue']);
    expect(
      fields(
        validateStrategyParams('generic', {
          successType: 'timeout',
          successValue: '-100',
        }),
      ),
    ).toEqual(['successValue']);
    expect(
      validateStrategyParams('generic', {
        successType: 'timeout',
        successValue: '3000',
      }),
    ).toEqual([]);
  });

  it('未知 successType 被拦截', () => {
    expect(
      fields(
        validateStrategyParams('generic', {
          successType: 'magic',
          successValue: 'x',
        }),
      ),
    ).toEqual(['successType']);
  });

  it('未声明 successType 却填了 successValue → 提示选择判定方式', () => {
    expect(
      fields(validateStrategyParams('generic', { successValue: '.welcome' })),
    ).toEqual(['successType']);
  });
});

describe('validateStrategyParams — 认证数据提取', () => {
  it('authSource 有值但 authKey 为空 → 拦截 authKey', () => {
    const errors = validateStrategyParams('generic', {
      authSource: 'localStorage',
    });
    expect(fields(errors)).toEqual(['authKey']);
    expect(errors[0].message).toContain('认证键名');
  });

  it('authSource 为「不提取」时空 key 合法', () => {
    expect(
      validateStrategyParams('generic', { authSource: '', authKey: '' }),
    ).toEqual([]);
  });

  it('authSource + authKey 均填写 → 通过', () => {
    expect(
      validateStrategyParams('generic', {
        authSource: 'cookie',
        authKey: 'auth',
      }),
    ).toEqual([]);
  });
});

describe('validateStrategyParams — 数值与 URL', () => {
  it('successTimeout 非正数被拦截', () => {
    expect(
      fields(validateStrategyParams('generic', { successTimeout: 0 })),
    ).toEqual(['successTimeout']);
    expect(
      fields(validateStrategyParams('generic', { successTimeout: Number.NaN })),
    ).toEqual(['successTimeout']);
    expect(
      validateStrategyParams('generic', { successTimeout: 10000 }),
    ).toEqual([]);
  });

  it('loginPageUrl 接受绝对地址', () => {
    expect(
      validateStrategyParams('generic', {
        loginPageUrl: 'https://example.com/login',
      }),
    ).toEqual([]);
  });

  it('loginPageUrl 接受相对路径', () => {
    expect(
      validateStrategyParams('generic', { loginPageUrl: '/login' }),
    ).toEqual([]);
    expect(
      validateStrategyParams('generic', { loginPageUrl: 'login?next=%2Fhome' }),
    ).toEqual([]);
  });

  it('loginPageUrl 接受 {origin} 占位', () => {
    expect(
      validateStrategyParams('generic', {
        loginPageUrl: '{origin}/login?from={debugRedirect}',
      }),
    ).toEqual([]);
  });

  it('loginPageUrl 非法协议被拦截', () => {
    expect(
      fields(
        validateStrategyParams('generic', {
          loginPageUrl: 'javascript:alert(1)',
        }),
      ),
    ).toEqual(['loginPageUrl']);
  });

  it('loginPageUrl 留空合法（使用当前 tab）', () => {
    expect(validateStrategyParams('generic', { loginPageUrl: '' })).toEqual([]);
  });
});

describe('validateStrategyParams — 多错误同时返回', () => {
  it('每个出错字段各一条，便于逐行提示', () => {
    const errors = validateStrategyParams('generic', {
      successType: 'timeout',
      successValue: 'abc',
      authSource: 'cookie',
      successTimeout: -1,
      loginPageUrl: 'ftp://x',
    });
    expect(fields(errors).sort()).toEqual(
      ['authKey', 'loginPageUrl', 'successTimeout', 'successValue'].sort(),
    );
  });
});
