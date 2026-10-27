import { loginFormTargetMode } from "../spec/auto-login";
import type { LoginSpec } from "../spec/types";

export interface LoginFormLocatorView {
  mode: "auto" | "locked" | "custom" | "advanced";
  label: string;
  canScan: boolean;
}

const LABELS = {
  auto: "自动定位",
  locked: "已锁定",
  custom: "自定义定位",
  advanced: "自定义登录流程",
} as const;

/** 定位状态完全由当前 spec 推导，不建立会过期的第二份状态。 */
export function loginFormLocatorView(spec: LoginSpec): LoginFormLocatorView {
  const mode = loginFormTargetMode(spec);
  return { mode, label: LABELS[mode], canScan: mode !== "advanced" };
}
