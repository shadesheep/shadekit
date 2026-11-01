<script setup lang="ts">
/**
 * 共享文件选择器 — 独立工具标签页统一「选择文件」外观。
 *
 * 原生 <input type="file"> 隐藏但保持可访问（视觉隐藏 + focus 提示），
 * 视觉主体是按钮（复用 DtButton 边框样式），旁边显示已选文件名（可选）。
 * select 后 emit('select', File) 并自动重置 input，可连续选择同一文件。
 *
 * 用法：<DtFilePicker accept=".json,application/json" label="选择 JSON 文件" @select="onFile" />
 */
import { ref } from "vue";

withDefaults(
  defineProps<{
    accept?: string;
    label?: string;
    placeholder?: string;
  }>(),
  { accept: "", label: "选择文件", placeholder: "未选择文件" },
);

const emit = defineEmits<{
  select: [file: File];
}>();

const fileName = ref("");

function onChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  fileName.value = file.name;
  emit("select", file);
}
</script>

<template>
  <div class="file-picker">
    <label class="file-trigger">
      <input
        class="file-input"
        type="file"
        :accept="accept"
        @change="onChange"
      />
      <span class="file-btn">
        <div class="i-lucide-folder-open w-3.5 h-3.5" />
        {{ label }}
      </span>
    </label>
    <span
      class="file-name"
      :class="{ 'is-empty': !fileName }"
      :title="fileName"
      >{{ fileName || placeholder }}</span
    >
  </div>
</template>

<style scoped>
.file-picker {
  display: inline-flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

/* 原生输入框视觉隐藏，仍可被键盘聚焦 */
.file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  clip: rect(0 0 0 0);
}

.file-trigger {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}

.file-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #374151;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.file-trigger:hover .file-btn {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.file-trigger:active .file-btn {
  transform: scale(0.98);
}

.file-input:focus-visible + .file-btn {
  outline: 2px solid #818cf8;
  outline-offset: 2px;
}

.file-name {
  max-width: 220px;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #334155;
}

.file-name.is-empty {
  color: #94a3b8;
}

[data-dt-dark] .file-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #c9d1d9;
}

[data-dt-dark] .file-trigger:hover .file-btn {
  background: var(--dt-dark-border);
}

[data-dt-dark] .file-name {
  color: #c9d1d9;
}

[data-dt-dark] .file-name.is-empty {
  color: #6e7681;
}
</style>