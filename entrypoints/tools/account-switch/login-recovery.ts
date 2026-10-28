import { ErrorCodes, type ErrorCode } from "./utils/error-codes";
import { simpleSpecShape } from "./spec/editor";
import type { LoginSpec } from "./spec/types";

export interface LoginRecovery {
  message?: string;
  manualLocate: boolean;
  editEnvironment?: boolean;
}

/** 失败分类只决定恢复动作，不覆盖验证码、网络或成功条件的专属诊断。 */
export function loginRecoveryFor(
  errorCode?: ErrorCode,
  spec?: LoginSpec,
): LoginRecovery {
  switch (errorCode) {
    case ErrorCodes.LOGIN_FORM_NOT_FOUND:
      return {
        message: "未找到可用的登录表单。请确认页面已打开并完成加载后重试。",
        manualLocate: true,
      };
    case ErrorCodes.LOGIN_FORM_INCOMPLETE:
      return {
        message: "未找到完整登录表单，请手动定位或检查页面。",
        manualLocate: true,
      };
    case ErrorCodes.LOGIN_FORM_AMBIGUOUS:
      return {
        message: "检测到多个候选，无法确定登录表单，请手动定位。",
        manualLocate: true,
      };
    case ErrorCodes.ELEMENT_NOT_FOUND: {
      const shape = spec ? simpleSpecShape(spec) : null;
      if (shape && shape.gotoIndex === undefined) {
        return {
          message:
            "未找到登录表单元素，且当前环境未设置登录页地址。请编辑环境，填写登录页 URL 或调整表单定位。",
          manualLocate: true,
          editEnvironment: true,
        };
      }
      return { manualLocate: true };
    }
    case ErrorCodes.AMBIGUOUS_TARGET:
    case ErrorCodes.FRAME_NOT_FOUND:
    case ErrorCodes.SELECTOR_INVALID:
      return { manualLocate: true };
    default:
      return { manualLocate: false };
  }
}
