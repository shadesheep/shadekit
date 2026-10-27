import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginRecoveryFor } from "../entrypoints/tools/account-switch/login-recovery";
import { showLoginRecoveryToast } from "../entrypoints/tools/account-switch/login-recovery-toast";
import { ErrorCodes } from "../entrypoints/tools/account-switch/utils/error-codes";
import { defaultLoginSpec } from "../entrypoints/tools/account-switch/spec/editor";
import { dismissToast, useToast } from "../entrypoints/shared/use-toast";

const sendMessage = vi.fn();
vi.stubGlobal("chrome", { runtime: { sendMessage } });

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ success: true });
});

afterEach(() => {
  for (const toast of useToast().toasts.value) dismissToast(toast.id);
});

describe("loginRecoveryFor", () => {
  it("classifies automatic form failures with actionable primary messages", () => {
    expect(loginRecoveryFor(ErrorCodes.LOGIN_FORM_NOT_FOUND)).toEqual({
      message: "未找到可用的登录表单。请确认页面已打开并完成加载后重试。",
      retry: true,
      manualLocate: true,
    });
    expect(
      loginRecoveryFor(ErrorCodes.LOGIN_FORM_INCOMPLETE).message,
    ).toContain("未找到完整登录表单");
    expect(loginRecoveryFor(ErrorCodes.LOGIN_FORM_AMBIGUOUS).message).toContain(
      "多个候选",
    );
  });

  it("preserves concrete target errors instead of relabelling them as recognition failure", () => {
    for (const code of [
      ErrorCodes.ELEMENT_NOT_FOUND,
      ErrorCodes.AMBIGUOUS_TARGET,
      ErrorCodes.FRAME_NOT_FOUND,
    ]) {
      expect(loginRecoveryFor(code)).toEqual({
        retry: true,
        manualLocate: true,
      });
    }
  });

  it("offers environment editing only for a standard recipe without goto", () => {
    expect(
      loginRecoveryFor(ErrorCodes.ELEMENT_NOT_FOUND, defaultLoginSpec()),
    ).toEqual({
      message:
        "未找到登录表单元素，且当前环境未设置登录页地址。请编辑环境，填写登录页 URL 或调整表单定位。",
      retry: true,
      manualLocate: true,
      editEnvironment: true,
    });
  });

  it("keeps target recovery unchanged without a spec, with goto, or for an advanced recipe", () => {
    const withGoto = defaultLoginSpec();
    withGoto.ops.splice(1, 0, { op: "goto", url: "{origin}/login" });
    const advanced = defaultLoginSpec();
    advanced.ops.splice(1, 0, {
      op: "waitFor",
      when: { type: "fixed", ms: 1 },
    });

    for (const spec of [undefined, withGoto, advanced]) {
      expect(loginRecoveryFor(ErrorCodes.ELEMENT_NOT_FOUND, spec)).toEqual({
        retry: true,
        manualLocate: true,
      });
    }
  });

  it("does not misclassify captcha, network, success-condition or rejection failures", () => {
    for (const code of [
      ErrorCodes.CAPTCHA_REQUIRED,
      ErrorCodes.NETWORK_ERROR,
      ErrorCodes.SUCCESS_CONDITION_UNMET,
      ErrorCodes.LOGIN_REJECTED,
    ]) {
      expect(loginRecoveryFor(code).message).toBeUndefined();
      expect(loginRecoveryFor(code).manualLocate).toBe(false);
    }
  });
});

describe("showLoginRecoveryToast", () => {
  it("keeps retry, manual location and copy details as separate actions", async () => {
    const onRetry = vi.fn();
    showLoginRecoveryToast({
      prefix: "登录失败",
      error: "internal target detail",
      errorCode: ErrorCodes.LOGIN_FORM_NOT_FOUND,
      envKey: "https://example.test/login",
      onRetry,
      detail: { action: "SWITCH_ACCOUNT" },
    });

    const toast = useToast().toasts.value[0];
    expect(toast.message).toContain("未能自动登录");
    expect(toast.message).toContain(
      "未找到可用的登录表单。请确认页面已打开并完成加载后重试。",
    );
    expect(toast.actions.map((action) => action.label)).toEqual([
      "重试",
      "手动定位",
      "复制详情",
    ]);

    toast.actions[0].onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
    await toast.actions[1].onClick();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "OPEN_ACCOUNT_ENVIRONMENT",
      envKey: "https://example.test/login",
    });
    expect(sendMessage.mock.calls[0][0]).not.toHaveProperty("password");
    expect(sendMessage.mock.calls[0][0]).not.toHaveProperty("username");
  });

  it("opens environment editing for a missing-goto standard recipe", async () => {
    showLoginRecoveryToast({
      prefix: "切换失败",
      error: "internal target detail",
      errorCode: ErrorCodes.ELEMENT_NOT_FOUND,
      envKey: "https://example.test",
      spec: defaultLoginSpec(),
      onRetry: vi.fn(),
      detail: { action: "SWITCH_ACCOUNT" },
    });

    const toast = useToast().toasts.value[0];
    expect(toast.message).toContain(
      "未找到登录表单元素，且当前环境未设置登录页地址",
    );
    expect(toast.actions.map((action) => action.label)).toEqual([
      "重试",
      "编辑环境",
      "复制详情",
    ]);

    await toast.actions[1].onClick();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "OPEN_ACCOUNT_ENVIRONMENT",
      envKey: "https://example.test",
    });
  });

  it("offers only relevant recovery actions for success-condition failures", () => {
    showLoginRecoveryToast({
      prefix: "登录失败",
      error: "成功条件未满足",
      errorCode: ErrorCodes.SUCCESS_CONDITION_UNMET,
      envKey: "https://example.test/login",
      onRetry: vi.fn(),
      detail: {},
    });

    const toast = useToast().toasts.value[0];
    expect(toast.message).toContain("成功条件未满足");
    expect(toast.actions.map((action) => action.label)).toEqual([
      "重试",
      "复制详情",
    ]);
  });
});
