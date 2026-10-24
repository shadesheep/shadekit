// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { attachImagePreview } from '../entrypoints/tools/json-formatter/lib/image-preview';

const PIC_URL = 'https://example.com/pic.png';

function makeContainer(): { container: HTMLElement; link: HTMLAnchorElement } {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  const link = document.createElement('a');
  link.dataset.isLink = '1';
  link.dataset.linkUrl = PIC_URL;
  link.textContent = `"${PIC_URL}"`;
  container.appendChild(link);
  document.body.appendChild(container);
  return { container, link };
}

function hover(el: Element) {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

function unhover(el: Element) {
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const getTooltip = () =>
  document.querySelector('.dt-img-preview') as HTMLElement | null;

describe('attachImagePreview', () => {
  it('URL 可加载为图片时，悬停显示悬浮预览', async () => {
    const { container, link } = makeContainer();
    const detach = attachImagePreview(container, () => Promise.resolve());

    hover(link);
    await tick();

    const tip = getTooltip();
    expect(tip).toBeTruthy();
    expect(tip!.style.display).toBe('block');
    expect(tip!.querySelector('img')?.getAttribute('src')).toBe(PIC_URL);
    detach();
  });

  it('URL 不是图片（加载失败）时不显示预览', async () => {
    const { container, link } = makeContainer();
    const detach = attachImagePreview(container, () =>
      Promise.reject(new Error('not an image')),
    );

    hover(link);
    await tick();

    const tip = getTooltip();
    expect(!tip || tip.style.display === 'none').toBe(true);
    detach();
  });

  it('移出链接后隐藏预览', async () => {
    const { container, link } = makeContainer();
    const detach = attachImagePreview(container, () => Promise.resolve());

    hover(link);
    await tick();
    expect(getTooltip()!.style.display).toBe('block');

    unhover(link);
    expect(getTooltip()!.style.display).toBe('none');
    detach();
  });

  it('预览加载完成前已移出链接，则不再显示', async () => {
    const { container, link } = makeContainer();
    let resolveLoad!: () => void;
    const detach = attachImagePreview(
      container,
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    hover(link);
    unhover(link);
    resolveLoad();
    await tick();

    const tip = getTooltip();
    expect(!tip || tip.style.display === 'none').toBe(true);
    detach();
  });

  it('同一 URL 缓存加载结果，不重复请求', async () => {
    const { container, link } = makeContainer();
    const loader = vi.fn(() => Promise.resolve());
    const detach = attachImagePreview(container, loader);

    hover(link);
    await tick();
    unhover(link);
    hover(link);
    await tick();

    expect(loader).toHaveBeenCalledTimes(1);
    // 缓存命中时应同步显示
    expect(getTooltip()!.style.display).toBe('block');
    detach();
  });

  it('加载失败的 URL 也缓存，不再重复请求', async () => {
    const { container, link } = makeContainer();
    const loader = vi.fn(() => Promise.reject(new Error('not an image')));
    const detach = attachImagePreview(container, loader);

    hover(link);
    await tick();
    unhover(link);
    hover(link);
    await tick();

    expect(loader).toHaveBeenCalledTimes(1);
    detach();
  });

  it('悬停在非链接元素上不触发加载', async () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    const span = document.createElement('span');
    span.className = 'string';
    container.appendChild(span);
    document.body.appendChild(container);

    const loader = vi.fn(() => Promise.resolve());
    const detach = attachImagePreview(container, loader);

    hover(span);
    await tick();

    expect(loader).not.toHaveBeenCalled();
    detach();
  });

  it('detach 后移除悬浮层且不再响应悬停', async () => {
    const { container, link } = makeContainer();
    const loader = vi.fn(() => Promise.resolve());
    const detach = attachImagePreview(container, loader);

    hover(link);
    await tick();
    detach();

    expect(getTooltip()).toBeNull();
    hover(link);
    await tick();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
