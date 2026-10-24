/**
 * 双编辑器滚动同步 helper(第 5 轮评审收口,原 json-diff/App.vue setupScrollSync)。
 *
 * 按滚动比例(而非像素)同步两侧编辑器,避免行高不一致时脱节。
 * 内部 isSyncing 标志防回声;`suppress` 供外部主动压制
 * (如差异导航期间,避免按比例同步把另一侧拽离目标行)。
 */
import type { CodeEditor } from './codemirror-editor';

export interface ScrollSync {
  /** 主动压制同步 durationMs 毫秒(默认 150) */
  suppress(durationMs?: number): void;
  /** 解绑两侧 scroll 监听 */
  detach(): void;
}

export function syncScroll(a: CodeEditor, b: CodeEditor): ScrollSync {
  const aScroll = a.view.scrollDOM;
  const bScroll = b.view.scrollDOM;
  let isSyncing = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  const onScroll = (from: HTMLElement, to: HTMLElement) => {
    if (isSyncing) return;
    isSyncing = true;
    const maxFrom = from.scrollHeight - from.clientHeight;
    const maxTo = to.scrollHeight - to.clientHeight;
    const ratio = maxFrom > 0 ? from.scrollTop / maxFrom : 0;
    to.scrollTop = ratio * maxTo;
    requestAnimationFrame(() => {
      isSyncing = false;
    });
  };

  const onAScroll = () => onScroll(aScroll, bScroll);
  const onBScroll = () => onScroll(bScroll, aScroll);

  aScroll.addEventListener('scroll', onAScroll);
  bScroll.addEventListener('scroll', onBScroll);

  return {
    suppress(durationMs = 150) {
      isSyncing = true;
      if (suppressTimer) clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => {
        isSyncing = false;
        suppressTimer = null;
      }, durationMs);
    },
    detach() {
      aScroll.removeEventListener('scroll', onAScroll);
      bScroll.removeEventListener('scroll', onBScroll);
      if (suppressTimer) clearTimeout(suppressTimer);
      suppressTimer = null;
    },
  };
}
