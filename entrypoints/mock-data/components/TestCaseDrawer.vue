<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { copyToClipboard } from "../../shared/clipboard";
import DtButton from "../../shared/components/DtButton.vue";
import DtDrawer from "../../shared/components/DtDrawer.vue";
import DtSelect from "../../shared/components/DtSelect.vue";
import { buildDownloadName, downloadTextAsFile } from "../../shared/download";
import { showToast } from "../../shared/use-toast";
import { inputRuleSummary } from "../../tools/mock-data/lib/invalid-cases";
import type {
  TestCase,
  TestCaseSet,
} from "../../tools/mock-data/lib/test-cases";
import { serializeTestCaseSet } from "../../tools/mock-data/lib/test-cases";

const props = defineProps<{
  show: boolean;
  caseSet: TestCaseSet | null;
}>();
const emit = defineEmits<{ close: [] }>();

const fieldFilter = ref("all");

watch(
  () => props.show,
  (show) => {
    if (show) fieldFilter.value = "all";
  },
);
const inferredCount = computed(
  () =>
    (props.caseSet?.cases ?? []).filter((item) => item.source === "inferred")
      .length,
);
const issuesAreInfo = computed(() =>
  (props.caseSet?.issues ?? []).every((issue) => issue.level === "info"),
);

const fieldOptions = computed(() => [
  { value: "all", label: "全部字段" },
  ...(props.caseSet?.targets ?? []).map((target) => {
    const suffix = target.source === "inferred" ? "（推导）" : "";
    const label =
      target.kind === "date"
        ? `日期比较：${target.fieldLabel} (${target.path})`
        : target.kind === "length"
          ? `长度：${target.label} (${target.path})`
          : target.kind === "input"
            ? `请求校验：${target.label} (${target.path})`
            : `${target.label} (${target.path})`;
    return { value: target.path, label: `${label}${suffix}` };
  }),
]);

const visibleCases = computed(() =>
  (props.caseSet?.cases ?? []).filter(
    (item) =>
      fieldFilter.value === "all" || item.fieldPath === fieldFilter.value,
  ),
);

const DATE_PRECISION_LABELS = {
  day: "天",
  hour: "小时",
  minute: "分钟",
  second: "秒",
} as const;
const DATE_DIRECTION_LABELS = {
  after: "严格晚于",
  before: "严格早于",
  notBefore: "不早于",
  notAfter: "不晚于",
} as const;

function ruleText(item: TestCase): string {
  const suffix = item.source === "inferred" ? "（取样推导）" : "";
  if (item.kind === "date") {
    return `${DATE_DIRECTION_LABELS[item.rule.direction]} ${item.rule.referenceLabel}（${item.rule.referenceKey}）· 精度 ${DATE_PRECISION_LABELS[item.rule.precision]}`;
  }
  if (item.kind === "length") {
    const unit = item.rule.unit === "array" ? "元素数" : "字符数";
    if (item.rule.min !== undefined && item.rule.max !== undefined) {
      return `${item.rule.min} ≤ ${unit} ≤ ${item.rule.max}${suffix}`;
    }
    if (item.rule.min !== undefined)
      return `${unit} ≥ ${item.rule.min}${suffix}`;
    if (item.rule.max !== undefined)
      return `${unit} ≤ ${item.rule.max}${suffix}`;
    return unit;
  }
  if (item.kind === "input") {
    return `${inputRuleSummary(item.rule)}${
      item.source === "inferred" ? "（按字段类型推导）" : ""
    }`;
  }
  const precision = `精度 ${item.rule.precision}`;
  if (item.rule.min !== undefined && item.rule.max !== undefined) {
    return `${item.rule.min} ≤ 值 ≤ ${item.rule.max}（${precision}）${suffix}`;
  }
  if (item.rule.min !== undefined) {
    return `值 ≥ ${item.rule.min}（${precision}）${suffix}`;
  }
  if (item.rule.max !== undefined) {
    return `值 ≤ ${item.rule.max}（${precision}）${suffix}`;
  }
  return precision;
}

function caseValueText(item: TestCase): string {
  if (item.kind === "input") {
    if (!item.present) return "（属性缺失）";
    return JSON.stringify(item.value) ?? String(item.value);
  }
  if (item.kind === "length") {
    return `${item.value} 个${item.rule.unit === "array" ? "元素" : "字符"}`;
  }
  return String(item.value);
}

async function copyRequest(item: TestCase) {
  const ok = await copyToClipboard(JSON.stringify(item.request, null, 2));
  showToast(
    ok ? `已复制用例 ${item.id} 的请求 JSON` : "复制失败",
    ok ? "success" : "error",
  );
}

function downloadSet() {
  if (!props.caseSet?.cases.length) return;
  downloadTextAsFile(
    serializeTestCaseSet(props.caseSet),
    buildDownloadName("mock-test-cases", "json"),
  );
  showToast(`已导出 ${props.caseSet.cases.length} 条测试用例`, "success");
}
</script>

<template>
  <DtDrawer :show="show" title="测试用例" @close="emit('close')">
    <template v-if="caseSet">
      <div class="case-meta">
        <span class="case-count">{{ caseSet.summary.total }} 条用例</span>
        <span class="case-pass">{{ caseSet.summary.pass }} 预期通过</span>
        <span class="case-reject">{{ caseSet.summary.reject }} 预期拒绝</span>
        <span class="case-seed">Seed：<code>{{ caseSet.seed }}</code></span>
        <span class="case-seed">
          基准日：<code>{{ caseSet.generation.referenceTime }}</code>（{{
            caseSet.generation.timeZone
          }}）
        </span>
      </div>

      <div v-if="inferredCount" class="case-note" role="status">
        <div class="i-lucide-info w-3.5 h-3.5" />
        <span
          >{{ inferredCount }} 条用例按字段取样范围/类型推导（未配置校验规则）；预期结果仅依据当前字段配置，请以服务端校验为准。</span
        >
      </div>

      <div
        v-if="caseSet.issues.length"
        class="case-issues"
        :class="{ 'case-issues-info': issuesAreInfo }"
        :role="issuesAreInfo ? 'status' : 'alert'"
      >
        <div
          :class="issuesAreInfo ? 'i-lucide-info' : 'i-lucide-triangle-alert'"
          class="w-4 h-4"
        />
        <ul>
          <li v-for="(issue, index) in caseSet.issues" :key="index">
            <span v-if="issue.path">{{ issue.path }}：</span>{{ issue.message }}
          </li>
        </ul>
      </div>

      <template v-if="caseSet.cases.length">
        <div class="case-filter">
          <span class="case-filter-label">按字段筛选</span>
          <DtSelect
            v-model="fieldFilter"
            :options="fieldOptions"
            size="sm"
            aria-label="按字段筛选测试用例"
          />
          <span class="case-filter-count">{{ visibleCases.length }} / {{ caseSet.cases.length }} 条</span>
        </div>

        <div v-if="!visibleCases.length" class="case-empty">该字段没有测试用例</div>

        <ul class="case-list">
          <li v-for="item in visibleCases" :key="item.id" class="case-item">
            <div class="case-head">
              <span class="case-id">{{ item.id }}</span>
              <span
                class="case-expect"
                :class="item.expected === 'pass' ? 'expect-pass' : 'expect-reject'"
              >
                {{ item.expected === "pass" ? "预期通过" : "预期拒绝" }}
              </span>
              <span class="case-coverage">{{ item.coverage }}</span>
              <span
                v-if="item.source === 'inferred'"
                class="case-source"
                title="未配置校验规则，按字段取样范围/类型推导"
                >推导</span
              >
              <DtButton size="xs" @click="copyRequest(item)">
                <div class="i-lucide-copy w-3 h-3" />
                复制请求 JSON
              </DtButton>
            </div>
            <div class="case-line">
              <span class="case-label">目标字段</span>
              <span>{{ item.fieldLabel }} · <code>{{ item.fieldPath }}</code></span>
            </div>
            <div class="case-line">
              <span class="case-label">规则</span>
              <span>{{ ruleText(item) }}</span>
            </div>
            <div class="case-line">
              <span class="case-label">
                {{
                  item.kind === "length"
                    ? "目标长度"
                    : item.kind === "input" && !item.present
                      ? "属性"
                      : "目标值"
                }}
              </span>
              <code class="case-value">{{ caseValueText(item) }}</code>
            </div>
            <div v-if="item.kind === 'date'" class="case-line">
              <span class="case-label">参照值</span>
              <code>{{ item.rule.referenceValue }}</code>
            </div>
            <div class="case-reason">{{ item.reason }}</div>
            <details class="case-request">
              <summary>请求 JSON</summary>
              <pre>{{ JSON.stringify(item.request, null, 2) }}</pre>
            </details>
          </li>
        </ul>
      </template>
      <div v-else class="case-empty">没有可生成或推导的测试用例</div>
    </template>

    <template #footer>
      <DtButton
        variant="primary"
        :disabled="!caseSet?.cases.length"
        @click="downloadSet"
      >
        <div class="i-lucide-download w-3.5 h-3.5" />
        下载整套用例
      </DtButton>
    </template>
  </DtDrawer>
</template>

<style scoped>
.case-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 0 0 10px;
  color: #475569;
  font-size: 12px;
}

.case-count {
  font-weight: 600;
  color: #0f172a;
}

.case-pass {
  color: #16a34a;
}

.case-reject {
  color: #dc2626;
}

.case-seed {
  color: #64748b;
}

.case-seed code,
.case-line code {
  padding: 1px 4px;
  border-radius: 4px;
  background: #f1f5f9;
  font-size: 11px;
}

.case-issues {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #fecaca;
  border-radius: 8px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 12px;
}

.case-issues ul {
  margin: 0;
  padding-left: 16px;
}

.case-issues-info {
  border-color: #c7d2fe;
  background: #eef2ff;
  color: #4338ca;
}

.case-note {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  background: #eef2ff;
  color: #4338ca;
  font-size: 12px;
  line-height: 1.5;
}

.case-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 0 12px;
  font-size: 12px;
}

.case-filter-label {
  color: #64748b;
}

.case-filter-count {
  margin-left: auto;
  color: #94a3b8;
}

.case-empty {
  padding: 24px 0;
  color: #94a3b8;
  font-size: 12px;
  text-align: center;
}

.case-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.case-item {
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}

.case-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.case-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #64748b;
}

.case-expect {
  padding: 1px 7px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
}

.expect-pass {
  background: #dcfce7;
  color: #15803d;
}

.expect-reject {
  background: #fee2e2;
  color: #b91c1c;
}

.case-coverage {
  color: #6366f1;
  font-size: 11px;
}

.case-source {
  padding: 1px 6px;
  border-radius: 9999px;
  background: #fef3c7;
  color: #b45309;
  font-size: 11px;
}

.case-head :deep(.dt-button) {
  margin-left: auto;
}

.case-line {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  color: #334155;
  font-size: 12px;
}

.case-label {
  flex: 0 0 56px;
  color: #94a3b8;
}

.case-value {
  font-weight: 600;
}

.case-reason {
  margin-top: 4px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.case-request {
  margin-top: 6px;
  color: #64748b;
  font-size: 11px;
}

.case-request summary {
  cursor: pointer;
}

.case-request pre {
  max-height: 220px;
  margin: 6px 0 0;
  padding: 8px;
  overflow: auto;
  border-radius: 6px;
  background: #f8fafc;
  font-size: 11px;
  line-height: 1.5;
}

[data-dt-dark] .case-meta,
[data-dt-dark] .case-line {
  color: #c9d1d9;
}

[data-dt-dark] .case-count {
  color: #f1f5f9;
}

[data-dt-dark] .case-item {
  border-color: var(--dt-dark-border);
  background: var(--dt-dark-surface);
}

[data-dt-dark] .case-seed code,
[data-dt-dark] .case-line code {
  background: var(--dt-dark-surface-hover);
}

[data-dt-dark] .case-issues {
  border-color: #7f1d1d;
  background: rgba(220, 38, 38, 0.12);
  color: #f87171;
}

[data-dt-dark] .case-issues-info {
  border-color: #4338ca;
  background: rgba(99, 102, 241, 0.15);
  color: #a5b4fc;
}

[data-dt-dark] .case-request pre {
  background: var(--dt-dark-surface-hover);
}

[data-dt-dark] .expect-pass {
  background: rgba(22, 163, 74, 0.18);
  color: #4ade80;
}

[data-dt-dark] .expect-reject {
  background: rgba(220, 38, 38, 0.18);
  color: #f87171;
}

[data-dt-dark] .case-note {
  border-color: #4338ca;
  background: rgba(99, 102, 241, 0.15);
  color: #a5b4fc;
}

[data-dt-dark] .case-source {
  background: rgba(180, 83, 9, 0.22);
  color: #fbbf24;
}
</style>
