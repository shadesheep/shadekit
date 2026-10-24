<script setup lang="ts">
import DtConfigHeader from '../../shared/config/DtConfigHeader.vue';
import DtConfigItem from '../../shared/config/DtConfigItem.vue';
import DtSegmented from '../../shared/config/DtSegmented.vue';
import DtToggle from '../../shared/config/DtToggle.vue';
import { useToolConfig } from '../../shared/config/use-tool-config';

interface JsonFormatConfig {
  indent: number;
  nestedEscapeParse: boolean;
  autoDecode: boolean;
  jsonLint: boolean;
  allowMultiple: boolean;
  autoParseJson: boolean;
}

const DEFAULTS: JsonFormatConfig = {
  indent: 2,
  nestedEscapeParse: true,
  autoDecode: false,
  jsonLint: true,
  allowMultiple: true,
  autoParseJson: true,
};

const { config, saveState } = useToolConfig<JsonFormatConfig>(
  'json-formatter',
  DEFAULTS,
);

const INDENT_OPTIONS = [
  { value: 2, label: '2 空格' },
  { value: 4, label: '4 空格' },
];
</script>

<template>
  <div class="json-format-config">
    <DtConfigHeader title="JSON 格式化设置" :save-state="saveState" />

    <DtConfigItem label="缩进空格数">
      <DtSegmented v-model="config.indent" :options="INDENT_OPTIONS" />
    </DtConfigItem>

    <DtConfigItem
      label="嵌套转义解析"
      hint="当字符串值为 JSON 时,自动格式化展示"
    >
      <DtToggle v-model="config.nestedEscapeParse" />
    </DtConfigItem>

    <DtConfigItem
      label="自动解码"
      hint="自动识别并解码 Unicode/URL 编码"
    >
      <DtToggle v-model="config.autoDecode" />
    </DtConfigItem>

    <DtConfigItem label="JSONLint 校验" hint="格式化时自动校验 JSON 合法性">
      <DtToggle v-model="config.jsonLint" />
    </DtConfigItem>

    <DtConfigItem
      label="允许多开"
      hint="每次点击都打开新标签页(关闭后聚焦已有标签页)"
    >
      <DtToggle v-model="config.allowMultiple" />
    </DtConfigItem>

    <DtConfigItem
      label="页面自动解析 JSON"
      hint="访问返回 JSON 的 API URL 时,自动格式化为可折叠树"
    >
      <DtToggle v-model="config.autoParseJson" />
    </DtConfigItem>
  </div>
</template>

<style scoped>
.json-format-config {
  padding: 8px 0;
  color: #0f172a;
}

[data-dt-dark] .json-format-config {
  color: #c9d1d9;
}
</style>
