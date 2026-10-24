<script setup lang="ts">
import DtButton from '../../shared/components/DtButton.vue';
import DtConfigActions from '../../shared/config/DtConfigActions.vue';
import DtConfigHeader from '../../shared/config/DtConfigHeader.vue';
import DtConfigItem from '../../shared/config/DtConfigItem.vue';
import DtNumberField from '../../shared/config/DtNumberField.vue';
import DtSegmented from '../../shared/config/DtSegmented.vue';
import DtToggle from '../../shared/config/DtToggle.vue';
import { useToolConfig } from '../../shared/config/use-tool-config';
import type { OutputFormat } from './lib/types';

/** 本页编辑的设置项(MockDataConfig 的子集,全部必填;fields/tableName 由工具页维护) */
interface MockDataPageConfig {
  count: number;
  format: OutputFormat;
  viewMode: 'card' | 'table' | 'code';
  quickCount: number;
  tablePreviewLimit: number;
  autoGenerate: boolean;
  allowMultiple: boolean;
}

const DEFAULTS: MockDataPageConfig = {
  count: 10,
  format: 'json',
  viewMode: 'card',
  quickCount: 6,
  tablePreviewLimit: 200,
  autoGenerate: true,
  allowMultiple: false,
};

// fields 由工具页自己维护,omit 剔除后本页的增量保存永不触碰它;
// tableName 不剔除——随 ref 加载并在 replace(清空字段)时保留,与旧行为一致
const { config, saveState, replace } = useToolConfig<MockDataPageConfig>(
  'mock-data',
  DEFAULTS,
  {
    omit: ['fields'],
    normalize: (c) => {
      c.count = Math.min(Math.max(Math.trunc(c.count) || 10, 1), 1000);
    },
  },
);

const FORMAT_OPTIONS: Array<{ value: OutputFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'jsonl', label: 'JSONL' },
  { value: 'csv', label: 'CSV' },
  { value: 'sql', label: 'SQL' },
  { value: 'xml', label: 'XML' },
];

const VIEW_OPTIONS: Array<{
  value: 'card' | 'table' | 'code';
  label: string;
}> = [
  { value: 'card', label: '卡片' },
  { value: 'table', label: '表格' },
  { value: 'code', label: '源码' },
];

const QUICK_COUNT_OPTIONS = [
  { value: 3, label: '3 条' },
  { value: 6, label: '6 条' },
  { value: 10, label: '10 条' },
];

const PREVIEW_LIMIT_OPTIONS = [
  { value: 100, label: '100 条' },
  { value: 200, label: '200 条' },
  { value: 500, label: '500 条' },
];

/** 清空工具页持久化的字段列表(整体覆盖写,下次打开恢复初始示例模板) */
async function resetFields() {
  await replace('已清空字段列表,下次打开工具页生效');
}
</script>

<template>
  <div class="mock-data-config">
    <DtConfigHeader title="模拟数据设置" :save-state="saveState" />

    <DtConfigItem label="默认生成条数" hint="工具页每次生成的记录条数(1-1000)">
      <DtNumberField v-model="config.count" :min="1" :max="1000" />
    </DtConfigItem>

    <DtConfigItem
      label="默认输出格式"
      hint="「源码」视图的输出格式,也决定下载文件的类型"
    >
      <DtSegmented v-model="config.format" :options="FORMAT_OPTIONS" />
    </DtConfigItem>

    <DtConfigItem
      label="默认结果视图"
      hint="卡片视图逐条展示、点击复制,适合测试人员;源码视图为 JSON/CSV 等原文"
    >
      <DtSegmented v-model="config.viewMode" :options="VIEW_OPTIONS" />
    </DtConfigItem>

    <DtConfigItem
      label="快速取数候选条数"
      hint="「快速取数」模式每次生成的候选值数量"
    >
      <DtSegmented v-model="config.quickCount" :options="QUICK_COUNT_OPTIONS" />
    </DtConfigItem>

    <DtConfigItem
      label="表格预览上限"
      hint="「表格」视图最多预览的记录条数,完整数据可切换源码视图或下载"
    >
      <DtSegmented
        v-model="config.tablePreviewLimit"
        :options="PREVIEW_LIMIT_OPTIONS"
      />
    </DtConfigItem>

    <DtConfigItem
      label="字段变化后自动生成"
      hint="关闭后需点击「生成」或按 Ctrl+↵ 手动生成"
    >
      <DtToggle v-model="config.autoGenerate" />
    </DtConfigItem>

    <DtConfigItem
      label="允许多开"
      hint="每次点击都打开新标签页(关闭后聚焦已有标签页)"
    >
      <DtToggle v-model="config.allowMultiple" />
    </DtConfigItem>

    <DtConfigItem
      label="工作状态"
      hint="字段列表、条数、格式等会在工具页内自动保存;清空字段后下次打开恢复为初始示例模板"
    >
      <DtConfigActions>
        <DtButton @click="resetFields">清空已保存的字段列表</DtButton>
      </DtConfigActions>
    </DtConfigItem>
  </div>
</template>

<style scoped>
.mock-data-config {
  padding: 8px 0;
  color: #0f172a;
}

[data-dt-dark] .mock-data-config {
  color: #c9d1d9;
}
</style>
