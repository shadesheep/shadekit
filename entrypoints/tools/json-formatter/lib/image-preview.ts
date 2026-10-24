/**
 * 图片 URL 悬停预览
 *
 * 鼠标悬停在 JSON 树中的链接（a[data-is-link]）上时，尝试把 URL 当图片加载：
 * 加载成功说明是图片，显示悬浮预览；加载失败则静默忽略（不显示破图）。
 * 加载结果按 URL 缓存，避免重复请求。
 */

export type ImageLoader = (url: string) => Promise<void>;

const PREVIEW_CLASS = 'dt-img-preview';

function defaultLoadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('not an image'));
    img.src = url;
  });
}

/**
 * 在容器上挂接图片悬停预览（事件委托，重复调用前请先调用返回的 detach）。
 * @returns detach 清理函数：移除监听与悬浮层
 */
export function attachImagePreview(
  container: HTMLElement,
  loadImage: ImageLoader = defaultLoadImage,
): () => void {
  const cache = new Map<string, boolean>();
  let tooltip: HTMLDivElement | null = null;
  let currentUrl: string | null = null;
  let hoverToken = 0;

  function ensureTooltip(): HTMLDivElement {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = PREVIEW_CLASS;
      tooltip.style.display = 'none';
      document.body.appendChild(tooltip);
    }
    return tooltip;
  }

  function show(anchor: HTMLElement, url: string) {
    const tip = ensureTooltip();
    tip.innerHTML = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    tip.appendChild(img);

    const rect = anchor.getBoundingClientRect();
    // 防止超出视口右边缘（预览最大宽度 320px + 内边距/边框余量）
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340));
    tip.style.left = `${left}px`;
    tip.style.top = `${rect.bottom + 6}px`;
    tip.style.display = 'block';
  }

  function hide() {
    if (tooltip) tooltip.style.display = 'none';
  }

  function findLink(target: EventTarget | null): HTMLAnchorElement | null {
    if (!(target instanceof Element)) return null;
    const a = target.closest('a[data-is-link]');
    return a instanceof HTMLAnchorElement ? a : null;
  }

  const onMouseOver = (e: MouseEvent) => {
    const link = findLink(e.target);
    if (!link) return;
    const url = link.dataset.linkUrl || link.href;
    if (!url || url === currentUrl) return;
    currentUrl = url;
    const token = ++hoverToken;

    if (cache.get(url)) {
      show(link, url);
      return;
    }
    // 已知非图片：跳过加载与显示
    if (cache.has(url)) return;

    loadImage(url)
      .then(() => {
        cache.set(url, true);
        // 加载期间鼠标已移开则不再显示
        if (token === hoverToken && currentUrl === url) show(link, url);
      })
      .catch(() => {
        cache.set(url, false);
      });
  };

  const onMouseOut = (e: MouseEvent) => {
    const link = findLink(e.target);
    if (!link) return;
    // 移动到链接内部的子元素时不隐藏
    if (link.contains(e.relatedTarget as Node | null)) return;
    currentUrl = null;
    hoverToken++;
    hide();
  };

  container.addEventListener('mouseover', onMouseOver);
  container.addEventListener('mouseout', onMouseOut);

  return () => {
    container.removeEventListener('mouseover', onMouseOver);
    container.removeEventListener('mouseout', onMouseOut);
    tooltip?.remove();
    tooltip = null;
    currentUrl = null;
  };
}
