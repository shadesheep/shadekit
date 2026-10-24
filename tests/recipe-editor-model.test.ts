/**
 * recipe-editor-model — 配方编辑器纯逻辑（ADR-0012 D1/D3/D4/D6）
 *
 * 组件只渲染，增删排序、Target 折返、settle/auth 表单映射与错误归位都在这里。
 * 由于项目未引入 @vue/test-utils，组件测试以这里的纯函数为准。
 */
import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import {
  authToForm,
  changeStepOp,
  cloneSteps,
  collectRecipeErrors,
  createStep,
  describeTargetForUi,
  duplicateStep,
  emptyRecipe,
  formToAuth,
  formToSettle,
  fromSimpleForm,
  hasRecipeErrors,
  insertAtCursor,
  insertStep,
  isPasswordLikeTarget,
  makeTarget,
  moveStep,
  passwordPlaintextWarning,
  recipeToFlatParams,
  removeStep,
  settleToForm,
  simpleShapeOf,
  suggestFillValue,
  targetKind,
  targetTypeWarning,
  targetValue,
  toSimpleForm,
  VARIABLE_HINTS,
} from '../entrypoints/tools/account-switch/config/recipe-editor-model';
import type {
  Recipe,
  RecipeStep,
} from '../entrypoints/tools/account-switch/strategies/generic-recipe';

const steps: RecipeStep[] = [
  { op: 'goto', url: '{origin}/login' },
  { op: 'fill', target: '#u', value: '{username}' },
  { op: 'click', target: '#go' },
];

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    version: 1,
    steps,
    settle: { type: 'formGone' },
    auth: { mode: 'page' },
    ...overrides,
  };
}

describe('步骤增删排序', () => {
  it('moveStep 上移 / 下移交换相邻项', () => {
    expect(moveStep(steps, 1, -1).map((s) => s.op)).toEqual([
      'fill',
      'goto',
      'click',
    ]);
    expect(moveStep(steps, 1, 1).map((s) => s.op)).toEqual([
      'goto',
      'click',
      'fill',
    ]);
  });

  it('越界移动原样返回（不产生空档、不改变长度）', () => {
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, steps.length - 1, 1)).toBe(steps);
  });

  it('removeStep 只删指定下标', () => {
    expect(removeStep(steps, 1).map((s) => s.op)).toEqual(['goto', 'click']);
  });

  it('insertStep 插在指定位置之后', () => {
    const next = insertStep(steps, 0, createStep('waitFor'));
    expect(next.map((s) => s.op)).toEqual(['goto', 'waitFor', 'fill', 'click']);
  });

  it('createStep 每种 op 都有可用默认值', () => {
    for (const op of [
      'goto',
      'fill',
      'click',
      'waitFor',
      'extract',
      'script',
    ] as const) {
      const step = createStep(op);
      expect(step.op).toBe(op);
    }
  });
});

describe('cloneSteps — 编辑器 props 深拷贝', () => {
  it('可克隆 reactive proxy（structuredClone 在这里会抛 DataCloneError）', () => {
    const source = reactive<RecipeStep[]>(
      JSON.parse(JSON.stringify(steps)) as RecipeStep[],
    );
    // 前提：源确实是 Vue Proxy，否则本用例测不到真实场景
    expect(() => structuredClone(source)).toThrow();

    const cloned = cloneSteps(source);
    expect(cloned).toEqual(steps);
    expect(cloned[1]).not.toBe(source[1]);
  });

  it('克隆与源互不影响（编辑步骤不会回写父组件状态）', () => {
    const source = reactive<RecipeStep[]>(
      JSON.parse(JSON.stringify(steps)) as RecipeStep[],
    );
    const cloned = cloneSteps(source);
    cloned[1] = { op: 'fill', target: '#renamed', value: '{username}' };
    expect((source[1] as Extract<RecipeStep, { op: 'fill' }>).target).toBe('#u');
  });
});

describe('Target 折返', () => {
  it('字符串简写按 CSS 处理', () => {
    expect(targetKind('#u')).toBe('css');
    expect(targetValue('#u')).toBe('#u');
  });

  it('kind + value → Target，CSS 用字符串简写', () => {
    expect(makeTarget('css', ' #u ')).toBe('#u');
    expect(makeTarget('label', '用户名')).toEqual({ label: '用户名' });
    expect(makeTarget('placeholder', '请输入账号')).toEqual({
      placeholder: '请输入账号',
    });
  });

  it('空值返回空串，交由结构校验拦截', () => {
    expect(makeTarget('css', '   ')).toBe('');
  });

  it('可读描述与执行器日志文案一致', () => {
    expect(describeTargetForUi({ label: '用户名' })).toBe('label「用户名」');
    expect(describeTargetForUi({ name: 'account' })).toBe('name=account');
    expect(describeTargetForUi({ text: '登录' })).toBe('文本「登录」');
    expect(describeTargetForUi('#u')).toBe('#u');
  });
});

describe('settle 表单往返', () => {
  it('默认组合 any[formGone, urlChanged] 显示为「默认」', () => {
    const form = settleToForm({
      type: 'any',
      of: [{ type: 'formGone' }, { type: 'urlChanged' }],
    });
    expect(form.kind).toBe('default');
    expect(formToSettle(form)).toEqual({
      type: 'any',
      of: [{ type: 'formGone' }, { type: 'urlChanged' }],
    });
  });

  it('每种单一条件往返不变', () => {
    const conditions = [
      { type: 'formGone' as const },
      { type: 'urlChanged' as const },
      { type: 'url' as const, glob: '*/dashboard*' },
      { type: 'selector' as const, target: '.welcome' },
      { type: 'cookie' as const, name: 'auth' },
      { type: 'storage' as const, area: 'local' as const, key: 'token' },
      { type: 'storage' as const, area: 'session' as const, key: 'sid' },
      { type: 'fixed' as const, ms: 3000 },
    ];
    for (const cond of conditions) {
      expect(formToSettle(settleToForm(cond))).toEqual(cond);
    }
  });

  it('固定等待对应 timeout 表单，0/非数字判为非法', () => {
    expect(settleToForm({ type: 'fixed', ms: 1500 })).toEqual({
      kind: 'timeout',
      value: '1500',
    });
    expect(formToSettle({ kind: 'timeout', value: '0' })).toBeNull();
    expect(formToSettle({ kind: 'timeout', value: 'abc' })).toBeNull();
  });

  it('值缺失的可配置条件返回 null（由校验提示）', () => {
    expect(formToSettle({ kind: 'url', value: '' })).toBeNull();
    expect(formToSettle({ kind: 'cookie', value: '  ' })).toBeNull();
  });

  it('组合条件显示为 custom，且不可由表单直接生成', () => {
    const form = settleToForm({
      type: 'all',
      of: [{ type: 'formGone' }, { type: 'cookie', name: 'auth' }],
    });
    expect(form.kind).toBe('custom');
    expect(form.value).toContain('全部成立');
    expect(formToSettle(form)).toBeNull();
  });

  it('selector 条件保留结构化定位（D5：TargetField 可拾取 label / name）', () => {
    const cond = { type: 'selector' as const, target: { label: '已登录' } };
    const form = settleToForm(cond);
    expect(form.target).toEqual({ label: '已登录' });
    expect(form.value).toBe('已登录');
    expect(formToSettle(form)).toEqual(cond);
  });
});

describe('拾取建议与类型提示（ADR-0013 D6）', () => {
  it('密码框建议 {password}', () => {
    expect(suggestFillValue({ tag: 'input', type: 'password' }, [])).toBe(
      '{password}',
    );
  });

  it('首个用户名字段建议 {username}，已有则不重复建议', () => {
    expect(suggestFillValue({ tag: 'input', type: 'text' }, [])).toBe(
      '{username}',
    );
    expect(
      suggestFillValue({ tag: 'input', type: 'email' }, ['', '{username}']),
    ).toBeNull();
  });

  it('非文本输入不产生建议', () => {
    expect(
      suggestFillValue({ tag: 'input', type: 'checkbox' }, []),
    ).toBeNull();
    expect(suggestFillValue({ tag: 'button' }, [])).toBeNull();
  });

  it('类型不匹配给警告但不拦截', () => {
    expect(targetTypeWarning('fill', { tag: 'button' })).toContain('不像可输入');
    expect(targetTypeWarning('fill', { tag: 'input', type: 'text' })).toBeNull();
    expect(targetTypeWarning('click', { tag: 'div' })).toContain('不是可点击');
    expect(targetTypeWarning('click', { tag: 'button' })).toBeNull();
    // locate 不做类型判断
    expect(targetTypeWarning('locate', { tag: 'div' })).toBeNull();
  });

  it('contenteditable / role=button 等非常规控件不误报', () => {
    expect(
      targetTypeWarning('fill', { tag: 'div', contentEditable: true }),
    ).toBeNull();
    expect(targetTypeWarning('click', { tag: 'div', role: 'button' })).toBeNull();
  });
});

describe('auth 表单往返与三态', () => {
  it('页面自管往返', () => {
    expect(formToAuth(authToForm({ mode: 'page' }))).toEqual({ mode: 'page' });
  });

  it('快照三态：all / none / 白名单', () => {
    const spec = {
      mode: 'snapshot' as const,
      cookies: 'all' as const,
      cookiesClear: 'none' as const,
      localStorage: ['token', 'user'] as string[],
      sessionStorage: 'all' as const,
    };
    expect(formToAuth(authToForm(spec))).toEqual(spec);
  });

  it('白名单为空时降级为 none（避免「白名单但什么都没写」）', () => {
    const form = authToForm({ mode: 'snapshot', cookies: ['auth'] });
    const spec = formToAuth({
      ...form,
      cookiesKind: 'names',
      cookiesNames: '  ,  ',
    });
    expect(spec).toMatchObject({ mode: 'snapshot', cookies: 'none' });
  });

  it('cookiesClear 缺省显示为 all（D8 默认精确 host 全清）', () => {
    expect(authToForm({ mode: 'snapshot' }).clearKind).toBe('all');
  });
});

describe('校验归位', () => {
  it('最少一步的合法配方可保存；非法步骤错误定位到对应行', () => {
    const valid = recipe({
      steps: [{ op: 'goto', url: '{origin}/login' }],
      settle: { type: 'url', glob: '*/home*' },
    });
    expect(hasRecipeErrors(collectRecipeErrors(valid))).toBe(false);

    const invalid = recipe({
      steps: [
        { op: 'goto', url: '{origin}/login' },
        { op: 'fill', target: '', value: '{username}' },
      ],
    });
    const errors = collectRecipeErrors(invalid);
    expect(errors.steps[1]).toBeDefined();
    expect(errors.steps[0]).toBeUndefined();
  });

  it('登录页 URL 错误归到 goto 步骤行', () => {
    const invalid = recipe({
      steps: [
        { op: 'fill', target: '#u', value: '{username}' },
        { op: 'goto', url: 'ftp://example.com/login' },
      ],
    });
    const errors = collectRecipeErrors(invalid);
    expect(errors.steps[1]?.join()).toContain('http/https');
    expect(errors.steps[0]).toBeUndefined();
  });

  it('定位写死框架自动生成的 id 时按行提示重新拾取', () => {
    const stale = recipe({
      steps: [
        { op: 'fill', target: '#el-id-9759-21', value: '{username}' },
        { op: 'fill', target: { css: '#el-id-9759-22' }, value: '{password}' },
        { op: 'click', target: { placeholder: '登 录' }, onNotFound: 'fail' },
      ],
      settle: { type: 'urlChanged' },
    });
    const errors = collectRecipeErrors(stale);
    expect(errors.steps[0]?.join()).toContain('自动生成的 id');
    expect(errors.steps[1]?.join()).toContain('自动生成的 id');
    // 语义定位（placeholder）不受影响
    expect(errors.steps[2]).toBeUndefined();
  });

  it('语义 id（如 #username）不产生自动 id 提示', () => {
    const ok = recipe({
      steps: [
        { op: 'fill', target: '#username', value: '{username}' },
        { op: 'fill', target: '#password', value: '{password}' },
        { op: 'click', target: '#login', onNotFound: 'fail' },
      ],
      settle: { type: 'urlChanged' },
    });
    expect(collectRecipeErrors(ok).steps).toEqual({});
  });

  it('默认空配方本身不可保存（定位为空）', () => {
    const errors = collectRecipeErrors(emptyRecipe());
    expect(hasRecipeErrors(errors)).toBe(true);
    // 三个空定位各归一行
    expect(Object.keys(errors.steps)).toHaveLength(3);
  });

  it('填完定位与判定值后即可保存', () => {
    const filled: Recipe = {
      ...emptyRecipe(),
      steps: [
        { op: 'goto', url: '{origin}/login' },
        { op: 'fill', target: '#u', value: '{username}' },
        { op: 'fill', target: '#p', value: '{password}' },
        { op: 'click', target: '#go' },
      ],
      settle: { type: 'urlChanged' },
    };
    expect(hasRecipeErrors(collectRecipeErrors(filled))).toBe(false);
  });

  it('配方新增的判定方式不会被旧扁平规则误报（formGone/urlChanged）', () => {
    for (const settle of [
      { type: 'formGone' as const },
      { type: 'urlChanged' as const },
      { type: 'storage' as const, area: 'session' as const, key: 'sid' },
    ]) {
      const errors = collectRecipeErrors(
        recipe({ steps: [{ op: 'goto', url: '{origin}/login' }], settle }),
      );
      expect(errors.settle).toEqual([]);
    }
  });
});

// ============================================================
// 简易模式（ADR-0013 D9）
// ============================================================

describe('simpleShapeOf / toSimpleForm / fromSimpleForm', () => {
  const simpleSteps: RecipeStep[] = [
    { op: 'goto', url: '{origin}/login' },
    { op: 'fill', target: '#u', value: '{username}' },
    { op: 'fill', target: '#p', value: '{password}' },
    { op: 'click', target: '#go' },
  ];

  it('标准三步 + goto 命中简易形态', () => {
    const shape = simpleShapeOf(recipe({ steps: simpleSteps }));
    expect(shape).toEqual({
      gotoIndex: 0,
      usernameIndex: 1,
      passwordIndex: 2,
      submitIndex: 3,
    });
  });

  it('没有 goto 的三步配方也命中（登录页 URL 为空）', () => {
    const steps = simpleSteps.slice(1);
    const form = toSimpleForm(recipe({ steps }));
    expect(form).toMatchObject({ loginUrl: '', username: '#u', submit: '#go' });
  });

  it('含 waitFor / extract / script 时返回 null', () => {
    for (const extra of [
      { op: 'waitFor' as const, when: { type: 'urlChanged' as const } },
      { op: 'extract' as const, source: 'url' as const },
      { op: 'script' as const, code: 'return 1' },
    ]) {
      expect(
        simpleShapeOf(recipe({ steps: [...simpleSteps, extra] })),
      ).toBeNull();
    }
  });

  it('值不是固定变量或步骤数量不符时返回 null', () => {
    const customValue: RecipeStep[] = [
      ...simpleSteps.slice(0, 3),
      { op: 'click', target: '#go' },
    ];
    customValue[1] = { op: 'fill', target: '#u', value: 'admin' };
    expect(simpleShapeOf(recipe({ steps: customValue }))).toBeNull();

    expect(
      simpleShapeOf(recipe({ steps: [...simpleSteps, { op: 'click', target: '#x' }] })),
    ).toBeNull();
  });

  it('往返无损：只有 goto 的 waitForLoad 显式 false 时保留', () => {
    const source = recipe({
      steps: [{ op: 'goto', url: '{origin}/login', waitForLoad: false }, ...simpleSteps.slice(1)],
      settle: { type: 'urlChanged' },
    });
    const form = toSimpleForm(source)!;
    expect(form.waitForLoad).toBe(false);
    expect(fromSimpleForm(source, form).steps).toEqual(source.steps);
  });

  it('往返无损：settle / auth / failWhen 原样保留', () => {
    const source = recipe({
      steps: simpleSteps,
      settle: { type: 'url', glob: '*/home*' },
      failWhen: { type: 'cookie', name: 'err' },
      auth: { mode: 'snapshot', cookies: 'all' },
    });
    const roundTrip = fromSimpleForm(source, toSimpleForm(source)!);
    expect(roundTrip.steps).toEqual(source.steps);
    expect(roundTrip.settle).toEqual(source.settle);
    expect(roundTrip.auth).toEqual(source.auth);
    expect(roundTrip.failWhen).toEqual(source.failWhen);
  });

  it('清空登录页 URL 时不生成 goto 步骤', () => {
    const source = recipe({ steps: simpleSteps });
    const form = { ...toSimpleForm(source)!, loginUrl: '   ' };
    expect(fromSimpleForm(source, form).steps.map((s) => s.op)).toEqual([
      'fill',
      'fill',
      'click',
    ]);
  });

  it('空配方（默认三行但无定位）也是简易形态', () => {
    const form = toSimpleForm(emptyRecipe());
    expect(form).toMatchObject({ loginUrl: '', username: '', password: '', submit: '' });
  });
});

// ============================================================
// 变量胶囊与明文密码提示（ADR-0013 D10）
// ============================================================

describe('变量胶囊（D10）', () => {
  it('变量清单来自执行器登记的变量名，不硬编码', () => {
    expect(VARIABLE_HINTS.map((h) => h.token)).toEqual([
      '{username}',
      '{password}',
      '{origin}',
      '{debugRedirect}',
    ]);
    for (const hint of VARIABLE_HINTS) expect(hint.label).toBeTruthy();
  });

  it('insertAtCursor 在光标处插入，无光标时追加到末尾', () => {
    expect(insertAtCursor('abc', '{username}', 1, 1)).toEqual({
      value: 'a{username}bc',
      cursor: 11,
    });
    expect(insertAtCursor('abc', '{origin}')).toEqual({
      value: 'abc{origin}',
      cursor: 11,
    });
  });

  it('insertAtCursor 替换选区', () => {
    expect(insertAtCursor('abc', '{password}', 0, 2)).toEqual({
      value: '{password}c',
      cursor: 10,
    });
  });

  it('密码框写明文时提示，使用变量或非密码框不提示', () => {
    expect(passwordPlaintextWarning('#password', 'admin123')).toContain(
      '{password}',
    );
    expect(passwordPlaintextWarning('#pwd', '')).toBeNull();
    expect(passwordPlaintextWarning('#password', '{password}')).toBeNull();
    expect(passwordPlaintextWarning('#username', 'admin123')).toBeNull();
    expect(passwordPlaintextWarning(null, 'admin123')).toBeNull();
  });

  it('isPasswordLikeTarget 识别 password / 密码', () => {
    expect(isPasswordLikeTarget({ css: 'input[type=password]' })).toBe(true);
    expect(isPasswordLikeTarget({ placeholder: '请输入密码' })).toBe(true);
    expect(isPasswordLikeTarget({ name: 'pwd' })).toBe(false);
  });
});

describe('编辑器小交互（ADR-0013 D12）', () => {
  it('fill → click 保留定位与 frame 范围，丢弃填充值', () => {
    const next = changeStepOp(
      {
        op: 'fill',
        target: { label: '用户名' },
        value: '{username}',
        frameId: 3,
        frameUrl: 'https://login.example.com/form',
      },
      'click',
    );
    expect(next).toEqual({
      op: 'click',
      target: { label: '用户名' },
      onNotFound: 'fail',
      frameId: 3,
      frameUrl: 'https://login.example.com/form',
    });
  });

  it('click → fill 保留定位，填充值按默认空串', () => {
    const next = changeStepOp(
      { op: 'click', target: '#submit', frameId: 2 },
      'fill',
    );
    expect(next).toEqual({ op: 'fill', target: '#submit', value: '', frameId: 2 });
  });

  it('fill → fill 不该发生（同 op 原样返回），fill → 非定位 op 不保留 target', () => {
    const fill: RecipeStep = { op: 'fill', target: '#u', value: '{username}' };
    expect(changeStepOp(fill, 'fill')).toBe(fill);
    expect(changeStepOp(fill, 'waitFor')).toEqual({
      op: 'waitFor',
      when: { type: 'urlChanged' },
    });
  });

  it('duplicateStep 插入到本行下方且是深拷贝', () => {
    const source: RecipeStep[] = [
      { op: 'fill', target: '#u', value: '{username}' },
      { op: 'click', target: '#go' },
    ];
    const next = duplicateStep(source, 0);
    expect(next).toHaveLength(3);
    expect(next[1]).toEqual(source[0]);
    expect(next[1]).not.toBe(source[0]);
    expect(next[2]).toBe(source[1]);
  });

  it('duplicateStep 越界时原样返回', () => {
    const source: RecipeStep[] = [{ op: 'click', target: '#go' }];
    expect(duplicateStep(source, 5)).toBe(source);
    expect(duplicateStep(source, -1)).toBe(source);
  });
});

describe('recipeToFlatParams — 复用扁平参数的组合校验', () => {
  it('取出首个 goto / settle / 单键 auth', () => {
    const params = recipeToFlatParams(
      recipe({
        settle: { type: 'url', glob: '*/home*' },
        auth: { mode: 'snapshot', cookies: ['auth'], cookiesClear: 'all' },
      }),
    );
    expect(params).toMatchObject({
      loginPageUrl: '{origin}/login',
      successType: 'url',
      successValue: '*/home*',
      authSource: 'cookie',
      authKey: 'auth',
    });
  });

  it('页面自管不产生 authSource（不触发「authKey 必填」）', () => {
    const params = recipeToFlatParams(recipe());
    expect(params.authSource).toBe('');
    expect(params.authKey).toBe('');
  });
});
