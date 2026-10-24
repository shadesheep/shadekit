// @vitest-environment happy-dom
/**
 * generic-target — Target 解析（ADR-0012 D3 / D12）
 *
 * 直接调用页面内执行体 `domActionInPage`（happy-dom 提供 window/document），
 * 验证六种定位写法、隐藏过滤、歧义报错、受控输入、shadow root 与文本扫描。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describeTarget,
  domActionInPage,
} from '../entrypoints/tools/account-switch/strategies/generic-target';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('describeTarget', () => {
  it('七种写法都有可读描述', () => {
    expect(describeTarget('#a')).toBe('#a');
    expect(describeTarget({ css: '.a' })).toBe('.a');
    expect(describeTarget({ ariaLabel: '用户名' })).toBe('aria-label「用户名」');
    expect(describeTarget({ label: '用户名' })).toContain('用户名');
    expect(describeTarget({ name: 'user' })).toBe('name=user');
    expect(describeTarget({ placeholder: '请输入' })).toContain('请输入');
    expect(describeTarget({ text: '登录' })).toContain('登录');
  });
});

describe('domActionInPage — locate', () => {
  it('CSS 字符串（向后兼容）与 {css} 等价', () => {
    document.body.innerHTML = '<input id="u" />';
    expect(domActionInPage({ action: 'locate', target: '#u' }).status).toBe('ok');
    expect(
      domActionInPage({ action: 'locate', target: { css: '#u' } }).status,
    ).toBe('ok');
  });

  it('name / placeholder 写法命中', () => {
    document.body.innerHTML =
      '<input name="user" /><input placeholder="请输入密码" />';
    expect(
      domActionInPage({ action: 'locate', target: { name: 'user' } }).status,
    ).toBe('ok');
    expect(
      domActionInPage({
        action: 'locate',
        target: { placeholder: '请输入密码' },
      }).status,
    ).toBe('ok');
  });

  it('aria-label 命中（含 aria-labelledby 指向的文本）', () => {
    document.body.innerHTML = `
      <input aria-label="用户名" />
      <span id="pwd-label">密码</span><input aria-labelledby="pwd-label" />
    `;
    expect(
      domActionInPage({ action: 'locate', target: { ariaLabel: '用户名' } })
        .status,
    ).toBe('ok');
    expect(
      domActionInPage({ action: 'locate', target: { ariaLabel: '密码' } })
        .status,
    ).toBe('ok');
  });

  it('label[for] 与包裹式 label 都能命中', () => {
    document.body.innerHTML = `
      <label for="u">用户名</label><input id="u" />
      <label>密码<input id="p" /></label>
    `;
    expect(
      domActionInPage({ action: 'locate', target: { label: '用户名' } }).status,
    ).toBe('ok');
    expect(
      domActionInPage({ action: 'locate', target: { label: '密码' } }).status,
    ).toBe('ok');
  });

  it('文本写法命中按钮并优先可交互元素', () => {
    document.body.innerHTML =
      '<div><span>立即登录</span></div><button>立即登录</button>';
    expect(
      domActionInPage({ action: 'locate', target: { text: '立即登录' } }).status,
    ).toBe('ok');
  });

  it('隐藏元素被忽略', () => {
    document.body.innerHTML = `
      <input id="u" style="display:none" />
      <input id="u2" hidden />
      <input id="u3" style="visibility:hidden" />
    `;
    expect(domActionInPage({ action: 'locate', target: '#u' }).status).toBe(
      'notFound',
    );
    expect(domActionInPage({ action: 'locate', target: '#u2' }).status).toBe(
      'notFound',
    );
    expect(domActionInPage({ action: 'locate', target: '#u3' }).status).toBe(
      'notFound',
    );
  });

  it('多个可见命中 → ambiguous，不静默取第一个', () => {
    document.body.innerHTML =
      '<input class="x" /><input class="x" />';
    const result = domActionInPage({ action: 'locate', target: '.x' });
    expect(result.status).toBe('ambiguous');
    expect(result.count).toBe(2);
  });

  it('隐藏元素不参与唯一性判断（1 可见 + 1 隐藏仍然唯一）', () => {
    document.body.innerHTML =
      '<input class="x" /><input class="x" style="display:none" />';
    expect(domActionInPage({ action: 'locate', target: '.x' }).status).toBe('ok');
  });

  it('非法 CSS 选择器 → invalid 而不是 notFound', () => {
    const result = domActionInPage({ action: 'locate', target: '##bad[' });
    expect(result.status).toBe('invalid');
  });
});

describe('domActionInPage — text 定位（精确优先）', () => {
  /**
   * v1.1.4 线上回归（www.example.com → /app/#/login，含多个登录页签的示例页面）：
   * 登录弹窗里三个切换页签都含「登录」，提交按钮才是精确命中。
   * 子串匹配会得到 4 个可见元素 → `AMBIGUOUS_TARGET`。
   */
  const TABBED_LOGIN = `
    <div class="login-main">
      <div class="login-tab">
        <a class="tab-link active" href="#">密码登录</a>
        <a class="tab-link" href="#">CA登录</a>
        <a class="tab-link" href="#">短信登录</a>
      </div>
      <form class="login-form">
        <input placeholder="输入用户名或手机号或邮箱" />
        <input type="password" placeholder="输入密码" />
        <button type="button" class="login-submit">登录</button>
      </form>
    </div>
  `;

  it('页签含同一子串时不与提交按钮争抢（example.com 回归）', () => {
    document.body.innerHTML = TABBED_LOGIN;
    const result = domActionInPage({
      action: 'click',
      target: { text: '登录' },
    });
    expect(result.status).toBe('ok');
    expect(result.count).toBe(1);
  });

  it('精确命中的按钮被点击（不是页签）', () => {
    document.body.innerHTML = TABBED_LOGIN;
    const clicked: string[] = [];
    document.querySelectorAll('a, button').forEach((node) => {
      node.addEventListener('click', () => clicked.push(node.textContent!.trim()));
    });
    domActionInPage({ action: 'click', target: { text: '登录' } });
    expect(clicked).toEqual(['登录']);
  });

  it('空白差异互认：定位写「登录」，页面是「登 录」', () => {
    document.body.innerHTML =
      '<div class="tabs"><a href="#">密码登 录</a></div><button>登 录</button>';
    expect(
      domActionInPage({ action: 'click', target: { text: '登录' } }).status,
    ).toBe('ok');
  });

  it('没有精确命中时退回子串，且只取最内层', () => {
    document.body.innerHTML = `
      <div class="row"><span>立即登录</span></div>
      <div class="row"><span>立即登录</span></div>
    `;
    // 子串命中两个叶子 → 仍然报歧义，而不是静默取第一个
    expect(
      domActionInPage({ action: 'locate', target: { text: '登录' } }).status,
    ).toBe('ambiguous');
    expect(
      domActionInPage({ action: 'locate', target: { text: '立即登录' } }).status,
    ).toBe('ambiguous');
  });

  it('精确命中全部不可见时，退回可见的子串命中', () => {
    // PC / 移动双布局：隐藏那套的按钮文案才是精确的
    document.body.innerHTML = `
      <div class="desktop" style="display:none"><button>登录</button></div>
      <div class="mobile"><button>立即登录</button></div>
    `;
    expect(
      domActionInPage({ action: 'click', target: { text: '登录' } }).status,
    ).toBe('ok');
  });

  it('精确命中存在时，隐藏的精确项不参与歧义判定', () => {
    document.body.innerHTML = `
      <button>登录</button>
      <div style="display:none"><button>登录</button></div>
    `;
    expect(
      domActionInPage({ action: 'click', target: { text: '登录' } }).status,
    ).toBe('ok');
  });

  it('空文本定位不命中所有元素', () => {
    document.body.innerHTML = '<div><span>文案</span></div>';
    expect(
      domActionInPage({ action: 'locate', target: { text: '   ' } }).status,
    ).toBe('notFound');
  });
});

describe('domActionInPage — fill', () => {
  it('走原生 value setter 并派发 input/change（受控组件可感知）', () => {
    document.body.innerHTML = '<input id="u" />';
    const input = document.getElementById('u') as HTMLInputElement;

    const nativeSetter = vi.spyOn(
      window.HTMLInputElement.prototype,
      'value',
      'set',
    );
    const inputHandler = vi.fn();
    const changeHandler = vi.fn();
    input.addEventListener('input', inputHandler);
    input.addEventListener('change', changeHandler);

    const result = domActionInPage({
      action: 'fill',
      target: '#u',
      value: 'alice',
      clearFirst: true,
    });

    expect(result.status).toBe('ok');
    expect(nativeSetter).toHaveBeenCalled();
    expect(input.value).toBe('alice');
    expect(inputHandler).toHaveBeenCalledOnce();
    expect(changeHandler).toHaveBeenCalledOnce();
  });

  it('clearFirst=false 时在原值后追加（不先清空）', () => {
    document.body.innerHTML = '<input id="u" value="ab" />';
    const input = document.getElementById('u') as HTMLInputElement;
    domActionInPage({
      action: 'fill',
      target: '#u',
      value: 'cd',
      clearFirst: false,
    });
    expect(input.value).toBe('cd');
  });

  it('目标缺失 → notFound（不抛异常）', () => {
    expect(
      domActionInPage({
        action: 'fill',
        target: '#none',
        value: 'x',
        clearFirst: true,
      }).status,
    ).toBe('notFound');
  });
});

describe('domActionInPage — click', () => {
  it('触发 click 事件', () => {
    document.body.innerHTML = '<button id="go">登录</button>';
    const handler = vi.fn();
    (document.getElementById('go') as HTMLButtonElement).addEventListener(
      'click',
      handler,
    );
    expect(domActionInPage({ action: 'click', target: '#go' }).status).toBe('ok');
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('domActionInPage — shadow root', () => {
  it('递归 open shadowRoot 查询到元素', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="inner" />';

    expect(domActionInPage({ action: 'locate', target: '#inner' }).status).toBe(
      'ok',
    );
    expect(
      domActionInPage({
        action: 'fill',
        target: '#inner',
        value: 'v',
        clearFirst: true,
      }).status,
    ).toBe('ok');
    expect((shadow.getElementById('inner') as HTMLInputElement).value).toBe('v');
  });

  it('嵌套 shadow root 也能查到', () => {
    document.body.innerHTML = '<div id="outer"></div>';
    const outer = document.getElementById('outer')!;
    const s1 = outer.attachShadow({ mode: 'open' });
    s1.innerHTML = '<div id="mid"></div>';
    const mid = s1.getElementById('mid')!;
    const s2 = mid.attachShadow({ mode: 'open' });
    s2.innerHTML = '<button id="deep">提交</button>';

    expect(domActionInPage({ action: 'locate', target: '#deep' }).status).toBe(
      'ok',
    );
  });
});

describe('domActionInPage — scan（验证码文案）', () => {
  it('命中验证码文案返回 ok', () => {
    document.body.innerHTML = '<div>请输入验证码</div>';
    expect(
      domActionInPage({ action: 'scan', patterns: ['验证码|captcha|slider'] })
        .status,
    ).toBe('ok');
  });

  it('未命中返回 notFound', () => {
    document.body.innerHTML = '<div>正常页面</div>';
    expect(
      domActionInPage({ action: 'scan', patterns: ['验证码'] }).status,
    ).toBe('notFound');
  });

  it('invalid 正则被忽略，不影响其他模式', () => {
    document.body.innerHTML = '<div>captcha</div>';
    expect(
      domActionInPage({ action: 'scan', patterns: ['[', 'captcha'] }).status,
    ).toBe('ok');
  });

  /**
   * v1.1.4 线上回归（example.com/admin/login）：
   * 登录页默认停在「账号密码」页，但同级的「邮箱验证码」切换标签始终可见。
   * 整页文本扫描会命中「验证码」，导致登录成功后仍报 CAPTCHA_REQUIRED。
   */
  it('可交互的切换标签不算验证码提示', () => {
    document.body.innerHTML = `
      <form>
        <div class="login-tabs">
          <span class="tab-item active">账号密码</span>
          <span class="tab-item" style="cursor:pointer">邮箱验证码</span>
        </div>
        <input placeholder="请输入手机号" />
        <input type="password" placeholder="请输入密码" />
        <button>登 录</button>
      </form>
    `;
    expect(
      domActionInPage({ action: 'scan', patterns: ['验证码|captcha|slider'] })
        .status,
    ).toBe('notFound');
  });

  it('隐藏面板里的验证码表单不算提示', () => {
    // happy-dom 的 getComputedStyle 不结算 display:none，这里用 hidden 属性
    // 走同一条 isVisible 分支（浏览器里两者都会被 isVisible 拦下）。
    document.body.innerHTML = `
      <form>
        <div hidden>
          <span>请输入邮箱验证码</span>
        </div>
        <input placeholder="请输入手机号" />
        <input type="password" placeholder="请输入密码" />
      </form>
    `;
    expect(
      domActionInPage({ action: 'scan', patterns: ['验证码|captcha|slider'] })
        .status,
    ).toBe('notFound');
  });

  it('静态提示文本仍然命中（真正的风控场景）', () => {
    document.body.innerHTML = `
      <form>
        <input placeholder="请输入手机号" />
        <input type="password" placeholder="请输入密码" />
        <div class="login-tabs"><span class="tab-item">邮箱验证码</span></div>
        <div class="captcha">请输入验证码</div>
      </form>
    `;
    expect(
      domActionInPage({ action: 'scan', patterns: ['验证码|captcha|slider'] })
        .status,
    ).toBe('ok');
  });

  it('按钮文案里的「验证码」不算提示（获取验证码按钮）', () => {
    document.body.innerHTML = `
      <form>
        <input placeholder="请输入手机号" />
        <button type="button">获取验证码</button>
      </form>
    `;
    expect(
      domActionInPage({ action: 'scan', patterns: ['验证码|captcha|slider'] })
        .status,
    ).toBe('notFound');
  });
});
