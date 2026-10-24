/**
 * generic-recipe — 配方模型、legacy 迁移与校验（ADR-0012 D1/D2/D4/D6）
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_LIMITS,
  DEFAULT_SETTLE,
  RECIPE_VERSION,
  hasLegacyParams,
  migrateLegacyAuth,
  migrateLegacyParams,
  migrateLegacySettle,
  normalizeRecipe,
  readRecipeFromConfig,
  validateRecipe,
} from '../entrypoints/tools/account-switch/strategies/generic-recipe';

describe('migrateLegacyParams — 8 字段迁移矩阵', () => {
  it('全字段配置 → 导航/等待/填充/点击/settle/limits/auth 全部落地', () => {
    const recipe = migrateLegacyParams({
      loginPageUrl: '{origin}/login',
      pageLoadSelector: '#app-ready',
      usernameSelector: '#u',
      passwordSelector: '#p',
      submitSelector: '#go',
      successType: 'selector',
      successValue: '.welcome',
      successTimeout: 8000,
      authSource: 'localStorage',
      authKey: 'auth',
    });

    expect(recipe.version).toBe(RECIPE_VERSION);
    expect(recipe.steps).toEqual([
      { op: 'goto', url: '{origin}/login', waitForLoad: true },
      {
        op: 'waitFor',
        when: { type: 'selector', target: '#app-ready' },
      },
      { op: 'fill', target: '#u', value: '{username}', clearFirst: true },
      { op: 'fill', target: '#p', value: '{password}', clearFirst: true },
      { op: 'click', target: '#go', onNotFound: 'fail' },
      { op: 'extract', source: 'storage', key: 'auth', as: 'auth' },
    ]);
    expect(recipe.settle).toEqual({ type: 'selector', target: '.welcome' });
    expect(recipe.limits).toEqual({ settleMs: 8000 });
    expect(recipe.auth).toEqual({
      mode: 'snapshot',
      cookies: 'none',
      cookiesClear: 'all',
      localStorage: ['auth'],
    });
  });

  it('空配置 → 默认填充与提交步骤，settle 用零配置默认，auth 页面自管', () => {
    const recipe = migrateLegacyParams({});
    expect(recipe.steps.filter((s) => s.op === 'goto')).toHaveLength(0);
    expect(recipe.steps.filter((s) => s.op === 'fill')).toHaveLength(2);
    expect(recipe.steps.filter((s) => s.op === 'click')).toHaveLength(1);
    expect(recipe.settle).toEqual(DEFAULT_SETTLE);
    expect(recipe.auth).toEqual({ mode: 'page' });
    expect(recipe.limits).toBeUndefined();
  });

  it('只配登录页 URL → 首步 goto', () => {
    const recipe = migrateLegacyParams({ loginPageUrl: 'http://x/login' });
    expect(recipe.steps[0]).toEqual({
      op: 'goto',
      url: 'http://x/login',
      waitForLoad: true,
    });
  });

  it('自动补全缺失的输入框/按钮选择器（与旧引擎默认值一致）', () => {
    const recipe = migrateLegacyParams({ loginPageUrl: '/login' });
    const fills = recipe.steps.filter((s) => s.op === 'fill');
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({
      target: 'input[name="username"], input[name="account"], #username',
      value: '{username}',
    });
    expect(fills[1]).toMatchObject({
      target: 'input[type="password"], #password',
      value: '{password}',
    });
    expect(recipe.steps.find((s) => s.op === 'click')?.target).toBe(
      'button[type="submit"], input[type="submit"], .login-btn',
    );
  });

  it('successType=url → url glob 判定；successTimeout 落入 limits.settleMs', () => {
    const recipe = migrateLegacyParams({
      successType: 'url',
      successValue: '*/dashboard*',
      successTimeout: 3000,
    });
    expect(recipe.settle).toEqual({ type: 'url', glob: '*/dashboard*' });
    expect(recipe.limits).toEqual({ settleMs: 3000 });
  });

  it('successType=cookie / localStorage 分别映射', () => {
    expect(
      migrateLegacyParams({ successType: 'cookie', successValue: 'sid' }).settle,
    ).toEqual({ type: 'cookie', name: 'sid' });
    expect(
      migrateLegacyParams({ successType: 'localStorage', successValue: 'tk' })
        .settle,
    ).toEqual({ type: 'storage', area: 'local', key: 'tk' });
  });

  it('successType=timeout → 固定等待判定，非法毫秒数退回默认', () => {
    expect(
      migrateLegacyParams({ successType: 'timeout', successValue: '1500' }).settle,
    ).toEqual({ type: 'fixed', ms: 1500 });
    expect(
      migrateLegacyParams({ successType: 'timeout', successValue: 'abc' }).settle,
    ).toEqual(DEFAULT_SETTLE);
  });

  it('authSource=cookie → 快照 cookie 白名单', () => {
    const recipe = migrateLegacyParams({ authSource: 'cookie', authKey: 'auth' });
    expect(recipe.auth).toEqual({
      mode: 'snapshot',
      cookies: ['auth'],
      cookiesClear: 'all',
    });
    expect(recipe.steps.some((s) => s.op === 'extract')).toBe(true);
  });

  it('authSource 有值但 authKey 为空 → 页面自管（不猜测键名）', () => {
    expect(migrateLegacyAuth('cookie', '')).toEqual({ mode: 'page' });
    expect(migrateLegacyAuth('localStorage', undefined)).toEqual({
      mode: 'page',
    });
  });

  it('转换可重入：同一输入两次结果深度相等', () => {
    const params = {
      loginPageUrl: '/login',
      successType: 'selector',
      successValue: '.ok',
      authSource: 'sessionStorage',
      authKey: 'k',
    };
    expect(migrateLegacyParams(params)).toEqual(migrateLegacyParams(params));
  });

  it('hasLegacyParams 识别「有内容」与「仅空白」', () => {
    expect(hasLegacyParams({ loginPageUrl: '/login' })).toBe(true);
    expect(hasLegacyParams({ loginPageUrl: '   ' })).toBe(false);
    expect(hasLegacyParams({})).toBe(false);
    expect(hasLegacyParams(null)).toBe(false);
  });

  it('migrateLegacySettle 对未知类型退回默认判定', () => {
    expect(migrateLegacySettle('whatever', 'x')).toEqual(DEFAULT_SETTLE);
  });
});

describe('normalizeRecipe — 补默认值', () => {
  const minimal = {
    version: 1,
    steps: [{ op: 'click', target: '#go' }],
  };

  it('缺 settle/auth → 默认 settle 与页面自管', () => {
    const { recipe, warnings, invalid } = normalizeRecipe(minimal);
    expect(invalid).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(recipe.settle).toEqual(DEFAULT_SETTLE);
    expect(recipe.auth).toEqual({ mode: 'page' });
    expect(recipe.limits).toBeUndefined();
  });

  it('limits 缺失时按默认常量解释（不写入对象）', () => {
    expect(DEFAULT_LIMITS).toEqual({
      stepMs: 5000,
      settleMs: 10000,
      pageLoadMs: 15000,
    });
  });

  it('unknown 步骤被丢弃并给出告警', () => {
    const { recipe, warnings } = normalizeRecipe({
      ...minimal,
      steps: [{ op: 'teleport' }, { op: 'click', target: '#go' }],
    });
    expect(recipe.steps).toHaveLength(1);
    expect(warnings[0]).toContain('未知');
  });

  it('非法 settle 退回默认', () => {
    expect(normalizeRecipe({ ...minimal, settle: { type: 'bogus' } }).recipe.settle).toEqual(
      DEFAULT_SETTLE,
    );
  });

  it('空步骤列表 → invalid', () => {
    expect(normalizeRecipe({ version: 1, steps: [] }).invalid).toBeTruthy();
    expect(normalizeRecipe({ version: 1, steps: 'x' }).invalid).toBeTruthy();
    expect(normalizeRecipe(null).invalid).toBeTruthy();
  });

  it('版本不匹配给出告警但仍按当前版本解释', () => {
    const { recipe, warnings } = normalizeRecipe({ ...minimal, version: 2 });
    expect(recipe.version).toBe(1);
    expect(warnings.some((w) => w.includes('版本'))).toBe(true);
  });

  it('归一化可重入且稳定', () => {
    const once = normalizeRecipe({
      ...minimal,
      settle: { type: 'any', of: [{ type: 'formGone' }, { type: 'urlChanged' }] },
      auth: { mode: 'snapshot', cookiesClear: ['a'], cookies: 'all' },
    }).recipe;
    expect(normalizeRecipe(once).recipe).toEqual(once);
  });

  it('aria-label 定位与拾取器记录的 frame 被保留', () => {
    const { recipe, warnings } = normalizeRecipe({
      ...minimal,
      steps: [
        {
          op: 'fill',
          target: { ariaLabel: '用户名' },
          value: '{username}',
          frameId: 4,
          frameUrl: 'https://login.example.com/form',
        },
      ],
    });
    expect(warnings).toEqual([]);
    expect(recipe.steps[0]).toEqual({
      op: 'fill',
      target: { ariaLabel: '用户名' },
      value: '{username}',
      frameId: 4,
      frameUrl: 'https://login.example.com/form',
    });
  });

  it('非法 frameId 被丢弃（只留 frameUrl）', () => {
    const { recipe } = normalizeRecipe({
      ...minimal,
      steps: [
        {
          op: 'click',
          target: '#go',
          frameId: 'x',
          frameUrl: ' https://login.example.com/form ',
        },
      ],
    });
    expect(recipe.steps[0]).toMatchObject({
      op: 'click',
      frameUrl: 'https://login.example.com/form',
    });
    expect(recipe.steps[0]).not.toHaveProperty('frameId');
  });
});

describe('validateRecipe — 保存时结构校验', () => {
  it('合法配方无错误', () => {
    expect(
      validateRecipe({
        version: 1,
        steps: [{ op: 'goto', url: '/login' }],
        settle: DEFAULT_SETTLE,
      }),
    ).toEqual([]);
  });

  it('版本不符', () => {
    expect(
      validateRecipe({ version: 2, steps: [{ op: 'goto', url: '/x' }] }).join(),
    ).toContain('版本');
  });

  it('至少一步', () => {
    expect(validateRecipe({ version: 1, steps: [] }).join()).toContain('至少');
  });

  it('未知步骤类型 / 缺定位 / 缺值 都给出明确原因', () => {
    const errors = validateRecipe({
      version: 1,
      steps: [
        { op: 'teleport' },
        { op: 'click' },
        { op: 'fill', target: '#u' },
        { op: 'waitFor' },
      ],
      settle: DEFAULT_SETTLE,
    });
    expect(errors.some((e) => e.includes('操作类型无效'))).toBe(true);
    expect(errors.some((e) => e.includes('缺少元素定位'))).toBe(true);
    expect(errors.some((e) => e.includes('缺少填充值'))).toBe(true);
    expect(errors.some((e) => e.includes('等待条件无效'))).toBe(true);
  });

  it('limits 非法毫秒数被拒绝', () => {
    expect(
      validateRecipe({
        version: 1,
        steps: [{ op: 'goto', url: '/x' }],
        settle: DEFAULT_SETTLE,
        limits: { settleMs: 0 },
      }).join(),
    ).toContain('settleMs');
  });

  it('缺少 settle 被拒绝', () => {
    expect(
      validateRecipe({ version: 1, steps: [{ op: 'goto', url: '/x' }] }).join(),
    ).toContain('成功判定');
  });
});

describe('readRecipeFromConfig — 读取优先级', () => {
  it('strategyConfig.recipe 优先于 legacy 参数', () => {
    const result = readRecipeFromConfig({
      strategyConfig: {
        recipe: {
          version: 1,
          steps: [{ op: 'click', target: '#new' }],
          settle: DEFAULT_SETTLE,
        },
      },
      strategyParams: { usernameSelector: '#old' },
    });
    expect(result.migrated).toBe(false);
    expect(result.recipe.steps).toHaveLength(1);
  });

  it('无配方但有 legacy 参数 → 迁移并标记 migrated', () => {
    const result = readRecipeFromConfig({
      strategyParams: { loginPageUrl: '/login' },
    });
    expect(result.migrated).toBe(true);
    expect(result.recipe.steps[0]).toMatchObject({ op: 'goto', url: '/login' });
  });

  it('两者都没有 → invalid（未配置）', () => {
    expect(readRecipeFromConfig({ strategyParams: {} }).invalid).toBeTruthy();
  });
});
