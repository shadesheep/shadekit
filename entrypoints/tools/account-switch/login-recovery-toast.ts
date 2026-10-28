import { sendBgMessage } from "../../shared/messages";
import { showToast, type ToastAction } from "../../shared/use-toast";
import type { LoginSpec } from "./spec/types";
import { loginRecoveryFor } from "./login-recovery";
import {
  buildErrorDetail,
  copyToClipboard,
  ErrorCodes,
  type ErrorCode,
  type ErrorDetailContext,
} from "./utils/error-codes";

/** Config 与 content panel 共用的登录失败恢复动作；URL 只携带环境 key。 */
export function showLoginRecoveryToast(input: {
  prefix: string;
  error: string;
  errorCode?: ErrorCode;
  envKey?: string;
  spec?: LoginSpec;
  detail: ErrorDetailContext;
}): void {
  const code = input.errorCode ?? ErrorCodes.UNKNOWN;
  const recovery = loginRecoveryFor(input.errorCode, input.spec);
  const message = recovery.message ?? input.error;
  const actions: ToastAction[] = [];
  if (recovery.manualLocate && input.envKey) {
    actions.push({
      label: recovery.editEnvironment ? "编辑环境" : "手动定位",
      onClick: () => {
        void sendBgMessage("OPEN_ACCOUNT_ENVIRONMENT", {
          envKey: input.envKey!,
        })
          .then((result) => {
            if (!result.success)
              showToast(result.error ?? "无法打开环境编辑页", "error");
          })
          .catch((error: unknown) => {
            showToast(
              error instanceof Error ? error.message : String(error),
              "error",
            );
          });
      },
    });
  }
  actions.push({
    label: "复制详情",
    onClick: () => {
      const detail = buildErrorDetail(code, input.error, input.detail);
      void copyToClipboard(detail).then((ok) => {
        showToast(
          ok ? "错误详情已复制" : "复制失败，请查看控制台日志",
          ok ? "success" : "info",
        );
      });
    },
  });
  const prefix = recovery.message ? "未能自动登录" : input.prefix;
  showToast(`${prefix}：${message} [${code}]`, "error", 8000, actions);
}
