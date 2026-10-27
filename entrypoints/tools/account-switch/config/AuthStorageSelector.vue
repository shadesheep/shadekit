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
    <div class="auth-storage-header">
      <span class="i-lucide-shield-check w-4 h-4 auth-storage-icon" aria-hidden="true" />
      <strong class="auth-storage-title">切换前清除旧登录信息</strong>
      <span class="auth-storage-recommended">推荐</span>
    </div>
    <p class="auth-storage-hint">
      避免切换后仍进入旧账号。只清理选中的登录信息，不影响账号密码和网站其他设置。
    </p>

    <details class="auth-storage-details">
      <summary>
        <span>清理项目</span>
        <span class="auth-storage-summary-note">通常无需修改</span>
        <span class="i-lucide-chevron-down w-3.5 h-3.5 auth-storage-chevron" aria-hidden="true" />
      </summary>
      <div class="auth-storage-detail-body">
        <fieldset v-if="candidates.local.length" class="auth-storage-group">
          <legend>长期保存 <span>localStorage</span></legend>
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
          <legend>当前标签页 <span>sessionStorage</span></legend>
          <label v-for="key in candidates.session" :key="key" class="auth-storage-key">
            <input
              type="checkbox"
              :checked="modelValue.session.includes(key)"
              @change="setChecked('session', key, ($event.target as HTMLInputElement).checked)"
            />
            <code>{{ key }}</code>
          </label>
        </fieldset>
      </div>
    </details>
  </section>
</template>

<style scoped>
.auth-storage-selector { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff; color: #0f172a; }
.auth-storage-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.auth-storage-icon { flex: 0 0 auto; color: #4f46e5; }
.auth-storage-title { font-size: 13px; font-weight: 600; }
.auth-storage-recommended { padding: 1px 6px; border-radius: 9999px; background: #eef2ff; color: #4f46e5; font-size: 12px; line-height: 1.5; }
.auth-storage-hint { margin: 0; color: #64748b; font-size: 12px; line-height: 1.6; }
.auth-storage-details { border-top: 1px solid #e2e8f0; }
.auth-storage-details summary { display: flex; align-items: center; gap: 6px; min-height: 36px; border-radius: 4px; color: #475569; cursor: pointer; font-size: 12px; font-weight: 500; list-style: none; }
.auth-storage-details summary::-webkit-details-marker { display: none; }
.auth-storage-details summary:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
.auth-storage-summary-note { margin-left: auto; color: #64748b; font-weight: 400; }
.auth-storage-chevron { flex: 0 0 auto; transition: transform .15s ease-out; }
.auth-storage-details[open] .auth-storage-chevron { transform: rotate(180deg); }
.auth-storage-detail-body { padding-top: 4px; }
.auth-storage-group { display: flex; flex-direction: column; gap: 2px; min-width: 0; margin: 4px 0 0; padding: 0; border: 0; }
.auth-storage-group + .auth-storage-group { margin-top: 10px; }
.auth-storage-group legend { padding: 0 0 4px; color: #475569; font-size: 12px; font-weight: 600; }
.auth-storage-group legend span { margin-left: 4px; color: #64748b; font-weight: 400; }
.auth-storage-key { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 2px; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1.5; }
.auth-storage-key:hover { background: #f8fafc; }
.auth-storage-key input { flex: 0 0 auto; margin: 0; accent-color: #4f46e5; }
.auth-storage-key input:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
.auth-storage-key code { overflow-wrap: anywhere; color: #334155; font-size: 12px; }
[data-dt-dark] .auth-storage-selector { border-color: #30363d; background: #161b22; color: #f1f5f9; }
[data-dt-dark] .auth-storage-icon { color: #818cf8; }
[data-dt-dark] .auth-storage-recommended { background: #1e3a5f; color: #93c5fd; }
[data-dt-dark] .auth-storage-hint, [data-dt-dark] .auth-storage-group legend, [data-dt-dark] .auth-storage-details summary { color: #8b949e; }
[data-dt-dark] .auth-storage-summary-note, [data-dt-dark] .auth-storage-group legend span { color: #8b949e; }
[data-dt-dark] .auth-storage-details { border-top-color: #30363d; }
[data-dt-dark] .auth-storage-key:hover { background: #21262d; }
[data-dt-dark] .auth-storage-key code { color: #c9d1d9; }

@media (prefers-reduced-motion: reduce) {
  .auth-storage-chevron { transition: none; }
}
</style>
