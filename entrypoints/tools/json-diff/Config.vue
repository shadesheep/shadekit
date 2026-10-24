<script setup lang="ts">
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
  allowMultiple: true,
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
  <div class="json-diff-config">
    <DtConfigHeader title="JSON 对比设置" :save-state="saveState" />

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

    <DtConfigItem
      label="允许多开"
      hint="每次点击都打开新标签页(关闭后聚焦已有标签页)"
    >
      <DtToggle v-model="config.allowMultiple" />
    </DtConfigItem>
  </div>
</template>

<style scoped>
.json-diff-config {
  padding: 8px 0;
  color: #0f172a;
}

[data-dt-dark] .json-diff-config {
  color: #c9d1d9;
}
</style>
