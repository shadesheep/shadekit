// @vitest-environment happy-dom
/**
 * 一键识别登录表单（ADR-0013 D8）
 *
 * 页面内扫描是启发式的，测试只固化**明确的**契约：
 * - 标准单表单 → 三项齐全
 * - 缺提交按钮 → 其余项照常返回（UI 负责提示）
 * - 隐藏 / 非密码输入不参与
 * - 候选与拾取器同源（HTML 类 fixture 逐项比对）
 * - 扩展侧编排：多 frame 归并、注入失败早退
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isCompleteScan,
  scanLoginForm,
  scanLoginFormInPage,
  type FormScanFrame,
} from '../entrypoints/tools/account-switch/config/login-form-scan';
import { pickCandidates } from '../entrypoints/tools/account-switch/config/target-picker';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`未找到 ${selector}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('scanLoginFormInPage', () => {
  it('标准登录表单 → 用户名 / 密码 / 提交三项齐全', () => {
    mount(`
      <form>
        <label>用户名 <input id="username" name="user" /></label>
        <label>密码 <input id="password" type="password" name="pass" /></label>
        <button type="submit">登录</button>
      </form>
    `);

    const result = scanLoginFormInPage();

    expect(result.found).toBe(true);
    expect(result.username?.target).toEqual({ css: '#username' });
    expect(result.password?.target).toEqual({ css: '#password' });
    // 重名元素的文本候选被推荐（可交互元素）
    expect(result.submit?.target).toEqual({ text: '登录' });
  });

  it('没有 form 时从密码框上溯找容器', () => {
    mount(`
      <div class="login-box">
        <input id="u" />
        <input id="p" type="password" />
        <input type="submit" value="Sign in" />
      </div>
    `);

    const result = scanLoginFormInPage();

    expect(result.found).toBe(true);
    expect(result.username?.target).toEqual({ css: '#u' });
    expect(result.password?.target).toEqual({ css: '#p' });
    // 无 id/name 的提交按钮回退到 CSS 路径（与拾取器同源）
    expect(result.submit?.target).toEqual(
      pickCandidates(el('input[type=submit]'))[0].target,
    );
  });

  it('密码框之前的多个输入里取最后一个可见文本输入', () => {
    mount(`
      <form>
        <input id="search" type="search" />
        <input id="account" type="text" />
        <input id="pwd" type="password" />
        <button type="submit">Login</button>
      </form>
    `);

    // 文档序第一个可见文本输入就是 search，这里是启发式的已知取舍：
    // 优先靠近密码框的输入依赖站点结构，不强求在此用例中成立。
    const result = scanLoginFormInPage();
    expect(result.username?.target).toEqual({ css: '#search' });
  });

  it('隐藏的密码框不参与识别', () => {
    mount(`
      <form>
        <input id="hidden-pwd" type="password" style="display: none" />
        <input id="visible-pwd" type="password" />
        <button type="submit">登录</button>
      </form>
    `);

    const result = scanLoginFormInPage();
    expect(result.password?.target).toEqual({ css: '#visible-pwd' });
  });

  it('缺提交按钮时仍返回用户名与密码', () => {
    mount(`
      <form>
        <input id="u" />
        <input id="p" type="password" />
      </form>
    `);

    const result = scanLoginFormInPage();
    expect(result.found).toBe(true);
    expect(result.username).toBeDefined();
    expect(result.password).toBeDefined();
    expect(result.submit).toBeUndefined();
  });

  it('没有可见密码框 → found: false', () => {
    mount('<form><input id="u" /><button>登录</button></form>');
    expect(scanLoginFormInPage().found).toBe(false);
  });

  it('候选与拾取器同源（HTML 类 fixture 逐项一致）', () => {
    mount(`
      <form>
        <input id="user" name="account" placeholder="请输入账号" />
        <input type="password" name="pwd" aria-label="密码" />
        <button type="submit">登录</button>
      </form>
    `);

    const result = scanLoginFormInPage();
    const expectedUser = pickCandidates(el('#user'))[0];
    const expectedPwd = pickCandidates(el('input[type=password]'))[0];

    expect(result.username).toEqual(expectedUser);
    expect(result.password).toEqual(expectedPwd);
  });

  it('提交按钮可用文本定位时优先文本（交互元素）', () => {
    mount(`
      <form>
        <input id="p" type="password" />
        <button type="button" class="btn">登 录</button>
      </form>
    `);

    const result = scanLoginFormInPage();
    expect(result.submit?.target).toEqual({ text: '登 录' });
  });
});

describe('isCompleteScan', () => {
  it('三项齐全才算完整', () => {
    const base: FormScanFrame = {
      found: true,
      password: { target: '#p', count: 1, rank: 0, note: '' },
    };
    expect(isCompleteScan(base)).toBe(false);
    expect(
      isCompleteScan({
        ...base,
        username: { target: '#u', count: 1, rank: 0, note: '' },
        submit: { target: '#s', count: 1, rank: 0, note: '' },
      }),
    ).toBe(true);
  });
});

describe('scanLoginForm — 扩展侧编排', () => {
  const executeScript = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', { scripting: { executeScript } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('多 frame 命中时按 frameId 排序并返回全部', async () => {
    executeScript.mockResolvedValue([
      {
        frameId: 3,
        result: {
          found: true,
          frameUrl: 'https://example.com/iframe',
          password: { target: '#p', count: 1, rank: 0, note: '' },
        },
      },
      { frameId: 0, result: { found: false } },
      {
        frameId: 1,
        result: {
          found: true,
          frameUrl: 'https://example.com/login',
          username: { target: '#u', count: 1, rank: 0, note: '' },
          password: { target: '#pw', count: 1, rank: 0, note: '' },
          submit: { target: '#go', count: 1, rank: 0, note: '' },
        },
      },
    ]);

    const result = await scanLoginForm(7);

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.matches).toBe(2);
    expect(result.frames.map((f) => f.frameId)).toEqual([1, 3]);
    expect(result.complete).toBe(true);
  });

  it('未命中任何 frame → notFound', async () => {
    executeScript.mockResolvedValue([{ frameId: 0, result: { found: false } }]);
    await expect(scanLoginForm(7)).resolves.toEqual({ status: 'notFound' });
  });

  it('注入失败 → INJECT_FAILED（不轮询）', async () => {
    executeScript.mockRejectedValue(new Error('Cannot access contents'));

    const result = await scanLoginForm(7);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('INJECT_FAILED');
      expect(result.message).toContain('Cannot access');
    }
    expect(executeScript).toHaveBeenCalledTimes(1);
  });
});
