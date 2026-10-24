<script setup lang="ts">
/**
 * 开关(ADR-0007):替代原生 checkbox。
 * 38×20 规格,默认 #cbd5e1 / 暗色 #475569,激活 indigo→blue 渐变 + glow。
 * 标准用法是放进 DtConfigItem 右侧(文字走 label prop),此时无需 slot;
 * slot 仅在脱离 DtConfigItem 单独使用时作开关右侧的文字标签。
 *
 * 用法:<DtConfigItem label="自动对比" hint="…"><DtToggle v-model="config.autoCompare" /></DtConfigItem>
 */
defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    class="dt-toggle"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="dt-toggle-track" :class="{ on: modelValue }">
      <span class="dt-toggle-knob" />
    </span>
    <span v-if="$slots.default" class="dt-toggle-text"><slot /></span>
  </button>
</template>

<style scoped>
.dt-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  font-size: 13px;
  color: #0f172a;
}

[data-dt-dark] .dt-toggle {
  color: #c9d1d9;
}

.dt-toggle-track {
  position: relative;
  width: 38px;
  height: 20px;
  border-radius: 9999px;
  background: #cbd5e1;
  transition: all 0.2s ease-out;
  flex-shrink: 0;
}

[data-dt-dark] .dt-toggle-track {
  background: #475569;
}

.dt-toggle-track.on {
  background: linear-gradient(135deg, #6366f1, #3b82f6);
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.35);
}

.dt-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  transition: transform 0.2s ease-out;
}

.dt-toggle-track.on .dt-toggle-knob {
  transform: translateX(18px);
}

.dt-toggle:active .dt-toggle-knob {
  transform: scale(0.9);
}

.dt-toggle:active .dt-toggle-track.on .dt-toggle-knob {
  transform: translateX(18px) scale(0.9);
}
</style>
