<script setup lang="ts">
import { computed, ref } from "vue";
import DtButton from "../../shared/components/DtButton.vue";
import DtDrawer from "../../shared/components/DtDrawer.vue";
import DtFilePicker from "../../shared/components/DtFilePicker.vue";
import { parseSchemaImport } from "../../tools/mock-data/lib/schema-import";
import type { MockField } from "../../tools/mock-data/lib/types";

defineProps<{ show: boolean }>();

const emit = defineEmits<{
  close: [];
  import: [fields: MockField[]];
}>();

const text = ref("");
const errorText = ref("");

const canImport = computed(() => !!text.value.trim());

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function importFields() {
  errorText.value = "";
  try {
    const fields = parseSchemaImport(text.value);
    if (!fields.length) throw new Error("未识别到可生成的字段");
    emit("import", fields);
    text.value = "";
  } catch (error) {
    errorText.value = `导入失败：${errorMessage(error)}`;
  }
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
        Schema，导入即可自动生成对应字段。已有字段会被替换，并切换到「全部」场景。
      </p>

      <textarea
        v-model="text"
        class="import-text"
        rows="10"
        placeholder='例如 {"name":"张三","age":28}'
      />

      <DtFilePicker
        accept=".json,application/json"
        label="选择 JSON 文件"
        placeholder="仅填充文本，不自动导入"
        @select="loadFile"
      />

      <p v-if="errorText" class="import-error" role="alert">
        {{ errorText }}
      </p>

      <div class="import-actions">
        <DtButton variant="primary" :disabled="!canImport" @click="importFields">
          导入并替换字段
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

.import-actions {
  display: flex;
  justify-content: flex-end;
}

[data-dt-dark] .import-desc {
  color: #8b949e;
}

[data-dt-dark] .import-text {
  border-color: #30363d;
  background: #0f172a;
  color: #c9d1d9;
}

[data-dt-dark] .import-text::placeholder {
  color: #6e7681;
}

[data-dt-dark] .import-error {
  background: #3b1d1d;
  color: #f87171;
}
</style>
