import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

const toolIconComponents = [
  {
    filename: 'entrypoints/options/components/ToolMarket.vue',
    wrapper: 'card-icon-wrapper',
    icon: 'card-icon',
    darkBackground: 'rgba(99,102,241,0.2), rgba(59,130,246,0.2)',
  },
  {
    filename: 'entrypoints/popup/App.vue',
    wrapper: 'tool-icon-wrapper',
    icon: 'tool-icon',
    darkBackground: 'rgba(99,102,241,0.15), rgba(59,130,246,0.15)',
  },
];

function getStyle(filename: string) {
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const style = descriptor.styles[0];
  return compileStyle({
    source: style.content,
    filename,
    id: 'tool-icon-theme',
    scoped: true,
    preprocessLang: style.lang as 'scss' | undefined,
  }).code;
}

function getRule(css: string, selector: string) {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[data-v-tool-icon-theme]\\s*\\{([^}]+)\\}`);
  return css.match(pattern)?.[1] ?? '';
}

describe('工具列表图标配色', () => {
  it.each(toolIconComponents)('$filename 使用统一的浅靛蓝亮色样式', ({ filename, wrapper, icon }) => {
    const source = readFileSync(filename, 'utf8');
    const css = getStyle(filename);

    expect(source).not.toContain('toolIconGradient');
    expect(getRule(css, `.${wrapper}`)).toContain('background: var(--gradient-header-bg)');
    expect(getRule(css, `.${icon}`)).toContain('color: var(--primary-start)');
  });

  it.each(toolIconComponents)('$filename 在暗色模式使用浅靛蓝图标', ({ filename, wrapper, icon, darkBackground }) => {
    const css = getStyle(filename);

    const background = getRule(css, `[data-dt-dark] .${wrapper}`)
      .match(/background: ([^;]+)/)?.[1]
      ?.replace(/\s+/g, '');
    expect(background).toBe(`linear-gradient(135deg,${darkBackground.replace(/\s+/g, '')})`);
    expect(getRule(css, `[data-dt-dark] .${icon}`)).toContain('color: #818cf8');
  });
});

describe('工具总览卡片间距', () => {
  const css = getStyle('entrypoints/options/components/ToolMarket.vue');

  it('卡片网格保持 12px 间隔', () => {
    expect(getRule(css, '.tool-grid')).toContain('gap: 12px');
  });

  it('图标与标题保持 10px 间隔', () => {
    expect(getRule(css, '.card-header')).toContain('margin-bottom: 10px');
  });
});

describe('工具选择弹窗间距', () => {
  it('保留上下留白，去除容器左右留白', () => {
    const css = getStyle('entrypoints/popup/App.vue');
    expect(getRule(css, '.popup-container')).toContain('padding: 10px 0px');
  });
});
