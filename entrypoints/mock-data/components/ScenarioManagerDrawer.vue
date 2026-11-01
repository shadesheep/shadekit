<script setup lang="ts">
import { computed, ref } from "vue";
import DtButton from "../../shared/components/DtButton.vue";
import DtDrawer from "../../shared/components/DtDrawer.vue";
import {
  buildDownloadName,
  downloadTextAsFile,
} from "../../shared/download";
import { showToast } from "../../shared/use-toast";
import type { MockTemplate } from "../../tools/mock-data/lib/templates";
import type { MockField } from "../../tools/mock-data/lib/types";
import {
  fieldsToTemplate,
  parseTemplateFile,
  serializeTemplateFile,
} from "../../tools/mock-data/lib/template-files";

const props = withDefaults(
  defineProps<{
    show: boolean;
    templates: MockTemplate[];
    customTemplates: MockTemplate[];
    fields: MockField[];
    hasFieldErrors?: boolean;
  }>(),
  { hasFieldErrors: false },
);

const emit = defineEmits<{
  close: [];
  save: [template: MockTemplate];
  import: [template: MockTemplate];
  delete: [id: string];
}>();

const scenarioName = ref("");

const canSave = computed(
  () =>
    !!scenarioName.value.trim() &&
    props.fields.length > 0 &&
    !props.hasFieldErrors,
);

const saveHint = computed(() => {
  if (!props.fields.length) return "当前没有字段，无法保存场景";
  if (props.hasFieldErrors) return "字段存在错误，请先修正后再保存";
  return "";
});

function saveCurrent() {
  if (!canSave.value) return;
  emit(
    "save",
    fieldsToTemplate(props.fields, scenarioName.value.trim(), "自定义场景"),
  );
  scenarioName.value = "";
}

function exportTemplate(template: MockTemplate) {
  downloadTextAsFile(
    serializeTemplateFile(template),
    buildDownloadName(`mock-template-${template.name}`, "json"),
  );
  showToast(`已导出场景「${template.name}」`, "success");
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const template = parseTemplateFile(await file.text());
    emit("import", template);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`场景导入失败：${message}`, "error");
  } finally {
    input.value = "";
  }
}
</script>

<template>
  <DtDrawer :show="show" title="管理场景" @close="emit('close')">
    <section class="scenario-section">
      <h4>内置场景</h4>
      <ul class="scenario-list">
        <li
          v-for="template in templates"
          :key="template.id"
          class="scenario-item"
        >
          <div class="scenario-info">
            <span class="scenario-item-name">{{ template.name }}</span>
            <span v-if="template.hint" class="scenario-item-hint">{{
              template.hint
            }}</span>
          </div>
          <span class="scenario-item-count"
            >{{ template.rows.length }} 个字段</span
          >
        </li>
      </ul>
    </section>

    <section class="scenario-section">
      <h4>自定义场景</h4>
      <ul v-if="customTemplates.length" class="scenario-list">
        <li
          v-for="template in customTemplates"
          :key="template.id"
          class="scenario-item"
        >
          <div class="scenario-info">
            <span class="scenario-item-name">{{ template.name }}</span>
            <span class="scenario-item-count"
              >{{ template.rows.length }} 个字段</span
            >
          </div>
          <div class="scenario-actions">
            <DtButton size="sm" @click="exportTemplate(template)"
              >导出</DtButton
            >
            <DtButton
              size="sm"
              variant="danger"
              @click="emit('delete', template.id)"
              >删除</DtButton
            >
          </div>
        </li>
      </ul>
      <p v-else class="scenario-empty">还没有自定义场景</p>

      <div class="scenario-save">
        <input
          v-model="scenarioName"
          class="scenario-name"
          type="text"
          placeholder="场景名称"
        />
        <DtButton
          variant="primary"
          size="sm"
          :disabled="!canSave"
          @click="saveCurrent"
          >保存为场景</DtButton
        >
      </div>
      <p v-if="saveHint" class="scenario-save-hint">{{ saveHint }}</p>
    </section>

    <section class="scenario-section">
      <h4>导入场景文件</h4>
      <label class="scenario-import">
        <input
          class="scenario-file"
          type="file"
          accept=".json,application/json"
          @change="importFile"
        />
        <span>选择 .json 场景文件</span>
      </label>
    </section>
  </DtDrawer>
</template>

<style scoped>
.scenario-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 18px;
}

.scenario-section + .scenario-section {
  padding-top: 16px;
  border-top: 1px solid #e2e8f0;
}

.scenario-section h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: #0f172a;
}

.scenario-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.scenario-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}

.scenario-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.scenario-item-name {
  font-size: 13px;
  font-weight: 500;
  color: #0f172a;
}

.scenario-item-hint {
  font-size: 11px;
  color: #94a3b8;
}

.scenario-item-count {
  font-size: 11px;
  color: #64748b;
  white-space: nowrap;
}

.scenario-actions {
  display: flex;
  gap: 6px;
}

.scenario-empty {
  margin: 0;
  font-size: 12px;
  color: #94a3b8;
}

.scenario-save {
  display: flex;
  gap: 8px;
  padding-top: 4px;
}

.scenario-name {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s ease-out, box-shadow 0.15s ease-out;
}

.scenario-name:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.scenario-save-hint {
  margin: 0;
  font-size: 11px;
  color: #94a3b8;
}

.scenario-import {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #64748b;
}

.scenario-file {
  font-size: 12px;
}

[data-dt-dark] .scenario-section + .scenario-section {
  border-top-color: #30363d;
}

[data-dt-dark] .scenario-section h4 {
  color: #c9d1d9;
}

[data-dt-dark] .scenario-item {
  border-color: #30363d;
  background: #161b22;
}

[data-dt-dark] .scenario-item-name {
  color: #c9d1d9;
}

[data-dt-dark] .scenario-item-hint,
[data-dt-dark] .scenario-empty,
[data-dt-dark] .scenario-save-hint {
  color: #6e7681;
}

[data-dt-dark] .scenario-item-count,
[data-dt-dark] .scenario-import {
  color: #8b949e;
}

[data-dt-dark] .scenario-name {
  border-color: #30363d;
  background: #0f172a;
  color: #c9d1d9;
}

[data-dt-dark] .scenario-name::placeholder {
  color: #6e7681;
}
</style>
