/**
 * 「点遮罩空白处关闭」的稳健实现，供所有 overlay 复用（DtDrawer /
 * ImportDrawer / DomainsPanel 的 import-dialog-overlay 等）。
 *
 * 为什么不用 `@click.self`：弹层内部常有 v-if 动态块，点击瞬间若 Vue
 * 卸载/重挂了目标元素，浏览器重新命中测试会落到 overlay 上，
 * `target === currentTarget` 成立 → 弹层被误关。改成「mousedown 起点
 * 就落在 overlay 上才武装一次关闭」后，mousedown 落在内部任何元素都
 * 不会武装，后续 click 怎么变都不会误触。
 *
 * 用法：
 *   const { onOverlayMousedown, onOverlayClick } = useOverlayClose(() => emit('close'));
 *   <div class="xx-overlay" @mousedown="onOverlayMousedown" @click="onOverlayClick">
 */
import { ref } from 'vue';

export function useOverlayClose(onClose: () => void) {
  const armed = ref(false);

  function onOverlayMousedown(e: MouseEvent) {
    armed.value = e.target === e.currentTarget;
  }

  function onOverlayClick(e: MouseEvent) {
    if (armed.value && e.target === e.currentTarget) onClose();
    armed.value = false;
  }

  return { onOverlayMousedown, onOverlayClick };
}
