<script setup lang="ts">
import { computed } from "vue";
import type { AuthStorageSelection } from "../strategies/auth-storage";

const props = defineProps<{
  candidates: AuthStorageSelection;
  modelValue: AuthStorageSelection;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: AuthStorageSelection];
}>();

const hasCandidates = computed(
  () =>
    props.candidates.local.length > 0 || props.candidates.session.length > 0,
);

function setChecked(
  storage: keyof AuthStorageSelection,
  key: string,
  checked: boolean,
): void {
  const current = props.modelValue[storage];
  emit("update:modelValue", {
    ...props.modelValue,
    [storage]: checked
      ? [...current, key]
      : current.filter((selected) => selected !== key),
  });
}
</script>

<template>
  <section v-if="hasCandidates" class="auth-storage-selector">
    <strong class="auth-storage-title">切换前清除认证存储</strong>
    <p class="auth-storage-hint">只清除勾选的键，不读取或保存键值</p>

    <fieldset v-if="candidates.local.length" class="auth-storage-group">
      <legend>localStorage</legend>
      <label v-for="key in candidates.local" :key="key" class="auth-storage-key">
        <input
          type="checkbox"
          :checked="modelValue.local.includes(key)"
          @change="setChecked('local', key, ($event.target as HTMLInputElement).checked)"
        />
        <code>{{ key }}</code>
      </label>
    </fieldset>

    <fieldset v-if="candidates.session.length" class="auth-storage-group">
      <legend>sessionStorage</legend>
      <label v-for="key in candidates.session" :key="key" class="auth-storage-key">
        <input
          type="checkbox"
          :checked="modelValue.session.includes(key)"
          @change="setChecked('session', key, ($event.target as HTMLInputElement).checked)"
        />
        <code>{{ key }}</code>
      </label>
    </fieldset>
  </section>
</template>

<style scoped>
.auth-storage-selector { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; color: #0f172a; }
.auth-storage-title { font-size: 13px; font-weight: 600; }
.auth-storage-hint { margin: 0; color: #64748b; font-size: 12px; line-height: 1.5; }
.auth-storage-group { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin: 4px 0 0; padding: 0; border: 0; }
.auth-storage-group legend { padding: 0 0 4px; color: #475569; font-size: 12px; font-weight: 600; }
.auth-storage-key { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 2px; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1.5; }
.auth-storage-key:hover { background: #f8fafc; }
.auth-storage-key input { flex: 0 0 auto; margin: 0; accent-color: #4f46e5; }
.auth-storage-key input:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
.auth-storage-key code { overflow-wrap: anywhere; color: #334155; font-size: 12px; }
[data-dt-dark] .auth-storage-selector { border-color: #30363d; background: #161b22; color: #f1f5f9; }
[data-dt-dark] .auth-storage-hint, [data-dt-dark] .auth-storage-group legend { color: #8b949e; }
[data-dt-dark] .auth-storage-key:hover { background: #21262d; }
[data-dt-dark] .auth-storage-key code { color: #c9d1d9; }
</style>
