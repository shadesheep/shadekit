<script setup lang="ts">
/**
 * DtDrawer — 右侧滑出抽屉（独立工具标签页 / 选项页共享组件）。
 *
 * 用于承载「添加 / 编辑」类表单：从右侧滑入，不打断主视图列表上下文
 * （替代此前把表单孤悬页顶 + scrollIntoView 跳转的做法，ADR-0017 优化）。
 *
 * - overlay 配方与 ImportDrawer.vue / DomainsPanel.vue 的居中弹框一致
 *   （position: fixed; inset:0; rgba scrim; backdrop-filter）。
 * - 滑入动画取 ToastContainer 的 translateX(100%) → 0 进向。
 * - 关注点：宿主 .config-panel 居中于 max-width 容器内，position:fixed;
 *   right:0 会贴视口右缘而非面板右缘，故面板用固定宽度（min(560px, 92vw)）。
 * - 不 Teleport，随宿主容器内联渲染，继承 options 的 font-family（与 ImportDrawer 一致）。
 * - 关闭：scrim 空白处 mousedown+click 同源才触发（不是 @click.self，避免内部
 *   v-if 动态块切换导致 target 落到 overlay 时误关抽屉）、Escape（焦点在
 *   输入元素内时放行，不打断输入法/自动完成的取消）。
 */
import { onMounted, onUnmounted } from 'vue';
import { useOverlayClose } from '../use-overlay-close';

const emit = defineEmits<{ close: [] }>();
const props = defineProps<{ title: string; show?: boolean }>();

/**
 * 遮罩空白处点击关闭：见 useOverlayClose 的说明（@click.self 在内部有
 * v-if 动态块切换时会把 target 误判到 overlay，导致误关）。
 */
const { onOverlayMousedown, onOverlayClick } = useOverlayClose(() =>
  emit('close'),
);

/**
 * Escape 关闭：焦点在输入类元素（input/textarea/select/contentEditable）时放行。
 * 输入框里的 Esc 通常是用户想取消浏览器自动完成弹层 / 撤销当前输入，
 * 不应顺带把抽屉整个关掉。
 */
function handleKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.show) return;
  const t = e.target as HTMLElement | null;
  if (t) {
    const tag = t.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      t.isContentEditable
    ) {
      return;
    }
  }
  emit('close');
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <div
    v-if="show"
    class="dt-drawer-overlay"
    @mousedown="onOverlayMousedown"
    @click="onOverlayClick"
  >
      <aside class="dt-drawer" data-dt-root>
        <header class="dt-drawer-head">
          <div class="i-lucide-pen-line w-4 h-4" />
          <h3 class="dt-drawer-title">{{ title }}</h3>
          <button
            class="dt-drawer-close"
            type="button"
            title="关闭"
            @click="emit('close')"
          >
            <div class="i-lucide-x w-4 h-4" />
          </button>
        </header>
        <div class="dt-drawer-body">
          <slot />
        </div>
      </aside>
    </div>
</template>

<style scoped>
.dt-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 60; /* 高于表格 ⋯ 菜单 z-30 与既有弹框 z-50 */
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(2px);
}

.dt-drawer {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(560px, 92vw);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-left: 1px solid #e2e8f0;
  box-shadow: -10px 0 30px rgba(15, 23, 42, 0.2);
  animation: dt-drawer-slide-in 0.2s ease-out;
}

[data-dt-dark] .dt-drawer {
  background: var(--dt-dark-surface-1, #161b22);
  border-left-color: var(--dt-dark-border, #30363d);
}

.dt-drawer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid #f1f5f9;
  flex-shrink: 0;
  color: #3b82f6;
}

[data-dt-dark] .dt-drawer-head {
  border-bottom-color: var(--dt-dark-border, #30363d);
  color: #60a5fa;
}

.dt-drawer-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  margin: 0;
}

[data-dt-dark] .dt-drawer-title {
  color: #f1f5f9;
}

.dt-drawer-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: #94a3b8;
  transition: all 0.15s ease-out;
  flex-shrink: 0;
}

.dt-drawer-close:hover {
  background: #f1f5f9;
  color: #0f172a;
}

[data-dt-dark] .dt-drawer-close:hover {
  background: var(--dt-dark-surface-hover, #21262d);
  color: #f1f5f9;
}

.dt-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

@keyframes dt-drawer-slide-in {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}
</style>