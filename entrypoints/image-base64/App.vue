<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  buildDownloadName,
  downloadDataUrlAsFile,
  downloadTextAsFile,
} from '../shared/download';
import { copyToClipboard } from '../shared/clipboard';
import { attachFileDrop } from '../shared/lib/codemirror-editor';
import DtButton from '../shared/components/DtButton.vue';
import DtEmptyState from '../shared/components/DtEmptyState.vue';
import DtPanel from '../shared/components/DtPanel.vue';
import { getConfig, keyFor } from '../shared/tool-config';
import ToastContainer from '../shared/ToastContainer.vue';
import { showToast } from '../shared/use-toast';
import {
  dataUrlExtension,
  DEFAULT_IMAGE_BASE64_CONFIG,
  effectiveQuality,
  type ImageBase64Config,
  imageMimeType,
  normalizeImageBase64Config,
} from '../tools/image-base64/lib/convert-settings';
import {
  classifyPastedText,
  ONLINE_CONVERT_ERROR_MESSAGE,
} from '../tools/image-base64/lib/upload-feedback';

type Mode = 'image-to-base64' | 'base64-to-image';

const mode = ref<Mode>('image-to-base64');
const previewSrc = ref('');
const resultContent = ref('');
const base64Input = ref('');
const base64Output = ref('');
const originalSize = ref('');
const base64Size = ref('');
const fileInputRef = ref<HTMLInputElement>();
const panelRef = ref<HTMLDivElement>();
let detachFileDrop: (() => void) | undefined;

// 在线转换 loading 态（防重入 + 加载指示）
const converting = ref(false);
// 拖拽悬停高亮（深度计数在 attachFileDrop 内部，组件只消费结果）
const dragActive = ref(false);

// 在线图片转 canvas 时的边缘留白：避免边缘像素被裁切，同时给结果图留出视觉缓冲
const PREVIEW_PADDING = 24;

// 输出格式/质量配置（选项页修改后通过 storage.onChanged 即时生效）
const convertConfig = ref<ImageBase64Config>({
  ...DEFAULT_IMAGE_BASE64_CONFIG,
});

function applyConfig(saved: Partial<ImageBase64Config> | undefined): void {
  convertConfig.value = normalizeImageBase64Config(saved);
}

function onConvertConfigChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  if (areaName !== 'local') return;
  const change = changes[keyFor('image-base64')];
  if (change?.newValue) {
    applyConfig(change.newValue as Partial<ImageBase64Config>);
  }
}

// ─── 工具函数 ───────────────────────────────────────────────

function sizeFormat(num: number): string {
  if (isNaN(num)) return '暂无数据';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(2)} KB`;
  return `${(num / 1024 / 1024).toFixed(2)} MB`;
}

// ─── 核心转换逻辑 ───────────────────────────────────────────

function handleFile(file: File): void {
  if (converting.value) {
    showToast('正在转换在线图片，请稍候…', 'info');
    return;
  }
  if (!/image\//.test(file.type)) {
    showToast('请选择图片文件！', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (evt) => {
    const result = evt.target?.result as string;
    resultContent.value = result;
    previewSrc.value = result;
    originalSize.value = sizeFormat(file.size);
    base64Size.value = sizeFormat(result.length);
    showToast('图片转换完成', 'success');
  };
  reader.readAsDataURL(file);
}

function convertOnline(onlineSrc: string): Promise<boolean> {
  return new Promise((resolve) => {
    previewSrc.value = onlineSrc;
    const image = new Image();
    image.src = onlineSrc;
    image.onload = () => {
      try {
        const width = image.naturalWidth;
        const height = image.naturalHeight;

        const canvas = document.createElement('canvas');
        canvas.height = height + PREVIEW_PADDING * 2;
        canvas.width = width + PREVIEW_PADDING * 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(false);
          return;
        }
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, width, height, PREVIEW_PADDING, PREVIEW_PADDING, width, height);

        // 跨域图片会污染 canvas，toDataURL 抛 SecurityError —— 按失败处理
        const { imageFormat, imageQuality } = convertConfig.value;
        resultContent.value = canvas.toDataURL(
          imageMimeType(imageFormat),
          effectiveQuality(imageFormat, imageQuality),
        );
        originalSize.value = `${width}x${height}`;
        base64Size.value = sizeFormat(resultContent.value.length);
        resolve(true);
      } catch {
        resolve(false);
      }
    };
    image.onerror = () => resolve(false);
  });
}

/** 在线 URL 转换入口：loading 期间防重入，失败给出明确错误提示 */
async function runOnlineConvert(url: string): Promise<void> {
  if (converting.value) {
    showToast('正在转换在线图片，请稍候…', 'info');
    return;
  }
  converting.value = true;
  try {
    const ok = await convertOnline(url);
    if (ok) {
      showToast('在线图片转换完成', 'success');
    } else {
      // 失败时清掉本次设置的预览，避免残留破图
      if (previewSrc.value === url) {
        previewSrc.value = '';
      }
      showToast(ONLINE_CONVERT_ERROR_MESSAGE, 'error');
    }
  } finally {
    converting.value = false;
  }
}

// ─── 事件处理 ───────────────────────────────────────────────

function onFileChange(): void {
  const file = fileInputRef.value?.files?.[0];
  if (file) {
    handleFile(file);
    if (fileInputRef.value) {
      fileInputRef.value.value = '';
    }
  }
}

function onUploadClick(): void {
  fileInputRef.value?.click();
}

async function handlePaste(event: ClipboardEvent): Promise<void> {
  if (mode.value !== 'image-to-base64') return;
  const clipboardData = event.clipboardData;
  if (!clipboardData) return;

  const items = clipboardData.items;

  // 优先处理图片
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (/image\//.test(item.type)) {
      const file = item.getAsFile();
      if (file) handleFile(file);
      return;
    }
  }

  // 尝试处理 URL / base64 文本
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (/text\/plain/.test(item.type)) {
      const text = await new Promise<string>((resolve) => {
        item.getAsString(resolve);
      });
      const pasted = classifyPastedText(text);
      if (pasted.kind === 'image-url') {
        await runOnlineConvert(pasted.url);
      } else if (pasted.kind === 'text') {
        handleBase64Input(pasted.value);
      }
      return;
    }
  }
}

function handleBase64Input(val: string): void {
  base64Input.value = val;
  if (val.length === 0) {
    base64Output.value = '';
    return;
  }
  if (val.indexOf('data:') === -1) {
    base64Output.value = `data:image/jpeg;base64,${val}`;
  } else {
    base64Output.value = val;
  }
}

function onBase64InputError(): void {
  if (mode.value === 'base64-to-image' && base64Input.value.trim().length) {
    showToast('无法识别的 Base64 编码，请确认是正确的图片 Data URI？', 'error');
  }
}

// ─── 模式切换 ───────────────────────────────────────────────

function toggleMode(): void {
  mode.value =
    mode.value === 'image-to-base64' ? 'base64-to-image' : 'image-to-base64';
}

// ─── 复制 ───────────────────────────────────────────────────

async function copyResult(): Promise<void> {
  const text =
    mode.value === 'image-to-base64' ? resultContent.value : base64Input.value;
  if (text) {
    const ok = await copyToClipboard(text);
    showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
  }
}

// ─── 下载 ───────────────────────────────────────────────────

/** 下载 data URL 为图片文件，后缀按实际 MIME 推导 */
function downloadImage(dataUrl: string): void {
  if (!dataUrl) return;
  const filename = buildDownloadName(
    'image',
    dataUrlExtension(dataUrl),
    new Date(),
  );
  downloadDataUrlAsFile(dataUrl, filename);
  showToast('图片已开始下载', 'success');
}

function downloadResultImage(): void {
  downloadImage(resultContent.value);
}

function downloadPreviewImage(): void {
  downloadImage(base64Output.value);
}

function downloadResultText(): void {
  if (!resultContent.value) return;
  const filename = buildDownloadName('base64', 'txt', new Date());
  downloadTextAsFile(resultContent.value, filename, 'text/plain');
  showToast('Base64 文本已开始下载', 'success');
}

// ─── 生命周期 ───────────────────────────────────────────────

onMounted(async () => {
  document.addEventListener('paste', handlePaste);
  applyConfig(await getConfig<ImageBase64Config>('image-base64'));
  chrome.storage.onChanged.addListener(onConvertConfigChanged);
  // 上传区始终渲染（v-show 控制显隐），直接挂载拖拽；隐藏态不会成为 drop 目标
  if (panelRef.value) {
    detachFileDrop = attachFileDrop(panelRef.value, {
      filesOnlyHint: true,
      onFile: handleFile,
      onDraggingChange: (dragging) => {
        dragActive.value = dragging;
      },
    });
  }
});

onUnmounted(() => {
  document.removeEventListener('paste', handlePaste);
  chrome.storage.onChanged.removeListener(onConvertConfigChanged);
  detachFileDrop?.();
});
</script>

<template>
  <div class="page-wrapper" data-dt-root>
    <!-- 顶部工具栏 -->
    <div class="top-bar">
      <div class="brand">
        <div class="i-lucide-image w-5 h-5" />
        <span>图片 Base64</span>
      </div>
      <div class="toolbar-actions">
        <DtButton variant="primary" :disabled="converting" @click="toggleMode">
          切换为 {{ mode === 'image-to-base64' ? 'Base64 转图片' : '图片转 Base64' }} &gt;&gt;
        </DtButton>
      </div>
    </div>

    <!-- 图片 → Base64 模式 -->
    <div v-show="mode === 'image-to-base64'" class="content-area">
      <!-- 左侧：上传区域 -->
      <DtPanel class="upload-panel" title="上传或粘贴图片">
        <div
          ref="panelRef"
          class="upload-area"
          :class="{ 'drag-over': dragActive, 'has-preview': previewSrc }"
        >
          <img v-if="previewSrc" :src="previewSrc" alt="preview" class="preview-img" />
          <div v-if="previewSrc" class="replace-btn-wrap">
            <DtButton variant="primary" class="replace-btn" :disabled="converting" @click="onUploadClick">更换图片</DtButton>
          </div>
          <div v-else class="upload-placeholder">
            <DtButton variant="primary" class="upload-btn" :disabled="converting" @click="onUploadClick">选择图片</DtButton>
            <p class="drag-drop-tip">或拖拽图片到这里</p>
          </div>
          <div v-if="converting" class="converting-overlay">
            <div class="converting-spinner" />
            <p class="converting-text">正在转换在线图片…</p>
          </div>
        </div>
        <div class="tips">
          <p>1. 支持 <b>屏幕截图</b> 后直接在此处粘贴进行转化</p>
          <p>2. 支持 <b>复制文件、复制图片</b> 在线地址在此处直接粘贴进行转化</p>
        </div>
      </DtPanel>

      <!-- 右侧：结果区域 -->
      <DtPanel class="result-panel" title="转换结果">
        <template #actions>
          <template v-if="resultContent">
            <DtButton icon @click="copyResult">复制</DtButton>
            <DtButton icon @click="downloadResultText">下载文本</DtButton>
            <DtButton icon @click="downloadResultImage">下载图片</DtButton>
          </template>
        </template>
        <textarea
          class="result-textarea"
          :value="resultContent"
          placeholder="内容会自动生成..."
          readonly
          @click="($event.target as HTMLTextAreaElement).select()"
        />
        <div class="result-info">
          <div class="info-item">
            <span class="info-label">原始图片大小：</span>
            <span class="info-value">{{ originalSize }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">DataURI 大小：</span>
            <span class="info-value">{{ base64Size }}</span>
          </div>
        </div>
      </DtPanel>
    </div>

    <!-- Base64 → 图片 模式 -->
    <div v-show="mode === 'base64-to-image'" class="content-area">
      <!-- 左侧：Base64 输入 -->
      <DtPanel class="input-panel" title="输入 Base64 数据">
        <textarea
          class="input-textarea"
          v-model="base64Input"
          placeholder="在这里粘贴 DataURI 数据..."
          @input="handleBase64Input(($event.target as HTMLTextAreaElement).value)"
        />
      </DtPanel>

      <!-- 右侧：图片预览 -->
      <DtPanel class="preview-panel" title="预览结果">
        <template #actions>
          <DtButton v-if="base64Output" icon @click="downloadPreviewImage">下载图片</DtButton>
        </template>
        <div class="preview-container">
          <img
            v-if="base64Input.length > 0"
            :src="base64Output"
            alt="base64 preview"
            class="preview-img-large"
            @error="onBase64InputError"
          />
          <DtEmptyState v-else>
            <template #icon><div class="i-lucide-image w-8 h-8" /></template>
            输入 Base64 数据后预览图片
          </DtEmptyState>
        </div>
      </DtPanel>
    </div>

    <ToastContainer />

    <!-- 隐藏的文件输入 -->
    <input
      ref="fileInputRef"
      type="file"
      accept=".jpg,.jpeg,.gif,.png,.bmp,.webp,.svg,.ico"
      class="hidden"
      @change="onFileChange"
    />
  </div>
</template>

<style scoped>
/* 上传区域 */
.upload-panel {
  flex: 0 0 40%;
  min-width: 300px;
}

.upload-area {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  background: #fff url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFgAAABLCAIAAAB7tddWAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyRpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuMy1jMDExIDY2LjE0NTY2MSwgMjAxMi8wMi8wNi0xNDo1NjoyNyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENTNiAoTWFjaW50b3NoKSIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo1Q0VBNzA0MjEyMDUxMUUzODk2Q0JFM0Q1RjE4QkExQyIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDo1Q0VBNzA0MzEyMDUxMUUzODk2Q0JFM0Q1RjE4QkExQyI+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOjAzNDA2MkY1MTIwMzExRTM4OTZDQkUzRDVGMThCQTFDIiBzdFJlZjpkb2N1bWVudElEPSJ4bXAuZGlkOjAzNDA2MkY2MTIwMzExRTM4OTZDQkUzRDVGMThCQTFDIi8+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+K6izdgAAAk1JREFUeNrt2+uOgjAQhuG9/5tUPEs0nhU87hvNGoJY0C0yyNffBNuHdjpT8Oeidm0/IhCEIAQhCEEIQhCCEMT5fA6CoHVt7Xb7dDo1d0Yw/tZfE4QgBCEIQQjCHMThcBiPx51Op/XBljngl1pufvEaxH6//zCBUQjmwttd+SqI9rUJ4pK89XA4jKKoocEyCUG8aO6ukYSg5hOEIAQhCEH4gOCa+Xze7/e5vtvtTiaT4/HYOAj2116vl0psgiDYbrcGy7YSIQaDQWaSh0VJ88IixHK5dCS80+m0KRBhGDogWDIex8D8St7cVowYjUYOCGr5gr8YxzEhFjhiLUGXqfRY4JiGoPcOCMJH7m8xnmc3od5LVjqmIXa7nQOCPTX3HOy26TrK6tVqVQMIR5hgnrv7ysAe910HqHUILmBJp7pO7OBpe1G4tfV6bR3iHu0WiwWrfTab5aZSjMG9IjLXyGazqQHEq2eibxzD3V+FfwkEU8bLAWe9IVg1vk56awxB+ExN74ZCkCB5PPuvKwS5gN+XICYg6AQDI1lgv2TjzL2hOwGtKwQBj9KoeCpNj1PXfwMEWVNmt5gazxaRu1SvJYR7nRMLH4+kvIeG6iGKDInyIVliUCCU98a4GojiQ6IoIHeMoohFVOor9QogiPmVfCVgC4JnW8nXM+Ygytj5aglhtglCEIIQhCCMQVT1neVLh9qfeAlM+WQcgh5+AiKOY5vZ5H06FDkN8gBxO2gNw5C00s7UoCf0h1795xtY/e9TEIIQhCAEIQhBCEIQftovDwuUVV5nLjcAAAAASUVORK5CYII=") center no-repeat;
  border: 4px dashed #e2e8f0;
  border-radius: 0;
  margin: 0;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

/* 已有预览图时去除占位棋盘背景，避免与真实预览图重叠 */
.upload-area.has-preview {
  background-image: none;
}

[data-dt-dark] .upload-area {
  background: var(--dt-dark-base);
  border-color: var(--dt-dark-border);
}

/* 拖拽高亮 */
.upload-area.drag-over {
  border-color: #6366f1;
  background-color: rgba(99, 102, 241, 0.06);
}

[data-dt-dark] .upload-area.drag-over {
  border-color: #818cf8;
  background-color: rgba(129, 140, 248, 0.1);
}

/* 在线转换 loading 遮罩 */
.converting-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(255, 255, 255, 0.78);
  backdrop-filter: blur(2px);
}

[data-dt-dark] .converting-overlay {
  background: rgba(15, 23, 42, 0.72);
}

.converting-spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid rgba(99, 102, 241, 0.25);
  border-top-color: #6366f1;
  animation: dt-spin 0.8s linear infinite;
}

[data-dt-dark] .converting-spinner {
  border-color: rgba(129, 140, 248, 0.25);
  border-top-color: #818cf8;
}

@keyframes dt-spin {
  to {
    transform: rotate(360deg);
  }
}

.converting-text {
  margin: 0;
  font-size: 13px;
  color: #6366f1;
}

[data-dt-dark] .converting-text {
  color: #818cf8;
}

.preview-img {
  max-width: 260px;
  max-height: 260px;
}

.replace-btn-wrap {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
}

/* DtButton 覆盖：更换图片（半透明悬浮在预览图上） */
.replace-btn-wrap .replace-btn {
  background: rgba(99, 102, 241, 0.85);
  padding: 4px 14px;
  backdrop-filter: blur(4px);
}

.replace-btn-wrap .replace-btn:hover {
  background: rgba(99, 102, 241, 1);
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.3);
}

.upload-placeholder {
  text-align: center;
}

/* DtButton 覆盖：选择图片（大号 CTA） */
.upload-placeholder .upload-btn {
  font-size: 16px;
  line-height: 40px;
  height: 40px;
  padding: 0 25px;
}

.drag-drop-tip {
  color: #94a3b8;
  margin-top: 10px;
  font-size: 13px;
}

[data-dt-dark] .drag-drop-tip {
  color: var(--dt-dark-text-secondary);
}

.tips {
  padding: 10px 14px;
  color: #94a3b8;
  font-size: 12px;
  line-height: 1.8;
  border-top: 1px solid #e2e8f0;
}

.tips p {
  margin: 0;
}

[data-dt-dark] .tips {
  border-color: var(--dt-dark-border);
  color: var(--dt-dark-text-muted);
}

/* 结果区域 */
.result-panel {
  flex: 1;
  min-width: 0;
}

.result-textarea {
  flex: 1;
  padding: 10px 12px;
  margin: 0;
  resize: none;
  outline: none;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  margin: 8px;
  background: #f8fafc;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  min-height: 0;
  color: #334155;
  transition: border-color 0.15s ease;
}

.result-textarea:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

[data-dt-dark] .result-textarea {
  background: var(--dt-dark-base);
  color: #f0f6fc;
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .result-textarea:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.15);
}

.result-info {
  padding: 8px 14px;
  border-top: 1px solid #e2e8f0;
  font-size: 12px;
}

[data-dt-dark] .result-info {
  border-color: var(--dt-dark-border);
}

.info-item {
  margin: 4px 0;
}

.info-label {
  color: #64748b;
}

[data-dt-dark] .info-label {
  color: #8b949e;
}

.info-value {
  color: #059669;
  font-style: italic;
}

[data-dt-dark] .info-value {
  color: #f0883e;
}

/* Base64 输入面板 */
.input-panel {
  flex: 0 0 40%;
  min-width: 300px;
}

.input-textarea {
  flex: 1;
  padding: 10px 12px;
  margin: 0;
  resize: none;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  margin: 8px;
  background: #fff;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  min-height: 0;
  color: #334155;
  outline: none;
  transition: all 0.2s ease;
}

.input-textarea::placeholder {
  color: #94a3b8;
}

.input-textarea:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

[data-dt-dark] .input-textarea {
  background: var(--dt-dark-base);
  color: #f0f6fc;
  border-color: var(--dt-dark-border);
}

[data-dt-dark] .input-textarea::placeholder {
  color: #484f58;
}

[data-dt-dark] .input-textarea:focus {
  border-color: #818cf8;
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.15);
}

/* 预览面板 */
.preview-panel {
  flex: 1;
  min-width: 0;
}

.preview-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  min-height: 0;
}

.preview-img-large {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
</style>
