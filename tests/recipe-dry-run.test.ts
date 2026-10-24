/**
 * 配方试跑（ADR-0012）
 *
 * 1. 步骤白名单：只执行导航 / 填充 / 等待；点击与脚本被拒绝执行
 * 2. 逐步骤状态返回（命中 / 未命中 / 跳过 / 错误码）
 * 3. 不写认证态、不提交登录、不落调试日志
 * 4. 消息协议声明 + 路由可达
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  waitForTabLoaded: vi.fn(async () => {}),
  waitForSettle: vi.fn(async () => ({ states: [] })),
  snapshotPasswordField: vi.fn(async () => true),
}));

vi.mock('../entrypoints/tools/account-switch/utils/tab-load', () => ({
  waitForTabLoaded: mocks.waitForTabLoaded,
}));

vi.mock('../entrypoints/tools/account-switch/strategies/generic-settle', async () => {
  const actual = await vi.importActual<
    typeof import('../entrypoints/tools/account-switch/strategies/generic-settle')
  >('../entrypoints/tools/account-switch/strategies/generic-settle');
  return {
    ...actual,
    waitForSettle: mocks.waitForSettle,
    snapshotPasswordField: mocks.snapshotPasswordField,
  };
});

const executeScript = vi.fn();
const tabsUpdate = vi.fn();

vi.stubGlobal('chrome', {
  tabs: { update: tabsUpdate, get: vi.fn(async () => ({ url: 'https://example.com/' })) },
  scripting: { executeScript },
  cookies: { getAll: vi.fn(async () => []) },
});

import {
  DRY_RUN_OPS,
  isDryRunnable,
  runRecipeDryRun,
  selectSteps,
} from '../entrypoints/tools/account-switch/strategies/generic-dry-run';
import type {
  Recipe,
  RecipeStep,
} from '../entrypoints/tools/account-switch/strategies/generic-recipe';
import { ErrorCodes } from '../entrypoints/tools/account-switch/utils/error-codes';

function recipe(steps: RecipeStep[]): Recipe {
  return {
    version: 1,
    steps,
    settle: { type: 'any', of: [{ type: 'formGone' }, { type: 'urlChanged' }] },
    auth: { mode: 'page' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeScript.mockResolvedValue([
    { frameId: 0, result: { status: 'ok', count: 1 } },
  ]);
  tabsUpdate.mockResolvedValue({});
  mocks.waitForSettle.mockResolvedValue({ states: [] });
});

describe('步骤白名单', () => {
  it('只允许导航 / 填充 / 等待', () => {
    expect([...DRY_RUN_OPS].sort()).toEqual(['fill', 'goto', 'waitFor']);
  });

  it('点击、脚本、提取都不可试跑', () => {
    expect(isDryRunnable({ op: 'click', target: '#x' })).toBe(false);
    expect(isDryRunnable({ op: 'script', code: 'return 1' })).toBe(false);
    expect(isDryRunnable({ op: 'extract', source: 'url' })).toBe(false);
    expect(isDryRunnable({ op: 'fill', target: '#x', value: 'a' })).toBe(true);
  });
});

describe('runRecipeDryRun', () => {
  it('点击与脚本被拒绝执行，且不触发 DOM 注入', async () => {
    const result = await runRecipeDryRun(9, 'https://example.com', 'pw', recipe([
      { op: 'click', target: '#submit' },
      { op: 'script', code: 'localStorage.clear()' },
    ]));
    expect(executeScript).not.toHaveBeenCalled();
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
    expect(result.steps.map((s) => s.op)).toEqual(['click', 'script']);
  });

  it('导航 + 填充 + 等待逐步骤执行并返回命中状态', async () => {
    const result = await runRecipeDryRun(
      9,
      'https://example.com',
      'pw',
      recipe([
        { op: 'goto', url: '{origin}/login' },
        { op: 'fill', target: '#username', value: '{username}' },
        { op: 'waitFor', when: { type: 'selector', target: '#welcome' } },
      ]),
    );
    expect(tabsUpdate).toHaveBeenCalledWith(9, {
      url: 'https://example.com/login',
    });
    expect(result.steps.map((s) => [s.op, s.status])).toEqual([
      ['goto', 'success'],
      ['fill', 'success'],
      ['waitFor', 'success'],
    ]);
    // 填充使用占位账号，不写真密码
    const fillArgs = executeScript.mock.calls[0][0].args[0];
    expect(fillArgs).toMatchObject({ action: 'fill', value: 'devtools-dryrun' });
  });

  it('定位失败：该行返回错误码，后续步骤继续执行（逐行反馈）', async () => {
    executeScript.mockResolvedValueOnce([
      { frameId: 0, result: { status: 'notFound', count: 0 } },
    ]);
    const result = await runRecipeDryRun(
      9,
      'https://example.com',
      'pw',
      recipe([
        { op: 'fill', target: '#missing', value: '{username}' },
        { op: 'fill', target: '#ok', value: '{username}' },
      ]),
    );
    expect(result.steps[0]).toMatchObject({
      status: 'error',
      errorCode: ErrorCodes.ELEMENT_NOT_FOUND,
      target: '#missing',
    });
    expect(result.steps[1].status).toBe('success');
  });

  it('导航后不执行等待加载（试跑不阻塞配置页）', async () => {
    await runRecipeDryRun(
      9,
      'https://example.com',
      'pw',
      recipe([{ op: 'goto', url: '/login' }]),
    );
    expect(mocks.waitForTabLoaded).not.toHaveBeenCalled();
  });

  it('不写认证态、不跑 settle 收尾、不返回 tokenData', async () => {
    const result = await runRecipeDryRun(
      9,
      'https://example.com',
      'pw',
      recipe([{ op: 'fill', target: '#u', value: '{username}' }]),
    );
    expect(mocks.waitForSettle).not.toHaveBeenCalled();
    expect(result.tokenData).toBeUndefined();
    expect(chrome.cookies.getAll).not.toHaveBeenCalled();
  });
});

describe('单步试跑（ADR-0013 D11）', () => {
  const threeSteps: RecipeStep[] = [
    { op: 'goto', url: '/login' },
    { op: 'fill', target: '#username', value: '{username}' },
    { op: 'fill', target: '#password', value: '{password}' },
  ];

  it('only 只返回指定下标的结果，其余步骤不执行', async () => {
    const result = await runRecipeDryRun(
      9,
      'https://example.com',
      'pw',
      recipe(threeSteps),
      [2],
    );
    expect(result.steps.map((s) => s.index)).toEqual([2]);
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('未指定 only 时行为与整条试跑一致', async () => {
    const result = await runRecipeDryRun(
      9,
      'https://example.com',
      'pw',
      recipe(threeSteps),
    );
    expect(result.steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('空数组 / 全是越界下标 → 按整条试跑（不返回空集合）', async () => {
    for (const only of [[], [-1, 99], [1.5]]) {
      const result = await runRecipeDryRun(
        9,
        'https://example.com',
        'pw',
        recipe(threeSteps),
        only,
      );
      expect(result.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    }
  });

  it('selectSteps 去重并保持步骤顺序', () => {
    expect(selectSteps(recipe(threeSteps), [2, 0, 2])).toEqual([0, 2]);
    expect(selectSteps(recipe(threeSteps))).toEqual([0, 1, 2]);
  });
});

describe('消息协议', () => {
  it('TEST_RECIPE 已声明且路由到 account-switch', async () => {
    const { allTools } = await import('../entrypoints/shared/tool-definitions');
    const tool = allTools.find((t) => t.id === 'account-switch');
    expect(tool?.backgroundHandlers).toHaveProperty('TEST_RECIPE');
    expect(
      (tool?.backgroundHandlers as Record<string, unknown>)?.TEST_RECIPE,
    ).toEqual(expect.any(Function));
    // 类型层声明在 BackgroundMessageMap（编译期）；此处确认发送端可用
    const { sendBgMessage } = await import('../entrypoints/shared/messages');
    expect(typeof sendBgMessage).toBe('function');
  });
});
