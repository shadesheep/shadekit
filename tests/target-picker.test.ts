// @vitest-environment happy-dom
/**
 * 定位拾取器（ADR-0012 D14，ADR-0013 D1/D2/D3 批次 0）
 *
 * 覆盖：
 * - 元素 → 结构化 Target 的优先级、唯一的降级路径
 * - 标签页排序（同 origin 优先）
 * - 页面内状态机（idle / active / picked / cancelled）与悬停浮层
 * - 扩展侧编排 `startTargetPicker`：四态结果、注入失败早退、会话丢失、回切来源 tab
 *
 * 浮层的高亮「视觉效果」仍由手测覆盖；这里只断言节点的存在、文案与清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countTargetMatches,
  elementMetaOf,
  isClickableElement,
  isFillableElement,
  isVolatileId,
  pickCandidates,
  pickTargetFromElement,
  pickerInPage,
  preferredCandidate,
  rankPickerTabs,
  startTargetPicker,
  type PickerState,
} from '../entrypoints/tools/account-switch/config/target-picker';
import { scanLoginFormInPage } from '../entrypoints/tools/account-switch/config/login-form-scan';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`未找到 ${selector}`);
  return found;
}

/** 当前页面上的拾取浮层节点 */
function overlay(): HTMLElement | null {
  return document.querySelector('[data-dt-picker-overlay]');
}

function hover(target: Element): void {
  target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__devtools_picker__;
});

describe('pickTargetFromElement — 优先级', () => {
  it('唯一的 id → { css: "#id" }', () => {
    mount('<input id="username" name="u" />');
    expect(pickTargetFromElement(el('#username'))).toEqual({
      css: '#username',
    });
  });

  it('重复的 id 降级到 name', () => {
    mount('<input id="dup" name="account" /><input id="dup" />');
    // 两个同名 id：querySelectorAll('#dup').length === 2 → 不唯一
    expect(pickTargetFromElement(document.querySelectorAll('input')[0])).toEqual({
      name: 'account',
    });
  });

  it('无 id → name', () => {
    mount('<input name="password" />');
    expect(pickTargetFromElement(el('input'))).toEqual({ name: 'password' });
  });

  it('无 id/name → 唯一的 aria-label', () => {
    mount('<input aria-label="用户名" /><input aria-label="密码" />');
    expect(pickTargetFromElement(document.querySelectorAll('input')[1])).toEqual({
      ariaLabel: '密码',
    });
  });

  it('name 不唯一时降级到 label 文本', () => {
    mount(`
      <label>用户名 <input name="user" /></label>
      <input name="user" />
    `);
    expect(pickTargetFromElement(el('label input'))).toMatchObject({
      label: '用户名',
    });
  });

  it('包裹式 label 也能取到文本', () => {
    mount('<label>密码 <input type="password" /></label>');
    expect(pickTargetFromElement(el('input'))).toEqual({ label: '密码' });
  });

  it('无 label → placeholder', () => {
    mount('<input placeholder="请输入账号" />');
    expect(pickTargetFromElement(el('input'))).toEqual({
      placeholder: '请输入账号',
    });
  });

  it('按钮的可见文本 → { text }', () => {
    mount('<button>登 录</button>');
    expect(pickTargetFromElement(el('button'))).toEqual({ text: '登 录' });
  });

  it('普通 div 的文本不当作定位，回退到 CSS 路径', () => {
    mount('<div><span>欢迎</span></div>');
    const picked = pickTargetFromElement(el('span'));
    expect(picked).toHaveProperty('css');
    expect((picked as { css: string }).css).toContain('span');
  });

  it('CSS 路径包含 nth-of-type 以保持唯一', () => {
    mount('<ul><li>a</li><li><span>x</span></li></ul>');
    const picked = pickTargetFromElement(el('li:nth-of-type(2) span'));
    expect(picked).toHaveProperty('css');
  });
});

describe('pickerInPage — 幂等启停', () => {
  it('start → state 为 active；stop 后回到 idle（不再伪装成 cancelled）', () => {
    mount('<input id="a" />');
    const started = pickerInPage('start');
    expect(started.status).toBe('active');
    expect(pickerInPage('state').status).toBe('active');
    expect(pickerInPage('stop').status).toBe('idle');
    expect(pickerInPage('state').status).toBe('idle');
  });

  it('从未 start 时 state 直接返回 idle', () => {
    mount('<input id="a" />');
    expect(pickerInPage('state').status).toBe('idle');
  });

  it('重复 start 复用同一会话，不重复绑定监听', () => {
    mount('<input id="a" />');
    const first = pickerInPage('start');
    const second = pickerInPage('start');
    expect(second).toEqual(first);
    pickerInPage('stop');
  });

  it('重复 stop 幂等', () => {
    mount('<input id="a" />');
    pickerInPage('start');
    expect(() => {
      pickerInPage('stop');
      pickerInPage('stop');
    }).not.toThrow();
  });

  it('点击捕获后解绑，且不触发页面自身的点击', () => {
    mount('<button id="submit">登录</button>');
    const pageClick = vi.fn();
    el('#submit').addEventListener('click', pageClick);

    pickerInPage('start');
    el('#submit').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    const state = pickerInPage('state') as PickerState;
    expect(state.status).toBe('picked');
    expect(state.target).toEqual({ css: '#submit' });
    // 捕获阶段 preventDefault + stopPropagation：真实点击未被触发
    expect(pageClick).not.toHaveBeenCalled();

    pickerInPage('stop');
  });

  it('Esc 取消', () => {
    mount('<input id="a" />');
    pickerInPage('start');
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(pickerInPage('state').status).toBe('cancelled');
    pickerInPage('stop');
  });

  it('已结束的会话再次 start 时重建（不复用 cancelled 状态）', () => {
    mount('<input id="a" />');
    pickerInPage('start');
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(pickerInPage('start').status).toBe('active');
    pickerInPage('stop');
  });
});

describe('pickerInPage — 悬停预览浮层（D3）', () => {
  it('悬停时显示将使用的定位与命中数', () => {
    mount('<input id="username" />');
    pickerInPage('start');
    hover(el('#username'));

    const box = overlay();
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('将使用：#username');
    expect(box!.textContent).toContain('命中 1 个元素');
    pickerInPage('stop');
  });

  it('命中多个时给出歧义警告', () => {
    // id/name 非唯一时会降级到 nth-of-type 路径（必然唯一），
    // 所以用占位符路径构造「真的会命中多个」的定位
    mount('<input placeholder="账号" /><input placeholder="账号" />');
    pickerInPage('start');
    hover(el('input'));

    const box = overlay();
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('命中 2 个');
    expect(box!.textContent).toContain('歧义');
    pickerInPage('stop');
  });

  it('浮层文本按纯文本渲染，不解析页面文案里的 HTML', () => {
    mount('<input placeholder="<img src=x onerror=alert(1)>" />');
    pickerInPage('start');
    hover(el('input'));

    const box = overlay();
    expect(box).not.toBeNull();
    expect(box!.querySelector('img')).toBeNull();
    expect(box!.textContent).toContain('<img src=x onerror=alert(1)>');
    pickerInPage('stop');
  });

  it('拾取、Esc、stop 都会移除浮层', () => {
    mount('<button id="go">登录</button>');
    pickerInPage('start');
    hover(el('#go'));
    expect(overlay()).not.toBeNull();

    el('#go').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(overlay()).toBeNull();

    // Esc
    pickerInPage('start');
    hover(el('#go'));
    expect(overlay()).not.toBeNull();
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(overlay()).toBeNull();

    // stop
    pickerInPage('start');
    hover(el('#go'));
    expect(overlay()).not.toBeNull();
    pickerInPage('stop');
    expect(overlay()).toBeNull();
  });

  it('滚动时隐藏浮层（位置会漂）', () => {
    mount('<input id="a" />');
    pickerInPage('start');
    hover(el('#a'));
    expect(overlay()).not.toBeNull();

    document.dispatchEvent(new window.Event('scroll'));
    expect(overlay()).toBeNull();
    pickerInPage('stop');
  });
});

// ============================================================
// 候选列表与元素元信息（ADR-0013 D4 / D6）
// ============================================================

describe('pickCandidates — 有序候选', () => {
  it('按 id → name → aria → label → placeholder → text → cssPath 排序', () => {
    mount(`
      <label>用户名 <input id="u" name="user" aria-label="账号"
        placeholder="请输入" /></label>
    `);
    const candidates = pickCandidates(el('input'));
    expect(candidates.map((c) => c.rank)).toEqual([0, 1, 2, 3, 4]);
    expect(candidates.map((c) => c.target)).toEqual([
      { css: '#u' },
      { name: 'user' },
      { ariaLabel: '账号' },
      { label: '用户名' },
      { placeholder: '请输入' },
    ]);
  });

  it('CSS 路径与已有 id 候选重复时去重', () => {
    mount('<input id="u" />');
    expect(pickCandidates(el('input')).map((c) => c.target)).toEqual([
      { css: '#u' },
    ]);
  });

  it('没有语义候选时回退到 CSS 路径', () => {
    mount('<div><span>欢迎</span></div>');
    const candidates = pickCandidates(el('span'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].rank).toBe(6);
    expect(candidates[0].note).toBe('CSS 路径');
  });

  it('每个候选带准确的命中计数', () => {
    mount(`
      <input id="u" name="user" />
      <input name="user" />
      <input placeholder="账号" /><input placeholder="账号" />
    `);
    const first = pickCandidates(document.querySelectorAll('input')[0]);
    const byNote = (note: string) =>
      first.find((c) => c.note.includes(note))!;
    expect(byNote('id="u"').count).toBe(1);
    expect(byNote('name="user"').count).toBe(2);

    const third = pickCandidates(document.querySelectorAll('input')[2]);
    expect(third.find((c) => c.note.includes('placeholder'))!.count).toBe(2);
  });

  it('推荐项优先语义候选里的唯一项，CSS 路径不参与唯一优先', () => {
    mount(`
      <input id="dup" placeholder="账号" />
      <input id="dup" placeholder="账号" />
    `);
    const candidates = pickCandidates(document.querySelectorAll('input')[0]);
    // id 与 placeholder 都命中 2 个；CSS 路径虽唯一，但不是推荐项
    const best = preferredCandidate(candidates)!;
    expect(best.rank).toBeLessThan(6);
    expect(best.count).toBe(2);
    // 推荐项与 pickTargetFromElement 一致
    expect(pickTargetFromElement(document.querySelectorAll('input')[0])).toEqual(
      best.target,
    );
  });

  it('有唯一语义候选时推荐它，而不是优先级更高但重复的候选', () => {
    mount(`
      <label>账号 <input id="dup" name="login" /></label>
      <input id="dup" name="login" />
    `);
    const best = pickTargetFromElement(el('label input'));
    expect(best).toEqual({ label: '账号' });
  });

  it('文本候选只对可交互元素生成', () => {
    mount('<div>提示文案</div><button>登录</button>');
    expect(pickCandidates(el('div')).some((c) => c.rank === 5)).toBe(false);
    expect(pickCandidates(el('button')).some((c) => c.rank === 5)).toBe(true);
  });
});

describe('pickCandidates — 框架自动生成的 id（v1.1.4 线上回归）', () => {
  /**
   * 用户环境 example.com/admin/login 用 Element Plus 渲染：
   *   用户名 input.el-input__inner[placeholder=请输入手机号][id=el-id-9759-21]
   *   密码   input.el-input__inner[type=password][placeholder=请输入密码]
   * 识别时 `el-id-9759-21` 在当前文档唯一，被当成最稳候选写进配方；
   * 刷新后计数器重排 → 执行必然 ELEMENT_NOT_FOUND。
   */
  const ELEMENT_PLUS_LOGIN = `
    <div class="geek-login">
      <div class="login-card">
        <form class="el-form login-form">
          <div class="input-wrapper">
            <label class="input-label"><span class="label-text">账号</span></label>
            <div class="el-input el-input--large">
              <div class="el-input__wrapper">
                <input class="el-input__inner" type="text" autocomplete="off"
                  placeholder="请输入手机号" id="el-id-9759-21" />
              </div>
            </div>
          </div>
          <div class="input-wrapper">
            <label class="input-label"><span class="label-text">密码</span></label>
            <div class="el-input el-input--large">
              <div class="el-input__wrapper">
                <input class="el-input__inner" type="password"
                  autocomplete="new-password" placeholder="请输入密码"
                  id="el-id-9759-22" />
              </div>
            </div>
          </div>
          <button type="button" class="el-button el-button--primary login-btn">
            <span>登 录</span>
          </button>
        </form>
      </div>
    </div>
  `;

  it('isVolatileId 识别各框架的自动 id，语义 id 不受影响', () => {
    for (const id of [
      'el-id-9759-21',
      'el-id-1933-3',
      'el-id-42',
      ':r7:',
      ':r1a:',
      '«r5»',
      'radix-:r3:',
      'mui-12345',
      'input-1678901234',
      'field_98765',
    ]) {
      expect(isVolatileId(id), `${id} 应判为自动生成`).toBe(true);
    }
    for (const id of [
      'username',
      'password',
      'login-form',
      'el-input-3', // 短尾号：可能是有意的语义 id，宁可保留
      'section2024',
      'app',
    ]) {
      expect(isVolatileId(id), `${id} 应保留`).toBe(false);
    }
  });

  it('识别 Element Plus 表单：不会推荐 el-id-*，回退到 placeholder', () => {
    mount(ELEMENT_PLUS_LOGIN);
    const user = el('input[type=text]');
    expect(pickTargetFromElement(user)).toEqual({ placeholder: '请输入手机号' });
    expect(
      pickCandidates(user).some(
        (c) =>
          typeof c.target === 'object' &&
          'css' in c.target &&
          c.target.css.includes('el-id-'),
      ),
    ).toBe(false);
  });

  it('CSS 路径不拿自动 id 当锚点，仍能唯一定位', () => {
    mount(ELEMENT_PLUS_LOGIN);
    const pwd = el('input[type=password]');
    const cssPath = pickCandidates(pwd).find((c) => c.rank === 6);
    expect(cssPath).toBeDefined();
    const path = (cssPath!.target as { css: string }).css;
    expect(path).not.toContain('el-id-');
    // 路径在当前文档仍唯一（nth-of-type 保证）
    expect(document.querySelectorAll(path)).toHaveLength(1);
  });

  it('识别登录表单不会把自动 id 写进配方', () => {
    mount(ELEMENT_PLUS_LOGIN);
    const result = scanLoginFormInPage();
    expect(result.found).toBe(true);
    expect(result.username?.target).toEqual({ placeholder: '请输入手机号' });
    expect(result.password?.target).toEqual({ placeholder: '请输入密码' });
  });

  it('页面内拾取器与模块级实现一致（含自动 id fixture）', () => {
    mount(ELEMENT_PLUS_LOGIN);
    const user = el('input[type=text]');

    const expected = pickCandidates(user).map((c) => ({
      target: c.target,
      count: c.count,
      rank: c.rank,
    }));

    pickerInPage('start');
    user.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    const state = pickerInPage('state') as PickerState;
    pickerInPage('stop');

    expect(state.target).toEqual({ placeholder: '请输入手机号' });
    expect(
      (state.candidates ?? []).map((c) => ({
        target: c.target,
        count: c.count,
        rank: c.rank,
      })),
    ).toEqual(expected);
  });
});

describe('countTargetMatches', () => {
  it('各类 Target 的计数口径一致', () => {
    mount(`
      <label>用户名 <input name="u" /></label>
      <input name="u" />
      <input placeholder="密码" />
      <button>登录</button>
    `);
    expect(countTargetMatches({ name: 'u' })).toBe(2);
    expect(countTargetMatches({ css: '[name="u"]' })).toBe(2);
    expect(countTargetMatches({ placeholder: '密码' })).toBe(1);
    expect(countTargetMatches({ text: '登录' })).toBe(1);
    expect(countTargetMatches({ label: '用户名' })).toBe(1);
    expect(countTargetMatches('#missing')).toBe(0);
  });
});

describe('countTargetMatches — text 精确优先（v1.1.4 example.com 回归）', () => {
  /**
   * 含多个登录页签的示例页面：三个页签都含「登录」，提交按钮才是精确命中。
   * 计数若仍按子串算，候选胶囊会显示「命中 4 个」，用户看到歧义而实际
   * 执行器按精确匹配成功——两侧口径必须一致。
   */
  const TABBED_LOGIN = `
    <div class="login-tab">
      <a href="#">密码登录</a><a href="#">CA登录</a><a href="#">短信登录</a>
    </div>
    <form>
      <input placeholder="输入用户名或手机号或邮箱" />
      <button>登录</button>
    </form>
  `;

  it('精确命中存在时不计子串命中', () => {
    mount(TABBED_LOGIN);
    expect(countTargetMatches({ text: '登录' })).toBe(1);
  });

  it('空白差异互认', () => {
    mount('<a href="#">密码登 录</a><button>登 录</button>');
    expect(countTargetMatches({ text: '登录' })).toBe(1);
  });

  it('没有精确命中时退回子串计数', () => {
    mount('<div><span>立即登录</span></div><div><span>立即登录</span></div>');
    expect(countTargetMatches({ text: '登录' })).toBe(2);
  });

  it('页面内拾取器与模块级计数一致（多页签登录页）', () => {
    mount(TABBED_LOGIN);
    const submit = el('button');

    pickerInPage('start');
    submit.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    const state = pickerInPage('state') as PickerState;
    pickerInPage('stop');

    const expected = pickCandidates(submit).map((c) => ({
      target: c.target,
      count: c.count,
      rank: c.rank,
    }));
    expect(state.target).toEqual({ text: '登录' });
    expect(
      (state.candidates ?? []).map((c) => ({
        target: c.target,
        count: c.count,
        rank: c.rank,
      })),
    ).toEqual(expected);
  });
});

describe('元素元信息与类型判断（D6）', () => {
  it('elementMetaOf 提取 tag / type / role / contentEditable', () => {
    mount(`
      <input type="Password" role="textbox" />
      <div contenteditable="true"></div>
      <div contenteditable="false"></div>
    `);
    expect(elementMetaOf(document.querySelectorAll('input')[0])).toEqual({
      tag: 'input',
      type: 'password',
      role: 'textbox',
    });
    expect(elementMetaOf(el('div[contenteditable="true"]'))).toEqual({
      tag: 'div',
      contentEditable: true,
    });
    expect(elementMetaOf(el('div[contenteditable="false"]'))).toEqual({
      tag: 'div',
    });
  });

  it('可交互 / 可输入的判定', () => {
    expect(isClickableElement({ tag: 'button' })).toBe(true);
    expect(isClickableElement({ tag: 'a' })).toBe(true);
    expect(isClickableElement({ tag: 'div', role: 'button' })).toBe(true);
    expect(isClickableElement({ tag: 'input', type: 'submit' })).toBe(true);
    expect(isClickableElement({ tag: 'input', type: 'text' })).toBe(false);
    expect(isClickableElement({ tag: 'div' })).toBe(false);

    expect(isFillableElement({ tag: 'textarea' })).toBe(true);
    expect(isFillableElement({ tag: 'div', contentEditable: true })).toBe(true);
    expect(isFillableElement({ tag: 'input', type: 'checkbox' })).toBe(false);
    expect(isFillableElement({ tag: 'button' })).toBe(false);
  });
});

describe('拾取器与执行器的一致性（D4 实现约束）', () => {
  /**
   * `pickerInPage` 与模块级 `pickCandidates` 是两份同源实现
   * （页面内函数不能引用模块级标识符）。这里用同一组 fixture 固化两者结果，
   * 防止今后单边修改导致拾取与执行语义漂移。
   */
  const fixtures = [
    '<input id="u" name="user" />',
    '<label>用户名 <input name="user" /></label>',
    '<input placeholder="账号" /><input placeholder="账号" />',
    '<button class="submit">登 录</button>',
    '<div><span>欢迎</span></div>',
    '<input id="dup" /><input id="dup" />',
    // 框架自动生成的 id（Element Plus / React）：两侧实现都必须跳过
    '<input id="el-id-9759-21" placeholder="请输入手机号" />',
    '<div id="el-id-1933-1"><input id=":r7:" placeholder="账号" /></div>',
  ];

  it.each(fixtures)('%s 的推荐项与候选序列一致', (html) => {
    mount(html);
    const target = document.querySelector('input, button, span')!;

    const expected = pickCandidates(target).map((c) => ({
      target: c.target,
      count: c.count,
      rank: c.rank,
    }));

    pickerInPage('start');
    target.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    const state = pickerInPage('state') as PickerState;
    pickerInPage('stop');

    expect(state.status).toBe('picked');
    expect(state.target).toEqual(pickTargetFromElement(target));
    expect(
      (state.candidates ?? []).map((c) => ({
        target: c.target,
        count: c.count,
        rank: c.rank,
      })),
    ).toEqual(expected);
    expect(state.meta).toEqual(elementMetaOf(target));
  });
});

describe('pickCandidates — 悬停浮层的备选提示', () => {
  it('存在备选时提示可改选', () => {
    mount('<input id="u" name="user" />');
    pickerInPage('start');
    hover(el('input'));
    const box = overlay()!;
    expect(box.textContent).toContain('将使用：#u');
    // id + name（CSS 路径与 id 重复，已去重）
    expect(box.textContent).toContain('另有 1 个候选');
    pickerInPage('stop');
  });

  it('候选只有推荐项时不显示备选行', () => {
    mount('<input id="u" placeholder="账号" />');
    pickerInPage('start');
    hover(el('input'));
    const text = overlay()!.textContent ?? '';
    expect(text).toContain('将使用：#u');
    // 只剩 placeholder 一个备选
    expect(text).toContain('另有 1 个候选');
    pickerInPage('stop');
  });

  it('只有一项候选（纯 CSS 路径）时不追加备选行', () => {
    mount('<div><span>欢迎</span></div>');
    pickerInPage('start');
    hover(el('span'));
    const text = overlay()!.textContent ?? '';
    expect(text).toContain('将使用：');
    expect(text).not.toContain('另有');
    pickerInPage('stop');
  });
});

describe('rankPickerTabs', () => {
  it('同 origin 的标签页优先，其次按最近访问', () => {
    const tabs = [
      { id: 1, url: 'https://other.com/', lastAccessed: 999 },
      { id: 2, url: 'https://example.com/login', lastAccessed: 1 },
      { id: 3, url: 'https://example.com/home', lastAccessed: 5 },
    ];
    expect(rankPickerTabs(tabs, 'https://example.com', 9).map((t) => t.id)).toEqual([
      3, 2, 1,
    ]);
  });

  it('排除自身 tab、扩展页与非 http 页', () => {
    const tabs = [
      { id: 1, url: 'chrome-extension://abc/options.html', lastAccessed: 9 },
      { id: 2, url: 'about:blank', lastAccessed: 8 },
      { id: 3, url: 'https://example.com/', lastAccessed: 7 },
      { id: 4, url: 'https://example.com/x', lastAccessed: 6 },
    ];
    expect(rankPickerTabs(tabs, 'https://example.com', 4).map((t) => t.id)).toEqual([
      3,
    ]);
  });
});

// ============================================================
// 扩展侧编排：startTargetPicker（ADR-0013 D1 / D2）
// ============================================================

const OWN_TAB = 1;
const TARGET_TAB = 7;
const OWN_WINDOW = 3;
const TARGET_WINDOW = 4;

describe('startTargetPicker', () => {
  const executeScript = vi.fn();
  const tabsQuery = vi.fn();
  const tabsUpdate = vi.fn();
  const windowsUpdate = vi.fn();
  /** 记录注入的 command 序列 */
  let commands: string[];

  /** 按 command 依次返回预设的页面内状态（最后一个状态会重复） */
  function playbook(states: Partial<Record<string, PickerState[]>>): void {
    executeScript.mockImplementation(
      async (injection: { args: [string] }) => {
        const command = injection.args[0];
        commands.push(command);
        const queue = states[command] ?? [];
        const next =
          queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 'idle' });
        return [{ frameId: 0, result: next }];
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    commands = [];
    tabsQuery.mockResolvedValue([
      {
        id: TARGET_TAB,
        url: 'https://example.com/login',
        windowId: TARGET_WINDOW,
        lastAccessed: 9,
      },
    ]);
    tabsUpdate.mockResolvedValue({});
    windowsUpdate.mockResolvedValue({});
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      tabs: { query: tabsQuery, update: tabsUpdate },
      windows: { update: windowsUpdate },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const options = {
    origin: 'https://example.com',
    ownTabId: OWN_TAB,
    ownWindowId: OWN_WINDOW,
    pollIntervalMs: 1,
    timeoutMs: 200,
  };

  it('命中 → picked，并解绑', async () => {
    playbook({
      start: [{ status: 'active' }],
      state: [
        { status: 'active' },
        {
          status: 'picked',
          target: { css: '#username' },
          frameUrl: 'https://example.com/login',
        },
      ],
    });

    const result = await startTargetPicker(options);

    expect(result).toMatchObject({
      status: 'picked',
      target: { css: '#username' },
      frameId: 0,
    });
    // 主 frame 不记录 frameUrl（ADR-0013 D7）：身份由 tab 保证
    expect(result.status === 'picked' && result.frameUrl).toBeUndefined();
    // 页面脚本未返回候选 / 元信息时不编造（D4 / D6）
    expect(result.status === 'picked' && result.candidates).toEqual([]);
    expect(result.status === 'picked' && result.meta).toEqual({ tag: '' });
    expect(commands[0]).toBe('start');
    expect(commands[commands.length - 1]).toBe('stop');
    expect(commands).toContain('state');
  });

  it('子 frame 命中 → 记录 frameId 与 frameUrl（D7）', async () => {
    const states: Record<string, PickerState[]> = {
      start: [{ status: 'active' }],
      state: [{ status: 'picked', target: { css: '#u' } }],
    };
    executeScript.mockImplementation(async (injection: { args: [string] }) => {
      const command = injection.args[0];
      commands.push(command);
      const queue = states[command] ?? [];
      const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? { status: 'idle' });
      return [
        { frameId: 0, result: { status: 'idle' } },
        {
          frameId: 5,
          result: { ...next, frameUrl: 'https://login.example.com/form?x=1' },
        },
      ];
    });

    const result = await startTargetPicker(options);

    expect(result).toMatchObject({
      status: 'picked',
      frameId: 5,
      frameUrl: 'https://login.example.com/form?x=1',
    });
  });

  it('Esc 取消 → cancelled，stop 仍被调用', async () => {
    playbook({
      start: [{ status: 'active' }],
      state: [{ status: 'cancelled' }],
    });

    await expect(startTargetPicker(options)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(commands[commands.length - 1]).toBe('stop');
  });

  it('注入失败 → INJECT_FAILED，不再轮询', async () => {
    executeScript.mockImplementation(async (injection: { args: [string] }) => {
      commands.push(injection.args[0]);
      throw new Error('Cannot access contents of the page');
    });

    const result = await startTargetPicker(options);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('INJECT_FAILED');
      expect(result.message).toContain('Cannot access');
    }
    // start 一次 + finally 的 stop 一次；没有任何 state 轮询
    expect(commands).toEqual(['start', 'stop']);
  });

  it('没有可用标签页 → NO_TAB', async () => {
    tabsQuery.mockResolvedValue([]);
    await expect(startTargetPicker(options)).resolves.toMatchObject({
      status: 'error',
      code: 'NO_TAB',
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('会话连续丢失 → lost（不等满超时）', async () => {
    playbook({
      start: [{ status: 'active' }],
      state: [{ status: 'idle' }],
    });
    const startedAt = Date.now();

    const result = await startTargetPicker({ ...options, timeoutMs: 5_000 });

    expect(result.status).toBe('lost');
    // 3 次 strike × 1ms 轮询，远小于 5s 超时
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('结束后切回来源标签页与窗口', async () => {
    playbook({
      start: [{ status: 'active' }],
      state: [{ status: 'picked', target: { css: '#u' } }],
    });

    await startTargetPicker(options);

    expect(tabsUpdate).toHaveBeenCalledWith(TARGET_TAB, { active: true });
    expect(tabsUpdate).toHaveBeenCalledWith(OWN_TAB, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(OWN_WINDOW, { focused: true });
  });

  it('回切失败不影响拾取结果', async () => {
    tabsUpdate.mockImplementation(async (tabId: number) => {
      if (tabId === OWN_TAB) throw new Error('Tab closed');
      return {};
    });
    playbook({
      start: [{ status: 'active' }],
      state: [{ status: 'picked', target: { css: '#u' } }],
    });

    await expect(startTargetPicker(options)).resolves.toMatchObject({
      status: 'picked',
    });
  });
});
