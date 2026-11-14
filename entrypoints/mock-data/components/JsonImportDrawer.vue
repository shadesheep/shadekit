<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DtButton from "../../shared/components/DtButton.vue";
import DtDrawer from "../../shared/components/DtDrawer.vue";
import DtFilePicker from "../../shared/components/DtFilePicker.vue";
import {
  analyzeSchemaImport,
  type SchemaImportReport,
} from "../../tools/mock-data/lib/schema-import";
import type { MockField } from "../../tools/mock-data/lib/types";

defineProps<{ show: boolean }>();

const emit = defineEmits<{
  close: [];
  import: [fields: MockField[]];
}>();

const text = ref("");
const errorText = ref("");
const report = ref<SchemaImportReport | null>(null);

const canPreview = computed(() => !!text.value.trim());
const sourceLabel = computed(() =>
  report.value?.source === "schema" ? "JSON Schema" : "JSON 示例",
);

watch(text, () => {
  if (!report.value) return;
  report.value = null;
  errorText.value = "";
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewImport() {
  errorText.value = "";
  try {
    const next = analyzeSchemaImport(text.value);
    if (!next.fields.length) throw new Error("未识别到可生成的字段");
    report.value = next;
  } catch (error) {
    errorText.value = `导入失败：${errorMessage(error)}`;
  }
}

function confirmImport() {
  if (!report.value) return;
  emit("import", report.value.fields);
  report.value = null;
  text.value = "";
}

async function loadFile(file: File) {
  try {
    text.value = await file.text();
    errorText.value = "";
  } catch {
    errorText.value = "读取文件失败";
  }
}
</script>

<template>
  <DtDrawer :show="show" title="从 JSON 导入" @close="emit('close')">
    <div class="import-body">
      <p class="import-desc">
        粘贴一段 JSON 示例（如 <code>{"name":"张三"}</code>）或标准 JSON
        Schema，先预览识别出的字段与规则，确认后替换现有字段并切换到「全部」场景。
      </p>

      <textarea
        v-model="text"
        class="import-text"
        rows="10"
        :readonly="!!report"
        placeholder='例如 {"name":"张三","age":28}'
      />

      <DtFilePicker
        v-if="!report"
        accept=".json,application/json"
        label="选择 JSON 文件"
        placeholder="仅填充文本，不自动导入"
        @select="loadFile"
      />

      <p v-if="errorText" class="import-error" role="alert">
        {{ errorText }}
      </p>

      <section v-if="report" class="import-preview">
        <p class="preview-summary">
          {{ sourceLabel }} · 已识别 {{ report.recognized.length }} 个字段、{{
            report.recognized.reduce((total, item) => total + item.rules.length, 0)
          }}
          条规则
          <template v-if="report.pending.length">
            · {{ report.pending.length }} 个待处理项
          </template>
        </p>

        <ul class="preview-list">
          <li
            v-for="item in report.recognized"
            :key="item.path"
            class="preview-item"
          >
            <code class="preview-path">{{ item.path }}</code>
            <span class="preview-rules">{{ item.rules.join(" · ") }}</span>
          </li>
        </ul>

        <div v-if="report.pending.length" class="preview-pending">
          <p class="preview-pending-title">待手动配置的关键词或结构</p>
          <ul class="preview-list">
            <li
              v-for="(item, index) in report.pending"
              :key="`${item.path}-${item.keyword}-${index}`"
              class="preview-item pending-item"
            >
              <code class="preview-path">{{ item.path }}</code>
              <span class="pending-keyword">{{ item.keyword }}</span>
              <span class="preview-rules">{{ item.message }}</span>
            </li>
          </ul>
        </div>
      </section>

      <div class="import-actions">
        <DtButton
          v-if="report"
          variant="secondary"
          @click="report = null"
        >
          返回修改
        </DtButton>
        <DtButton
          v-if="!report"
          variant="primary"
          :disabled="!canPreview"
          @click="previewImport"
        >
          解析并预览
        </DtButton>
        <DtButton v-else variant="primary" @click="confirmImport">
          确认导入并替换字段
        </DtButton>
      </div>
    </div>
  </DtDrawer>
</template>

<style scoped>
.import-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.import-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #64748b;
}

.import-text {
  width: 100%;
  min-height: 180px;
  padding: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  color: #0f172a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s ease-out, box-shadow 0.15s ease-out;
}

.import-text:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.import-text[readonly] {
  background: #f8fafc;
  resize: none;
}

.import-text::placeholder {
  color: #94a3b8;
}

.import-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fef2f2;
  color: #dc2626;
  font-size: 12px;
}

.import-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.preview-summary {
  margin: 0;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
}

.preview-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.preview-item {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  line-height: 1.5;
}

.preview-path {
  color: #4338ca;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}

.preview-rules {
  color: #64748b;
}

.preview-pending {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed #cbd5e1;
}

.preview-pending-title {
  margin: 0;
  color: #b45309;
  font-size: 12px;
  font-weight: 600;
}

.pending-item {
  background: #fffbeb;
}

.pending-keyword {
  padding: 1px 6px;
  border-radius: 9999px;
  background: #fef3c7;
  color: #b45309;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

[data-dt-dark] .import-desc {
  color: #8b949e;
}

[data-dt-dark] .import-text {
  border-color: #30363d;
  background: #0f172a;
  color: #c9d1d9;
}

[data-dt-dark] .import-text[readonly] {
  background: #161b22;
}

[data-dt-dark] .import-text::placeholder {
  color: #6e7681;
}

[data-dt-dark] .import-error {
  background: #3b1d1d;
  color: #f87171;
}

[data-dt-dark] .import-preview {
  border-color: #30363d;
  background: #161b22;
}

[data-dt-dark] .preview-summary {
  color: #c9d1d9;
}

[data-dt-dark] .preview-item {
  background: #0f172a;
}

[data-dt-dark] .preview-path {
  color: #a5b4fc;
}

[data-dt-dark] .preview-rules {
  color: #8b949e;
}

[data-dt-dark] .preview-pending {
  border-top-color: #30363d;
}

[data-dt-dark] .preview-pending-title {
  color: #fbbf24;
}

[data-dt-dark] .pending-item {
  background: #2a2110;
}

[data-dt-dark] .pending-keyword {
  background: #422006;
  color: #fbbf24;
}
</style>