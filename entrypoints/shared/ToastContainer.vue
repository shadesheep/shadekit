<script setup lang="ts">
import type { Toast } from '../shared/use-toast';
import { useToast } from '../shared/use-toast';

const { toasts, dismissToast } = useToast();

function iconForType(type: Toast['type']): string {
  switch (type) {
    case 'success':
      return 'i-lucide-check-circle';
    case 'error':
      return 'i-lucide-x-circle';
    case 'info':
      return 'i-lucide-info';
  }
}
</script>

<template>
  <div class="toast-container">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :class="['toast-item', `toast-${toast.type}`]"
      >
        <div :class="[iconForType(toast.type), 'toast-icon']" />
        <span class="toast-message">{{ toast.message }}</span>
        <button
          v-for="action in toast.actions"
          :key="action.label"
          class="toast-action"
          @click="action.onClick()"
        >
          {{ action.label }}
        </button>
        <button class="toast-close" @click="dismissToast(toast.id)" title="关闭">
          <div class="i-lucide-x w-3 h-3" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 360px;
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  pointer-events: auto;
  animation: toast-slide-in 0.25s ease-out;
}

.toast-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.toast-message {
  flex: 1;
  line-height: 1.4;
}

.toast-close {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  color: inherit;
  opacity: 0.5;
  transition: opacity 0.15s ease-out;
}

.toast-close:hover {
  opacity: 1;
}

/* 操作按钮（如错误 Toast 的「复制详情」） */
.toast-action {
  flex-shrink: 0;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
  cursor: pointer;
  opacity: 0.75;
  transition: all 0.15s ease-out;
}

.toast-action:hover {
  opacity: 1;
}

.toast-action:active {
  transform: scale(0.95);
}

/* Success */
.toast-success {
  background: #f0fdf4;
  color: #166534;
  border: 1px solid #bbf7d0;
}

[data-dt-dark] .toast-success {
  background: #052e16;
  color: #6ee7b7;
  border-color: #064e3b;
}

.toast-success .toast-icon {
  color: #16a34a;
}

[data-dt-dark] .toast-success .toast-icon {
  color: #4ade80;
}

/* Error */
.toast-error {
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
}

[data-dt-dark] .toast-error {
  background: #450a0a;
  color: #fca5a5;
  border-color: #7f1d1d;
}

.toast-error .toast-icon {
  color: #dc2626;
}

[data-dt-dark] .toast-error .toast-icon {
  color: #f87171;
}

/* Info */
.toast-info {
  background: #eff6ff;
  color: #1e40af;
  border: 1px solid #bfdbfe;
}

[data-dt-dark] .toast-info {
  background: #1e3a5f;
  color: #93c5fd;
  border-color: #1e40af;
}

.toast-info .toast-icon {
  color: #3b82f6;
}

[data-dt-dark] .toast-info .toast-icon {
  color: #60a5fa;
}

/* Transitions */
.toast-enter-active {
  transition: all 0.25s ease-out;
}

.toast-leave-active {
  transition: all 0.2s ease-in;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}

.toast-move {
  transition: transform 0.2s ease-out;
}

@keyframes toast-slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
