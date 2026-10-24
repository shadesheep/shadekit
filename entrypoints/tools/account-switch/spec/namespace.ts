/**
 * 输入命名空间 — 内置输入 + `vars` + `aux` 摊平（ADR-0015 D4）。
 *
 * 纯函数。校验器（R4）与运行期（模板求值）共用同一份摊平结果，
 * 保证「保存期认为可用的名字」与「运行期取得到值的名字」一致。
 */
import { BUILTIN_INPUT_NAMES, type LoginSpec, type SpecVar } from "./types";

/** aux 声明后自动进入命名空间的名字 */
const AUX_NAMES = ["nonce", "timestamp"] as const;

export interface InputNamespace {
  /** 名字 → 声明来源（内置 / 变量 / 自动生成） */
  names: Set<string>;
  /** 声明错误（重名、非法名） */
  errors: string[];
}

const VAR_NAME = /^[A-Za-z_]\w*$/;

/**
 * 摊平输入命名空间并检查重名。
 *
 * - 内置输入与 `aux` 名固定；`vars` 与它们重名即报错。
 * - `vars` 内部重名即报错（后者不静默覆盖前者）。
 * - `aux` 只有声明后才进入命名空间（`{nonce}` 未声明 aux 时由 R4 报错）。
 */
export function buildInputNamespace(
  spec: Pick<LoginSpec, "vars" | "aux">,
): InputNamespace {
  const names = new Set<string>(BUILTIN_INPUT_NAMES);
  const errors: string[] = [];

  if (spec.aux?.nonce === "auto" || spec.aux?.timestamp === "auto") {
    for (const name of AUX_NAMES) {
      if (spec.aux[name as keyof typeof spec.aux] === "auto") names.add(name);
    }
  }

  const seen = new Set<string>();
  const vars: SpecVar[] = Array.isArray(spec.vars) ? spec.vars : [];
  for (const [index, variable] of vars.entries()) {
    const name = typeof variable?.name === "string" ? variable.name.trim() : "";
    if (!name) {
      errors.push(`vars[${index}] 缺少 name`);
      continue;
    }
    if (!VAR_NAME.test(name)) {
      errors.push(`vars[${index}] 的 name「${name}」不是合法标识符`);
      continue;
    }
    if (
      BUILTIN_INPUT_NAMES.includes(name as (typeof BUILTIN_INPUT_NAMES)[number])
    ) {
      errors.push(`vars 中的「${name}」与内置输入重名`);
      continue;
    }
    if (AUX_NAMES.includes(name as (typeof AUX_NAMES)[number])) {
      errors.push(`vars 中的「${name}」与 aux 自动生成值重名`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`vars 中的「${name}」重复声明`);
      continue;
    }
    seen.add(name);
    names.add(name);
  }

  return { names, errors };
}
