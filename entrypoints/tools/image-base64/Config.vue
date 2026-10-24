<script setup lang="ts">
import DtConfigHeader from '../../shared/config/DtConfigHeader.vue';
import DtConfigItem from '../../shared/config/DtConfigItem.vue';
import DtSegmented from '../../shared/config/DtSegmented.vue';
import DtToggle from '../../shared/config/DtToggle.vue';
import { useToolConfig } from '../../shared/config/use-tool-config';
import {
  DEFAULT_IMAGE_BASE64_CONFIG,
  type ImageBase64Config,
  type ImageOutputFormat,
} from './lib/convert-settings';

const { config, saveState } = useToolConfig<ImageBase64Config>(
  'image-base64',
  DEFAULT_IMAGE_BASE64_CONFIG,
  {
    // 边界钳制(App.vue 的 effectiveQuality 使用侧也有钳制,双保险)
    normalize: (c) => {
      if (!Number.isFinite(c.imageQuality)) {
        c.imageQuality = DEFAULT_IMAGE_BASE64_CONFIG.imageQuality;
      }
      c.imageQuality = Math.min(1, Math.max(0.1, c.imageQuality));
    },
  },
);

const FORMAT_OPTIONS: Array<{ value: ImageOutputFormat; label: string }> = [
  { value: 'jpeg', label: 'JPEG' },
  { value: 'png', label: 'PNG(无损)' },
  { value: 'webp', label: 'WebP' },
];
</script>

<template>
  <div class="image-base64-config">
    <DtConfigHeader title="图片 Base64 设置" :save-state="saveState" />

    <DtConfigItem label="输出图片格式" hint="从在线 URL 转换时使用此格式">
      <DtSegmented v-model="config.imageFormat" :options="FORMAT_OPTIONS" />
    </DtConfigItem>

    <!-- 质量滑杆为私货(Config Kit 无滑杆组件),放入 stack 项占满整行 -->
    <DtConfigItem
      label="图片质量"
      hint="仅对 JPEG / WebP 格式有效(PNG 为无损格式)"
      layout="stack"
    >
      <div class="quality-control">
        <input
          type="range"
          v-model.number="config.imageQuality"
          min="0.1"
          max="1"
          step="0.01"
          class="quality-slider"
        />
        <span class="quality-value">{{ Math.round(config.imageQuality * 100) }}%</span>
      </div>
    </DtConfigItem>

    <DtConfigItem
      label="允许多开"
      hint="每次点击都打开新标签页(关闭后聚焦已有标签页)"
    >
      <DtToggle v-model="config.allowMultiple" />
    </DtConfigItem>
  </div>
</template>

<style scoped>
.image-base64-config {
  padding: 8px 0;
  color: #0f172a;
}

[data-dt-dark] .image-base64-config {
  color: #c9d1d9;
}

.quality-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.quality-slider {
  flex: 1;
  accent-color: #6366f1;
}

.quality-value {
  font-size: 13px;
  font-weight: 600;
  color: #6366f1;
  min-width: 40px;
  text-align: right;
}

[data-dt-dark] .quality-value {
  color: #818cf8;
}
</style>
