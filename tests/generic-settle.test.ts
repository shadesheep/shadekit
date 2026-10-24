/**
 * generic-settle — 成功 / 失败判定（ADR-0012 D4 / D5）
 *
 * chrome.* 用内存 fake；计时用假定时器断言真实耗时与超时行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeScript = vi.fn();
const tabsGet = vi.fn();
const cookiesGetAll = vi.fn();

vi.stubGlobal('chrome', {
  tabs: { get: tabsGet },
  cookies: { getAll: cookiesGetAll },
  scripting: { executeScript },
});

import {
  CAPTCHA_PATTERN,
  describeCondition,
  detectCaptcha,
  evaluateCondition,
  snapshotPasswordField,
  waitForSettle,
} from '../entrypoints/tools/account-switch/strategies/generic-settle';
import { ErrorCodes } from '../entrypoints/tools/account-switch/utils/error-codes';
import type { SettleCondition } from '../entrypoints/tools/account-switch/strategies/generic-recipe';

/** 让 runDomAction 在「主 frame」返回指定结果 */
function domReturns(status: 'ok' | 'notFound' | 'ambiguous', count = 1) {
  executeScript.mockResolvedValue([
    { frameId: 0, result: { status, count } },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  executeScript.mockReset();
  tabsGet.mockReset();
  cookiesGetAll.mockReset();
  tabsGet.mockResolvedValue({ url: 'https://example.com/login' });
  cookiesGetAll.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('describeCondition', () => {
  it('全部类型都有可读描述', () => {
    const cases: SettleCondition[] = [
      { type: 'formGone' },
      { type: 'urlChanged' },
      { type: 'url', glob: '*/home*' },
      { type: 'selector', target: '.welcome' },
      { type: 'cookie', name: 'auth' },
      { type: 'storage', area: 'local', key: 'token' },
      { type: 'storage', area: 'session', key: 'sid' },
      { type: 'fixed', ms: 300 },
      { type: 'any', of: [{ type: 'formGone' }, { type: 'urlChanged' }] },
      { type: 'all', of: [{ type: 'cookie', name: 'a' }] },
    ];
    for (const cond of cases) {
      expect(describeCondition(cond).length).toBeGreaterThan(0);
    }
    expect(describeCondition({ type: 'url', glob: '*/home*' })).toContain(
      '*/home*',
    );
  });
});

describe('evaluateCondition', () => {
  it('formGone：密码框存在 → 消失后为真', async () => {
    domReturns('notFound');
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'formGone' },
      ),
    ).resolves.toBe(true);
  });

  it('formGone：页面本来就没有密码框 → 恒为假（不误判）', async () => {
    // 即使 locate 返回 notFound 也不应判定成功
    domReturns('notFound');
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: false },
        { type: 'formGone' },
      ),
    ).resolves.toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('urlChanged：以首次取值为基准，之后变化才为真', async () => {
    const baseline = {};
    tabsGet.mockResolvedValue({ url: 'https://example.com/login' });
    await expect(
      evaluateCondition({ tabId: 1, passwordFieldPresent: true }, { type: 'urlChanged' }, baseline),
    ).resolves.toBe(false);

    tabsGet.mockResolvedValue({ url: 'https://example.com/home' });
    await expect(
      evaluateCondition({ tabId: 1, passwordFieldPresent: true }, { type: 'urlChanged' }, baseline),
    ).resolves.toBe(true);
  });

  it('url 通配符匹配', async () => {
    tabsGet.mockResolvedValue({ url: 'https://example.com/home/index' });
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'url', glob: '*/home*' },
      ),
    ).resolves.toBe(true);
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'url', glob: '*/login' },
      ),
    ).resolves.toBe(false);
  });

  it('selector：出现为真', async () => {
    domReturns('ok');
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'selector', target: '.welcome' },
      ),
    ).resolves.toBe(true);
  });

  it('selector：非法选择器抛 SELECTOR_INVALID（不吞成超时）', async () => {
    executeScript.mockResolvedValue([
      { frameId: 0, result: { status: 'invalid', count: 0, message: 'bad' } },
    ]);
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'selector', target: '[[[' },
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.SELECTOR_INVALID });
  });

  it('cookie：存在为真', async () => {
    cookiesGetAll.mockResolvedValue([{ name: 'auth', value: '1' }]);
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'cookie', name: 'auth' },
      ),
    ).resolves.toBe(true);
    cookiesGetAll.mockResolvedValue([]);
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'cookie', name: 'auth' },
      ),
    ).resolves.toBe(false);
  });

  it('storage：任一 frame 存在即为真', async () => {
    executeScript.mockResolvedValue([
      { frameId: 0, result: false },
      { frameId: 2, result: true },
    ]);
    await expect(
      evaluateCondition(
        { tabId: 1, passwordFieldPresent: true },
        { type: 'storage', area: 'session', key: 'sid' },
      ),
    ).resolves.toBe(true);
  });

  it('any / all 组合', async () => {
    domReturns('ok');
    const any: SettleCondition = {
      type: 'any',
      of: [{ type: 'selector', target: '.a' }, { type: 'selector', target: '.b' }],
    };
    await expect(
      evaluateCondition({ tabId: 1, passwordFieldPresent: true }, any),
    ).resolves.toBe(true);

    domReturns('notFound');
    await expect(
      evaluateCondition({ tabId: 1, passwordFieldPresent: true }, any),
    ).resolves.toBe(false);

    cookiesGetAll.mockResolvedValue([{ name: 'x' }]);
    const all: SettleCondition = {
      type: 'all',
      of: [{ type: 'cookie', name: 'x' }, { type: 'selector', target: '.a' }],
    };
    await expect(
      evaluateCondition({ tabId: 1, passwordFieldPresent: true }, all),
    ).resolves.toBe(false);
  });
});

describe('detectCaptcha / snapshotPasswordField', () => {
  it('验证码文案命中', async () => {
    executeScript.mockResolvedValue([
      { frameId: 0, result: { status: 'ok', count: 1, message: CAPTCHA_PATTERN } },
    ]);
    await expect(detectCaptcha(1)).resolves.toBe(true);
  });

  it('密码框快照：命中或歧义都算存在', async () => {
    domReturns('ambiguous', 2);
    await expect(snapshotPasswordField(1)).resolves.toBe(true);
    domReturns('notFound', 0);
    await expect(snapshotPasswordField(1)).resolves.toBe(false);
  });
});

describe('waitForSettle', () => {
  it('失败条件优先于成功条件：同一周期命中 failWhen 即报 LOGIN_REJECTED', async () => {
    // selector 条件：failWhen 与 settle 都会命中
    domReturns('ok');
    const promise = waitForSettle({
      tabId: 1,
      settle: { type: 'selector', target: '.welcome' },
      failWhen: { type: 'selector', target: '.error' },
      timeoutMs: 5000,
      passwordFieldPresent: true,
    });
    await expect(promise).rejects.toMatchObject({
      code: ErrorCodes.LOGIN_REJECTED,
    });
  });

  it('固定等待真实 sleep 指定毫秒（D5）', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    let now = 0;
    nowSpy.mockImplementation(() => now);

    const promise = waitForSettle({
      tabId: 1,
      settle: { type: 'fixed', ms: 300 },
      timeoutMs: 5000,
      passwordFieldPresent: true,
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    now = 300;
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ states: [{ met: true }] });
  });

  it('超时报 SUCCESS_CONDITION_UNMET 并携带最后一次条件状态', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    domReturns('notFound');

    const promise = waitForSettle({
      tabId: 1,
      settle: { type: 'selector', target: '.welcome' },
      timeoutMs: 600,
      pollingIntervalMs: 100,
      passwordFieldPresent: true,
    });
    // 轮询循环会不断重新排定时器，逐段推进直到它结束
    const settled = promise.then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    for (let i = 0; i < 20; i++) {
      now += 100;
      await vi.advanceTimersByTimeAsync(100);
    }
    const error = await settled;
    expect(error?.code).toBe(ErrorCodes.SUCCESS_CONDITION_UNMET);
    expect(error?.message).toContain('成功判定条件未满足');
    expect(error?.message).toContain('元素出现 .welcome');
  });

  it('urlChanged 优先用预采基准：基准与当前 URL 不同即视为已变化', async () => {
    // 点击提交后页面已跳到 home（快速站点在首次轮询前就完成跳转），
    // 基准由执行器在 click 前预采为 login —— 应判定「已变化」而不是
    // 把当前地址误采为基准导致永不满足。
    tabsGet.mockResolvedValue({ url: 'https://example.com/home' });
    domReturns('notFound'); // detectCaptcha 扫描不命中
    await expect(
      waitForSettle({
        tabId: 1,
        settle: { type: 'urlChanged' },
        timeoutMs: 5000,
        passwordFieldPresent: false,
        baselineUrl: 'https://example.com/login',
      }),
    ).resolves.toMatchObject({ states: [{ met: true }] });
  });

  it('验证码页报 CAPTCHA_REQUIRED', async () => {
    // 第一次调用是 failWhen 判定前没有 failWhen → 直接 detectCaptcha
    executeScript.mockResolvedValue([
      { frameId: 0, result: { status: 'ok', count: 1, message: CAPTCHA_PATTERN } },
    ]);
    await expect(
      waitForSettle({
        tabId: 1,
        settle: { type: 'urlChanged' },
        timeoutMs: 5000,
        passwordFieldPresent: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.CAPTCHA_REQUIRED });
  });

  it('默认判定零配置可用：表单消失即成功', async () => {
    let call = 0;
    executeScript.mockImplementation(async () => {
      call++;
      // 前两次是「登录前快照」之外的轮询：返回 notFound 表示表单已消失
      return [{ frameId: 0, result: { status: 'notFound', count: 0 } }];
    });
    await expect(
      waitForSettle({
        tabId: 1,
        settle: { type: 'formGone' },
        timeoutMs: 1000,
        passwordFieldPresent: true,
      }),
    ).resolves.toMatchObject({ states: [{ met: true }] });
    expect(call).toBeGreaterThan(0);
  });
});
