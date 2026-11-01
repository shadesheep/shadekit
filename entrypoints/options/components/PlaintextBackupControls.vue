<script setup lang="ts">
import { ref } from "vue";
import { sendBgMessage } from "../../shared/messages";
import type { BackupImportSummary } from "../../shared/security/backup-service";
import { showToast } from "../../shared/use-toast";

const emit = defineEmits<{ imported: [] }>();
const fileInput = ref<HTMLInputElement | null>(null);
const mode = ref<"export" | "import" | null>(null);
const summary = ref<BackupImportSummary | null>(null);
const busy = ref(false);

function closeDialog(): void {
  if (busy.value) return;
  mode.value = null;
  summary.value = null;
}

function downloadBackup(backup: Record<string, unknown>): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `shadekit-config-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function prepareImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  busy.value = true;
  try {
    const text = await file.text();
    const response = await sendBgMessage("VAULT_PREPARE_BACKUP", { text });
    if (!response.success || !response.summary) {
      showToast(response.error || "明文备份预览失败", "error");
      return;
    }
    summary.value = response.summary;
    mode.value = "import";
  } catch (error) {
    showToast(error instanceof Error ? error.message : "备份文件读取失败", "error");
  } finally {
    busy.value = false;
  }
}

async function confirmOperation(): Promise<void> {
  if (busy.value || !mode.value) return;
  busy.value = true;
  try {
    if (mode.value === "export") {
      const response = await sendBgMessage("VAULT_EXPORT_BACKUP");
      if (!response.success || !response.backup) {
        showToast(response.error || "明文备份导出失败", "error");
        return;
      }
      downloadBackup(response.backup);
      showToast("完整明文备份已导出，请妥善保管", "success");
    } else {
      const response = await sendBgMessage("VAULT_CONFIRM_BACKUP", {
        acceptPlaintextWarning: true,
      });
      if (!response.success) {
        showToast(response.error || "明文备份导入失败", "error");
        return;
      }
      showToast(`完整备份已导入，${response.importedSecretCount ?? 0} 个秘密已迁入保险库`, "success");
      emit("imported");
    }
    mode.value = null;
    summary.value = null;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "备份操作失败", "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="header-actions">
    <button type="button" class="btn-import" title="预览并导入 shadekit-config 明文完整备份" @click="fileInput?.click()">
      <div class="i-lucide-download w-4 h-4" aria-hidden="true" />导入完整备份
    </button>
    <input ref="fileInput" type="file" accept=".json,application/json" class="hidden-file" @change="prepareImport" />
    <button type="button" class="btn-export" title="显式确认后导出包含秘密的明文完整备份" aria-describedby="export-backup-warning" @click="mode = 'export'">
      <div class="i-lucide-upload w-4 h-4" aria-hidden="true" />导出明文备份
    </button>
    <p id="export-backup-warning" class="export-warning">完整备份包含账号密码等明文秘密，仅用于受控迁移，请妥善保管。</p>
  </div>

  <div v-if="mode" class="backup-overlay" @mousedown.self="closeDialog">
    <form class="backup-dialog" role="dialog" aria-modal="true" :aria-label="mode === 'export' ? '导出完整明文备份' : '导入完整明文备份'" @submit.prevent="confirmOperation">
      <template v-if="mode === 'export'">
        <h3>确认导出明文完整备份</h3>
        <p>文件将包含账号密码、默认密码和秘密变量。任何获得文件的人都能直接读取这些秘密。</p>
        <p class="plaintext-warning">仅在可信环境保存和传输该文件；不再需要时请安全删除。</p>
      </template>
      <template v-else-if="summary">
        <h3>确认导入明文完整备份</h3>
        <p class="plaintext-warning">导入将覆盖下列工具的当前设置；文件中的秘密会重新加密到本机保险库。</p>
        <dl class="backup-summary">
          <div><dt>环境</dt><dd>{{ summary.environments.length }} 个环境</dd></div>
          <div><dt>账号</dt><dd>{{ summary.accounts }} 个账号</dd></div>
          <div><dt>策略</dt><dd>{{ summary.strategies }} 条策略</dd></div>
          <div><dt>秘密</dt><dd>{{ summary.secrets }} 个秘密</dd></div>
        </dl>
        <p class="overwrite-label">将覆盖：{{ summary.overwrittenTools.join('、') }}</p>
        <ul v-if="summary.environments.some((environment) => !environment.support.supported)" class="support-list">
          <li v-for="environment in summary.environments.filter((item) => !item.support.supported)" :key="environment.name">
            <strong>{{ environment.name }}</strong> 将保留但禁用：{{ environment.support.issues.map((issue) => issue.message).join('；') }}
          </li>
        </ul>
      </template>
      <div class="backup-actions">
        <button type="submit" data-backup-confirm class="btn-export" :disabled="busy">{{ busy ? '处理中…' : mode === 'export' ? '确认导出明文' : '确认覆盖并导入' }}</button>
        <button type="button" class="btn-import" :disabled="busy" @click="closeDialog">取消</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
@import '../../shared/component-styles.scss';
.header-actions { margin-left: auto; width: max-content; max-width: 100%; flex-wrap: wrap; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.export-warning { flex-basis: 100%; margin: 0; color: #64748b; font-size: 12px; line-height: 1.5; text-align: right; }
.btn-export, .btn-import { display: inline-flex; align-items: center; gap: 4px; padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all .2s ease-out; border: 1px solid #e2e8f0; background: #fff; color: #374151; }
.btn-export { background: rgba(99,102,241,.06); border-color: #c7d2fe; color: #6366f1; }
.btn-export:disabled, .btn-import:disabled { opacity: .55; cursor: not-allowed; }
.hidden-file { display: none; }
.backup-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: rgba(15,23,42,.45); backdrop-filter: blur(4px); }
.backup-dialog { width: min(460px, 100%); max-height: min(680px, 90vh); overflow-y: auto; box-sizing: border-box; padding: 22px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; box-shadow: 0 20px 50px rgba(15,23,42,.2); }
.backup-dialog h3 { margin: 0 0 8px; font-size: 17px; color: #0f172a; }
.backup-dialog p { margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: #64748b; }
.backup-dialog .plaintext-warning { color: #b45309; }
.backup-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 16px; }
.backup-summary div { padding: 10px; border: 1px solid #e2e8f0; border-radius: 8px; }
.backup-summary dt { color: #64748b; font-size: 12px; }
.backup-summary dd { margin: 4px 0 0; color: #0f172a; font-size: 14px; font-weight: 600; }
.backup-dialog .overwrite-label { margin-bottom: 10px; overflow-wrap: anywhere; }
.support-list { margin: 0; padding-left: 20px; color: #b45309; font-size: 12px; line-height: 1.6; }
.backup-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
[data-dt-dark] .export-warning { color: #8b949e; }
[data-dt-dark] .btn-import { background: #161b22; border-color: #30363d; color: #cbd5e1; }
[data-dt-dark] .btn-export { background: rgba(99,102,241,.12); border-color: #4f46e5; color: #a5b4fc; }
[data-dt-dark] .backup-dialog { background: #161b22; border-color: #30363d; }
[data-dt-dark] .backup-dialog h3, [data-dt-dark] .backup-summary dd { color: #f1f5f9; }
[data-dt-dark] .backup-dialog p, [data-dt-dark] .backup-summary dt { color: #8b949e; }
[data-dt-dark] .backup-dialog .plaintext-warning, [data-dt-dark] .support-list { color: #fbbf24; }
[data-dt-dark] .backup-summary div { border-color: #30363d; }
</style>
