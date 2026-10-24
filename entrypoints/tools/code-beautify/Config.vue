<script setup lang="ts">
import DtConfigHeader from '../../shared/config/DtConfigHeader.vue';
import DtConfigItem from '../../shared/config/DtConfigItem.vue';
import DtSegmented from '../../shared/config/DtSegmented.vue';
import DtToggle from '../../shared/config/DtToggle.vue';
import { useToolConfig } from '../../shared/config/use-tool-config';

interface CodeBeautifyConfig {
  indentSize: number;
  showLineNumbers: boolean;
  allowMultiple: boolean;
}

const DEFAULTS: CodeBeautifyConfig = {
  indentSize: 4,
  showLineNumbers: true,
  allowMultiple: true,
};

const { config, saveState } = useToolConfig<CodeBeautifyConfig>(
  'code-beautify',
  DEFAULTS,
);

const INDENT_OPTIONS = [
  { value: 2, label: '2 空格' },
  { value: 4, label: '4 空格' },
];
</script>

<template>
  <div class="code-beautify-config">
    <DtConfigHeader title="代码美化设置" :save-state="saveState" />

    <DtConfigItem label="缩进空格数">
      <DtSegmented v-model="config.indentSize" :options="INDENT_OPTIONS" />
    </DtConfigItem>

    <DtConfigItem label="显示行号" hint="格式化结果左侧显示行号">
      <DtToggle v-model="config.showLineNumbers" />
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
.code-beautify-config {
  padding: 8px 0;
  color: #0f172a;
}

[data-dt-dark] .code-beautify-config {
  color: #c9d1d9;
}
</style>
