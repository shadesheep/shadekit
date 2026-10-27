import { ErrorCodes, type ErrorCode } from "./utils/error-codes";

export interface LoginRecovery {
  message?: string;
  retry: boolean;
  manualLocate: boolean;
}

/** 失败分类只决定恢复动作，不覆盖验证码、网络或成功条件的专属诊断。 */
export function loginRecoveryFor(errorCode?: ErrorCode): LoginRecovery {
  switch (errorCode) {
    case ErrorCodes.LOGIN_FORM_NOT_FOUND:
      return {
        message: "未找到可用的登录表单。请确认页面已打开并完成加载后重试。",
        retry: true,
        manualLocate: true,
      };
    case ErrorCodes.LOGIN_FORM_INCOMPLETE:
      return { message: "未找到完整登录表单，请手动定位或检查页面。", retry: true, manualLocate: true };
    case ErrorCodes.LOGIN_FORM_AMBIGUOUS:
      return { message: "检测到多个候选，无法确定登录表单，请手动定位。", retry: true, manualLocate: true };
    case ErrorCodes.ELEMENT_NOT_FOUND:
    case ErrorCodes.AMBIGUOUS_TARGET:
    case ErrorCodes.FRAME_NOT_FOUND:
    case ErrorCodes.SELECTOR_INVALID:
      return { retry: true, manualLocate: true };
    default:
      return { retry: true, manualLocate: false };
  }
}
