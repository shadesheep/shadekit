import { isSensitiveKey, REDACTED } from "./redact";
import type { LoginRunInput } from "./host";

export interface RunTaint {
  bindings: Record<string, boolean>;
}

export function initialSecretValues(input: LoginRunInput): Set<string> {
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) values.add(value);
  };
  add(input.inputs.password);
  for (const variable of input.spec.vars ?? []) {
    if (!variable.secret) continue;
    add(input.inputs.vars?.[variable.name]);
    add(variable.default);
  }
  return values;
}

export function registerSecretValue(value: unknown, secrets: Set<string>, force = false, key = ""): boolean {
  if (typeof value === "string") {
    const containsSecret = [...secrets].some((secret) => secret.length > 0 && value.includes(secret));
    if (!force && !containsSecret && !isSensitiveKey(key)) return false;
    if (value.length > 0) secrets.add(value);
    return true;
  }
  if (Array.isArray(value)) {
    let tainted = force;
    for (const item of value) tainted = registerSecretValue(item, secrets, force) || tainted;
    return tainted;
  }
  if (typeof value === "object" && value !== null) {
    let tainted = force;
    for (const [childKey, child] of Object.entries(value)) {
      tainted = registerSecretValue(child, secrets, force, childKey) || tainted;
    }
    return tainted;
  }
  return force;
}

export function templateReferencesSecret(
  template: string,
  secretInputNames: ReadonlySet<string>,
  taint: RunTaint,
): boolean {
  for (const name of secretInputNames) {
    if (template.includes(`{${name}}`)) return true;
  }
  for (const match of template.matchAll(/\$([A-Za-z_][\w]*)/g)) {
    if (taint.bindings[match[1]]) return true;
  }
  return false;
}

export function redactSecretValues(text: string, secrets: ReadonlySet<string>): string {
  let output = text;
  const ordered = [...secrets].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of ordered) output = output.replaceAll(secret, REDACTED);
  return output;
}
