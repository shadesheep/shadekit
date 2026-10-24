/**
 * generic-dom — 跨 frame 执行与归并（ADR-0012 D12）
 *
 * 覆盖：iframe 内命中、shadow root 内命中（由 generic-target 单测覆盖）、
 * 多 frame 冲突、非法选择器、注入失败与 onNotFound: skip 的错误映射。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeScript = vi.fn();

vi.stubGlobal('chrome', {
  scripting: { executeScript },
  tabs: { get: vi.fn() },
});

import {
  runDomAction,
  runDomRead,
  toTargetError,
} from '../entrypoints/tools/account-switch/strategies/generic-dom';
import { ErrorCodes } from '../entrypoints/tools/account-switch/utils/error-codes';

function frames(
  results: Array<{ frameId: number; result: Record<string, unknown> }>,
) {
  executeScript.mockResolvedValue(results);
}

beforeEach(() => {
  executeScript.mockReset();
  frames([]);
});

describe('runDomAction', () => {
  it('主文档命中 → ok 且带 frameId', async () => {
    frames([{ frameId: 0, result: { status: 'ok', count: 1 } }]);
    await expect(
      runDomAction(1, { action: 'locate', target: '#u' }),
    ).resolves.toEqual({ status: 'ok', frameId: 0 });
  });

  it('iframe 内命中 → ok，frameId 为子 frame', async () => {
    frames([
      { frameId: 0, result: { status: 'notFound', count: 0 } },
      { frameId: 3, result: { status: 'ok', count: 1 } },
    ]);
    await expect(
      runDomAction(1, { action: 'fill', target: { label: '用户名' }, value: 'u', clearFirst: true }),
    ).resolves.toEqual({ status: 'ok', frameId: 3 });
  });

  it('多个 frame 同时命中 → ambiguous（不猜测）', async () => {
    frames([
      { frameId: 0, result: { status: 'ok', count: 1 } },
      { frameId: 2, result: { status: 'ok', count: 1 } },
    ]);
    const outcome = await runDomAction(1, { action: 'click', target: '.login' });
    expect(outcome.status).toBe('ambiguous');
    if (outcome.status === 'ambiguous') {
      expect(outcome.frameId).toBe(-1);
      expect(outcome.message).toContain('frame 2');
    }
  });

  it('单 frame 内歧义 → ambiguous 携带命中数', async () => {
    frames([
      {
        frameId: 0,
        result: { status: 'ambiguous', count: 2, message: '命中 2 个' },
      },
    ]);
    const outcome = await runDomAction(1, { action: 'locate', target: 'input' });
    expect(outcome.status).toBe('ambiguous');
    if (outcome.status === 'ambiguous') expect(outcome.count).toBe(2);
  });

  it('非法选择器 → invalid', async () => {
    frames([
      {
        frameId: 0,
        result: { status: 'invalid', count: 0, message: 'bad selector' },
      },
    ]);
    const outcome = await runDomAction(1, {
      action: 'locate',
      target: '[[[',
    });
    expect(outcome.status).toBe('invalid');
  });

  it('记录 frameId 时只在该 frame 内命中（D14）', async () => {
    frames([
      { frameId: 0, result: { status: 'ok', count: 1 } },
      { frameId: 4, result: { status: 'ok', count: 1 } },
    ]);
    await expect(
      runDomAction(1, { action: 'locate', target: '#u' }, { frameId: 4 }),
    ).resolves.toEqual({ status: 'ok', frameId: 4 });
  });

  it('只记录 frameUrl 时按 URL 命中，忽略其他 frame', async () => {
    frames([
      {
        frameId: 0,
        result: { status: 'ok', count: 1, frameUrl: 'https://example.com/' },
      },
      {
        frameId: 4,
        result: {
          status: 'ok',
          count: 1,
          frameUrl: 'https://login.example.com/form',
        },
      },
    ]);
    await expect(
      runDomAction(1, { action: 'locate', target: '#u' }, {
        frameUrl: 'https://login.example.com/form',
      }),
    ).resolves.toEqual({ status: 'ok', frameId: 4 });
  });

  it('记录的 frame 已不存在 → frameMissing / FRAME_NOT_FOUND', async () => {
    // 没有 frameUrl 时按 frameId 判断；子 frame 已随导航消失
    frames([{ frameId: 0, result: { status: 'ok', count: 1 } }]);
    const outcome = await runDomAction(
      1,
      { action: 'click', target: '#go' },
      { frameId: 7 },
    );
    expect(outcome.status).toBe('frameMissing');
    const error = toTargetError(outcome, '#go');
    expect(error?.code).toBe(ErrorCodes.FRAME_NOT_FOUND);
  });

  it('frameUrl 优先于 frameId（导航后 frameId 会变）', async () => {
    // 记录时 frameId=4，导航后变成 9，但 URL 未变
    frames([
      {
        frameId: 9,
        result: {
          status: 'ok',
          count: 1,
          frameUrl: 'https://login.example.com/form',
        },
      },
    ]);
    await expect(
      runDomAction(1, { action: 'locate', target: '#u' }, {
        frameId: 4,
        frameUrl: 'https://login.example.com/form',
      }),
    ).resolves.toEqual({ status: 'ok', frameId: 9 });
  });

  it('frameUrl 比较放宽到 origin+pathname：query / hash 变化仍命中（D7）', async () => {
    frames([
      {
        frameId: 9,
        result: {
          status: 'ok',
          count: 1,
          frameUrl: 'https://login.example.com/form?step=2#top',
        },
      },
    ]);
    await expect(
      runDomAction(1, { action: 'locate', target: '#u' }, {
        frameId: 4,
        frameUrl: 'https://login.example.com/form?step=1',
      }),
    ).resolves.toEqual({ status: 'ok', frameId: 9 });
  });

  it('frameUrl 的 path 不同 → frameMissing（不静默回退）', async () => {
    frames([
      {
        frameId: 9,
        result: {
          status: 'ok',
          count: 1,
          frameUrl: 'https://login.example.com/other',
        },
      },
    ]);
    const outcome = await runDomAction(
      1,
      { action: 'locate', target: '#u' },
      { frameId: 4, frameUrl: 'https://login.example.com/form' },
    );
    expect(outcome.status).toBe('frameMissing');
  });

  it('主 frame 只记录 frameId 时，SPA 路由变化不影响命中（D7）', async () => {
    frames([
      {
        frameId: 0,
        result: { status: 'ok', count: 1, frameUrl: 'https://example.com/app#/other' },
      },
    ]);
    await expect(
      runDomAction(1, { action: 'locate', target: '#u' }, { frameId: 0 }),
    ).resolves.toEqual({ status: 'ok', frameId: 0 });
  });

  it('注入失败（受限页面）→ error', async () => {
    executeScript.mockRejectedValue(
      new Error('Cannot access contents of the page'),
    );
    const outcome = await runDomAction(1, { action: 'locate', target: '#u' });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.message).toContain('Cannot access');
    }
  });

  it('全部未命中 → notFound', async () => {
    frames([
      { frameId: 0, result: { status: 'notFound', count: 0 } },
      { frameId: 1, result: { status: 'notFound', count: 0 } },
    ]);
    await expect(
      runDomAction(1, { action: 'locate', target: '#nope' }),
    ).resolves.toEqual({ status: 'notFound' });
  });

  it('每个 DOM 步骤都用 allFrames + MAIN world', async () => {
    await runDomAction(1, { action: 'locate', target: '#u' });
    const injection = executeScript.mock.calls[0][0] as Record<string, unknown>;
    expect(injection).toMatchObject({
      target: { tabId: 1, allFrames: true },
      world: 'MAIN',
    });
    expect(typeof injection.func).toBe('function');
  });
});

describe('toTargetError', () => {
  it('ok → null', () => {
    expect(toTargetError({ status: 'ok', frameId: 0 }, '#u')).toBeNull();
  });

  it('notFound → ELEMENT_NOT_FOUND；skip 时返回 null', () => {
    const error = toTargetError({ status: 'notFound' }, '#u');
    expect(error?.code).toBe(ErrorCodes.ELEMENT_NOT_FOUND);
    expect(toTargetError({ status: 'notFound' }, '#u', 'skip')).toBeNull();
  });

  it('ambiguous → AMBIGUOUS_TARGET（skip 也不放过）', () => {
    const error = toTargetError(
      { status: 'ambiguous', frameId: -1, count: 2, message: '多 frame' },
      '#u',
      'skip',
    );
    expect(error?.code).toBe(ErrorCodes.AMBIGUOUS_TARGET);
    expect(error?.message).toContain('多 frame');
  });

  it('invalid → SELECTOR_INVALID', () => {
    const error = toTargetError(
      { status: 'invalid', message: 'bad' },
      '[[[',
    );
    expect(error?.code).toBe(ErrorCodes.SELECTOR_INVALID);
  });

  it('注入 error → ELEMENT_NOT_FOUND 并保留原因', () => {
    const error = toTargetError(
      { status: 'error', message: 'Cannot access' },
      '#u',
    );
    expect(error?.code).toBe(ErrorCodes.ELEMENT_NOT_FOUND);
    expect(error?.message).toContain('Cannot access');
  });
});

describe('runDomRead', () => {
  it('唯一命中 → 返回该 frame 的文本', async () => {
    frames([
      { frameId: 0, result: { status: 'notFound', count: 0 } },
      { frameId: 4, result: { status: 'ok', count: 1, value: '欢迎回来' } },
    ]);
    await expect(runDomRead(1, '.welcome')).resolves.toEqual({
      ok: true,
      value: '欢迎回来',
    });
  });

  it('未命中 → ELEMENT_NOT_FOUND', async () => {
    frames([{ frameId: 0, result: { status: 'notFound', count: 0 } }]);
    const result = await runDomRead(1, '.gone');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.ELEMENT_NOT_FOUND);
    }
  });

  it('多 frame 命中 → AMBIGUOUS_TARGET，不静默取第一个', async () => {
    frames([
      { frameId: 0, result: { status: 'ok', count: 1, value: 'a' } },
      { frameId: 2, result: { status: 'ok', count: 1, value: 'b' } },
    ]);
    const result = await runDomRead(1, '.item');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.AMBIGUOUS_TARGET);
    }
  });

  it('选择器非法 → SELECTOR_INVALID', async () => {
    frames([{ frameId: 0, result: { status: 'invalid', count: 0, message: 'bad' } }]);
    const result = await runDomRead(1, '[[[');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.SELECTOR_INVALID);
    }
  });
});
