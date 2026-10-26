<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LoginSpec } from '../spec';
import { applyLoginFormFrame } from '../spec/auto-login';
import { resolveAutoLoginScan, SCAN_ERROR_TEXT, type FormScanFrame } from '../strategies/login-form-scan';
import { sendBgMessage } from '../../../shared/messages';
import DtButton from '../../../shared/components/DtButton.vue';
import { rankPickerTabs } from './target-picker';
import { loginFormLocatorView } from './login-form-locator-model';

const props = defineProps<{
  spec: LoginSpec;
  origin?: string;
  mirrored: boolean;
}>();
const emit = defineEmits<{ change: [spec: LoginSpec] }>();

const root = ref<HTMLElement | null>(null);
const scanning = ref(false);
const notice = ref<string | null>(null);
const scanFrames = ref<FormScanFrame[]>([]);
const scanChoice = ref(0);
const view = computed(() => loginFormLocatorView(props.spec));
const hint = computed(() => ({
  auto: '登录时自动查找用户名、密码和登录按钮',
  locked: '使用已保存的定位，可在高级配置微调',
  custom: '高级配置查看；不完整项按现有校验处理',
  advanced: '此入口不替换高级多步流程',
}[view.value.mode]));

function sameOriginForScan(url: string | undefined, origin: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === origin && /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

function closeScan(): void {
  scanFrames.value = [];
  scanChoice.value = 0;
}

function lockFrame(frame: FormScanFrame): void {
  const next = applyLoginFormFrame(props.spec, frame);
  if (!next) return;
  emit('change', next);
  notice.value = null;
  closeScan();
}

async function runScan(): Promise<void> {
  if (scanning.value || !view.value.canScan) return;
  if (view.value.mode === 'custom' && !confirm('识别将替换当前三个登录定位，是否继续？')) return;
  if (props.mirrored && !confirm('锁定只修改本环境，此后不再跟随策略库的定位修改；可重置镜像恢复。是否继续？')) return;

  scanning.value = true;
  notice.value = null;
  closeScan();
  try {
    const own = await chrome.tabs.getCurrent().catch(() => undefined);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const origin = props.origin;
    const ranked = rankPickerTabs(tabs, origin, own?.id);
    const candidate = origin
      ? ranked.find((tab) => sameOriginForScan(tab.url, origin))
      : ranked.find((tab) => /^https?:\/\//.test(tab.url ?? ''));
    if (!candidate || candidate.id === undefined) {
      notice.value = '请先打开环境登录页，再识别；也可以直接保存，登录时自动定位';
      return;
    }
    const res = await sendBgMessage('SCAN_LOGIN_FORM', { tabId: candidate.id, origin: origin ?? '' });
    if (!res.success) {
      notice.value = res.error ?? SCAN_ERROR_TEXT.INJECT_FAILED;
      return;
    }
    if (res.frames.length === 0) {
      notice.value = '未找到可锁定的完整登录表单，仍可使用自动定位';
      return;
    }
    const result = resolveAutoLoginScan({ status: 'found', frames: res.frames, matches: res.frames.length, complete: true });
    if (result.status === 'resolved') {
      lockFrame(res.frames[0]);
      return;
    }
    if (res.frames.length > 1) {
      scanFrames.value = res.frames;
      return;
    }
    notice.value = result.status === 'ambiguous'
      ? '检测到多个候选，无法确定；仍可使用自动定位或在高级配置手动拾取'
      : '未找到可锁定的完整登录表单，仍可使用自动定位';
  } catch (error: unknown) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    scanning.value = false;
  }
}

function focus(): void {
  root.value?.scrollIntoView({ block: 'nearest' });
  root.value?.focus({ preventScroll: true });
}
defineExpose({ focus });
</script>

<template>
  <div ref="root" class="login-form-locator" tabindex="-1">
    <div class="locator-head">
      <span class="locator-title">登录表单定位</span>
      <span class="locator-state" :class="`locator-state-${view.mode}`">{{ view.label }}</span>
      <DtButton v-if="view.canScan" size="sm" :disabled="scanning" @click="runScan">
        <div class="i-lucide-scan-search w-3.5 h-3.5 mr-1" />
        {{ scanning ? '识别中…' : '识别并锁定登录表单' }}
      </DtButton>
    </div>
    <p class="locator-hint">{{ scanning ? '只读取当前环境页面，不会提交表单' : hint }}</p>
    <p v-if="mirrored" class="locator-hint">锁定只修改本环境，此后不再跟随策略库的定位修改；可重置镜像恢复。</p>
    <p v-if="notice" class="locator-notice" role="status">{{ notice }}</p>

    <div v-if="scanFrames.length > 1" class="scan-card">
      <strong>选择要锁定的 frame</strong>
      <label v-for="(frame, index) in scanFrames" :key="`${frame.frameId}-${index}`">
        <input v-model="scanChoice" type="radio" :value="index" />
        {{ frame.frameId === 0 ? '主页面' : `frame #${frame.frameId}` }} · {{ frame.frameUrl || '未知地址' }}
      </label>
      <div class="scan-actions">
        <DtButton size="sm" variant="primary" @click="lockFrame(scanFrames[scanChoice])">锁定所选表单</DtButton>
        <DtButton size="sm" @click="closeScan">取消</DtButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-form-locator { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 8px; outline: none; }
.login-form-locator:focus { border-color: #818cf8; box-shadow: 0 0 0 2px rgba(99,102,241,.1); }
.locator-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.locator-head :last-child { margin-left: auto; }
.locator-title { font-size: 13px; font-weight: 600; }
.locator-state { padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #4f46e5; font-size: 12px; }
.locator-state-locked { background: #ecfdf5; color: #15803d; }
.locator-state-custom, .locator-state-advanced { background: #f1f5f9; color: #64748b; }
.locator-hint { margin: 0; color: #64748b; font-size: 12px; line-height: 1.5; }
.locator-notice { margin: 0; color: #b45309; font-size: 12px; line-height: 1.5; }
.scan-card { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; font-size: 12px; }
.scan-actions { display: flex; gap: 6px; }
[data-dt-dark] .login-form-locator { border-color: #30363d; }
[data-dt-dark] .locator-hint { color: #8b949e; }
[data-dt-dark] .locator-state-custom, [data-dt-dark] .locator-state-advanced { background: #21262d; color: #8b949e; }
</style>
