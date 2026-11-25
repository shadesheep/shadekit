<script setup lang="ts">
import DtConfigSection from '../../shared/config/DtConfigSection.vue';
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
  <div class="dt-config-page">
    <DtConfigHeader
      title="图片 Base64 设置"
      description="设置在线图片转换的默认格式与质量。"
      :save-state="saveState"
    />

    <DtConfigSection title="图片输出" icon="i-lucide-image">
      <DtConfigItem label="输出图片格式" hint="从在线 URL 转换时使用此格式">
        <DtSegmented v-model="config.imageFormat" :options="FORMAT_OPTIONS" />
      </DtConfigItem>
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
            aria-label="图片质量"
            :aria-valuetext="`${Math.round(config.imageQuality * 100)}%`"
          />
          <span class="quality-value">{{ Math.round(config.imageQuality * 100) }}%</span>
        </div>
      </DtConfigItem>
    </DtConfigSection>

    <DtConfigSection title="页面行为" icon="i-lucide-panels-top-left">
      <DtConfigItem
        label="允许多开"
        hint="每次点击都打开新标签页(关闭后聚焦已有标签页)"
      >
        <DtToggle v-model="config.allowMultiple" />
      </DtConfigItem>
    </DtConfigSection>
  </div>
</template>

<style scoped>
.quality-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.quality-slider {
  flex: 1;
  min-width: 0;
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
