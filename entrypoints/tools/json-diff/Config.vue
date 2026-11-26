<script setup lang="ts">
import DtConfigSection from '../../shared/config/DtConfigSection.vue';
import DtConfigHeader from '../../shared/config/DtConfigHeader.vue';
import DtConfigItem from '../../shared/config/DtConfigItem.vue';
import DtNumberField from '../../shared/config/DtNumberField.vue';
import DtToggle from '../../shared/config/DtToggle.vue';
import { useToolConfig } from '../../shared/config/use-tool-config';

interface JsonDiffConfig {
  autoCompare: boolean;
  debounceMs: number;
  allowMultiple: boolean;
}

const DEFAULTS: JsonDiffConfig = {
  autoCompare: true,
  debounceMs: 300,
  allowMultiple: false,
};

const { config, saveState } = useToolConfig<JsonDiffConfig>(
  'json-diff',
  DEFAULTS,
  {
    normalize: (c) => {
      c.debounceMs = Math.min(
        Math.max(Math.trunc(c.debounceMs) || 300, 100),
        2000,
      );
    },
  },
);
</script>

<template>
  <div class="dt-config-page">
    <DtConfigHeader
      title="JSON / 文本对比设置"
      description="调整对比触发时机与页面打开方式。"
      :save-state="saveState"
    />

    <DtConfigSection title="对比行为" icon="i-lucide-git-compare-arrows">
      <DtConfigItem label="自动对比" hint="编辑内容时自动执行对比">
        <DtToggle v-model="config.autoCompare" />
      </DtConfigItem>
      <DtConfigItem label="防抖延迟(毫秒)" hint="输入后等待该时长再执行对比">
        <DtNumberField
          v-model="config.debounceMs"
          :min="100"
          :max="2000"
          :step="100"
          :width="80"
        />
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
