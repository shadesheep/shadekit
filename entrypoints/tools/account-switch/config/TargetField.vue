<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Target } from '../strategies/generic-recipe';
import { AUTO_LOGIN_TARGET, isAutoLoginTarget } from '../spec/auto-login';
import type { LoginFormTarget } from '../spec/types';
import {
  describeTargetForUi,
  insertAtCursor as insertTextAt,
  makeTarget,
  targetKind,
  targetTypeWarning,
  targetValue,
  TARGET_KIND_OPTIONS,
  type TargetContext,
  type TargetKind,
  type TargetMeta,
} from './recipe-editor-model';
import {
  PICK_ERROR_TEXT,
  startTargetPicker,
  type TargetCandidate,
} from './target-picker';
import DtButton from '../../../shared/components/DtButton.vue';

/**
 * 定位输入组件（ADR-0013 D5）
 *
 * kind 下拉 + 值输入 + 拾取 + 候选胶囊 + 命中提示，替换配方编辑器里全部
 * Target 输入点（fill / click / waitFor / 成功判定 / 失败判定 / extract）。
 * 保留手填路径：拾取只是加速器，不是唯一入口。
 */

const props = withDefaults(
  defineProps<{
    modelValue: LoginFormTarget | null;
    /** 仅 DOM fill/click 开启；其它 Target 输入点不显示自动类型。 */
    allowAuto?: boolean;
    /** 决定类型提示的语义：填充 / 点击 / 仅定位 */
    context: TargetContext;
    /** 目标环境 origin（拾取时用于挑选标签页） */
    origin?: string;
    placeholder?: string;
    disabled?: boolean;
    /** 上一次拾取到的候选（由父组件保存，切换行后不丢失） */
    candidates?: TargetCandidate[];
  }>(),
  {
    placeholder: '例: #username 或 用户名',
    disabled: false,
    allowAuto: false,
    candidates: () => [],
  },
);

const emit = defineEmits<{
  'update:modelValue': [target: LoginFormTarget];
  'update:frameScope': [scope: { frameId?: number; frameUrl?: string }];
  /** 拾取成功：父组件据此建议填充值、保存候选 */
  picked: [payload: { meta: TargetMeta; candidates: TargetCandidate[] }];
}>();

type LocalNotice = { kind: 'error' | 'warn' | 'info'; message: string };

const pickerBusy = ref(false);
const localNotice = ref<LocalNotice | null>(null);
const typeWarning = ref<string | null>(null);

/**
 * 外部改值（父组件重置 / 选中候选）后，旧的拾取提示与类型警告失效。
 * 自己发出的值不算「外部」，否则拾取刚给出的警告会被立刻清掉。
 */
let selfValue = "";
watch(
  () => props.modelValue,
  (next) => {
    const serialized = JSON.stringify(next);
    if (serialized === selfValue) return;
    localNotice.value = null;
    typeWarning.value = null;
  },
);

function emitValue(target: LoginFormTarget): void {
  selfValue = JSON.stringify(target);
  emit("update:modelValue", target);
}

type FieldKind = TargetKind | 'auto';
const isAuto = computed(() => props.allowAuto && isAutoLoginTarget(props.modelValue));
const value = computed(() => isAuto.value ? '' : targetValue(props.modelValue as Target | null));
const kind = computed<FieldKind>(() => isAuto.value ? 'auto' : targetKind(props.modelValue as Target | null));

/** 值输入框光标位置：变量胶囊插入到光标处（ADR-0013 D10） */
const valueInput = ref<HTMLInputElement | null>(null);
let cursor = { start: 0, end: 0, focused: false };

function rememberCursor(): void {
  const input = valueInput.value;
  if (!input) return;
  cursor = {
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.selectionStart ?? input.value.length,
    focused: document.activeElement === input,
  };
}

/** 在光标处插入文本（未聚焦时追加到末尾），供变量胶囊调用 */
function insertToken(token: string): void {
  const current = value.value;
  const at = cursor.focused ? cursor.start : current.length;
  const to = cursor.focused ? cursor.end : current.length;
  const next = insertTextAt(current, token, at, to);
  updateValue(next.value);
  cursor = {
    start: next.cursor,
    end: next.cursor,
    focused: cursor.focused,
  };
}

defineExpose({ insertToken });

/** 展示用候选：首个与当前值相同的不重复成胶囊 */
const pills = computed(() =>
  isAuto.value ? [] : props.candidates.filter(
    (candidate) => targetValue(candidate.target) !== value.value ||
      targetKind(candidate.target) !== kind.value,
  ),
);

function updateKind(next: FieldKind): void {
  emitValue(next === 'auto' ? AUTO_LOGIN_TARGET : makeTarget(next, value.value));
  typeWarning.value = null;
}

function updateValue(next: string): void {
  if (kind.value === 'auto') return;
  emitValue(makeTarget(kind.value, next));
  typeWarning.value = null;
}

function onValueInput(event: Event): void {
  updateValue((event.target as HTMLInputElement).value);
  rememberCursor();
}

function selectCandidate(candidate: TargetCandidate): void {
  emitValue(candidate.target);
  typeWarning.value = null;
}

function clearTarget(): void {
  emitValue('');
  emit('update:frameScope', {});
  typeWarning.value = null;
  localNotice.value = null;
}

async function pick(): Promise<void> {
  if (pickerBusy.value || props.disabled) return;
  pickerBusy.value = true;
  localNotice.value = null;
  try {
    const own = await chrome.tabs.getCurrent().catch(() => undefined);
    const result = await startTargetPicker({
      origin: props.origin,
      ownTabId: own?.id,
      ownWindowId: own?.windowId,
    });
    switch (result.status) {
      case 'picked':
        emitValue(result.target);
        emit('update:frameScope', {
          frameId: result.frameId,
          frameUrl: result.frameUrl,
        });
        typeWarning.value = targetTypeWarning(props.context, result.meta);
        emit('picked', {
          meta: result.meta,
          candidates: result.candidates,
        });
        return;
      case 'cancelled':
        localNotice.value = { kind: 'info', message: '已取消拾取' };
        return;
      case 'lost':
        localNotice.value = {
          kind: 'warn',
          message: '页面已跳转，拾取已中断，请重试',
        };
        return;
      case 'error':
        localNotice.value = {
          kind: 'error',
          message: PICK_ERROR_TEXT[result.code],
        };
        return;
    }
  } finally {
    pickerBusy.value = false;
  }
}
</script>

<template>
  <div class="target-field">
    <div class="target-row">
      <select
        class="dt-input target-kind"
        :value="kind"
        :disabled="disabled"
        @change="updateKind(($event.target as HTMLSelectElement).value as FieldKind)"
      >
        <option v-if="allowAuto" value="auto">自动（登录表单）</option>
        <option v-for="opt in TARGET_KIND_OPTIONS" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <input
        v-if="!isAuto"
        ref="valueInput"
        class="dt-input target-value"
        :value="value"
        :placeholder="placeholder"
        :disabled="disabled"
        @input="onValueInput"
        @focus="rememberCursor"
        @keyup="rememberCursor"
        @click="rememberCursor"
        @select="rememberCursor"
      />
      <DtButton
        v-if="!isAuto"
        size="sm"
        class="pick-btn"
        :disabled="disabled || pickerBusy"
        @click="pick"
      >
        <div class="i-lucide-crosshair w-3.5 h-3.5 mr-1" />
        {{ pickerBusy ? '拾取中…' : '拾取' }}
      </DtButton>
      <button
        v-if="value || isAuto"
        type="button"
        class="icon-btn"
        title="清除定位"
        :disabled="disabled"
        @click="clearTarget"
      >
        <div class="i-lucide-x w-3.5 h-3.5" />
      </button>
    </div>

    <div v-if="pills.length > 0" class="candidate-row">
      <span class="candidate-label">候选</span>
      <button
        v-for="candidate in pills"
        :key="`${candidate.rank}-${targetValue(candidate.target)}`"
        type="button"
        class="candidate-pill"
        :class="{ 'candidate-ambiguous': candidate.count !== 1 }"
        :title="candidate.note || describeTargetForUi(candidate.target)"
        :disabled="disabled"
        @click="selectCandidate(candidate)"
      >
        <span class="candidate-text">{{ describeTargetForUi(candidate.target) }}</span>
        <span class="candidate-count">
          {{ candidate.count === 1 ? '唯一' : `命中 ${candidate.count}` }}
        </span>
      </button>
    </div>

    <p v-if="value || isAuto" class="target-hint">当前定位：{{ isAuto ? '自动（登录表单）' : describeTargetForUi(modelValue) }}</p>

    <p
      v-if="localNotice"
      class="picker-notice"
      :class="`picker-notice-${localNotice.kind}`"
    >
      <span
        :class="
          localNotice.kind === 'error'
            ? 'i-lucide-alert-circle'
            : localNotice.kind === 'warn'
              ? 'i-lucide-alert-triangle'
              : 'i-lucide-info'
        "
        class="w-3.5 h-3.5 picker-notice-icon"
      />{{ localNotice.message }}
    </p>

    <p v-if="typeWarning" class="picker-notice picker-notice-warn">
      <span class="i-lucide-alert-triangle w-3.5 h-3.5 picker-notice-icon" />{{ typeWarning }}
    </p>
  </div>
</template>

<style scoped>
@import '../../../shared/component-styles.scss';
@import './config-panel-shared.scss';

.target-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.target-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.target-kind {
  max-width: 130px;
  flex-shrink: 0;
}

.target-value {
  flex: 1;
  min-width: 0;
}

.pick-btn {
  flex-shrink: 0;
  font-size: 12px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s ease-out;
}

.icon-btn:hover:not(:disabled) {
  border-color: #fecaca;
  color: #dc2626;
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

[data-dt-dark] .icon-btn {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #8b949e;
}

[data-dt-dark] .icon-btn:hover:not(:disabled) {
  border-color: #7f1d1d;
  color: #f87171;
}

.candidate-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.candidate-label {
  font-size: 12px;
  color: #94a3b8;
}

[data-dt-dark] .candidate-label {
  color: #64748b;
}

.candidate-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 9999px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-mono);
  color: #475569;
  transition: all 0.15s ease-out;
}

.candidate-pill:hover:not(:disabled) {
  border-color: #93c5fd;
  color: #3b82f6;
  transform: translateY(-1px);
}

.candidate-pill:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.candidate-text {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate-count {
  font-size: 12px;
  color: #16a34a;
}

.candidate-ambiguous {
  border-color: #fcd34d;
}

.candidate-ambiguous .candidate-count {
  color: #b45309;
}

[data-dt-dark] .candidate-pill {
  background: var(--dt-dark-surface-hover);
  border-color: var(--dt-dark-border);
  color: #cbd5e1;
}

[data-dt-dark] .candidate-pill:hover:not(:disabled) {
  border-color: #58a6ff;
  color: #60a5fa;
}

[data-dt-dark] .candidate-count {
  color: #4ade80;
}

[data-dt-dark] .candidate-ambiguous {
  border-color: #78350f;
}

[data-dt-dark] .candidate-ambiguous .candidate-count {
  color: #fbbf24;
}

.target-hint {
  font-size: 12px;
  font-family: var(--font-mono);
  color: #94a3b8;
}

[data-dt-dark] .target-hint {
  color: #64748b;
}

/* 拾取结果 / 类型提示的行内文案（ADR-0013 D1 / D6） */
.picker-notice {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-size: 12px;
}

.picker-notice-icon {
  flex-shrink: 0;
}

.picker-notice-error {
  color: #dc2626;
}

.picker-notice-warn {
  color: #b45309;
}

.picker-notice-info {
  color: #64748b;
}

[data-dt-dark] .picker-notice-error {
  color: #f87171;
}

[data-dt-dark] .picker-notice-warn {
  color: #fbbf24;
}

[data-dt-dark] .picker-notice-info {
  color: #8b949e;
}
</style>
