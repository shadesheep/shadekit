<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import DtButton from "../../shared/components/DtButton.vue";

defineProps<{
  show: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  ) {
    return;
  }
  emit("cancel");
}

onMounted(() => document.addEventListener("keydown", handleKeydown));
onUnmounted(() => document.removeEventListener("keydown", handleKeydown));
</script>

<template>
  <div v-if="show" class="confirm-overlay" @mousedown.self="emit('cancel')">
    <div
      class="confirm-dialog"
      data-dt-root
      role="alertdialog"
      aria-modal="true"
      :aria-label="title"
    >
      <h3 class="confirm-title">{{ title }}</h3>
      <p class="confirm-message">{{ message }}</p>
      <div class="confirm-actions">
        <DtButton variant="secondary" @click="emit('cancel')">
          {{ cancelLabel }}
        </DtButton>
        <DtButton
          :variant="danger ? 'danger' : 'primary'"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </DtButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(2px);
}

.confirm-dialog {
  width: min(360px, 92vw);
  padding: 18px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
  animation: confirm-in 0.18s ease-out;
}

@keyframes confirm-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.confirm-title {
  margin: 0 0 8px;
  color: #0f172a;
  font-size: 14px;
  font-weight: 600;
}

.confirm-message {
  margin: 0;
  color: #64748b;
  font-size: 13px;
  line-height: 1.6;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

[data-dt-dark] .confirm-dialog {
  border-color: #30363d;
  background: #161b22;
}

[data-dt-dark] .confirm-title {
  color: #f1f5f9;
}

[data-dt-dark] .confirm-message {
  color: #8b949e;
}

@media (prefers-reduced-motion: reduce) {
  .confirm-dialog {
    animation: none;
  }
}
</style>