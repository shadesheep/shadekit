const BINDING_REF = /\$([A-Za-z_][A-Za-z0-9_-]*)/g;

function bindingRefs(value) {
  if (typeof value !== "string") return [];
  const withoutEscapedDollars = value.replaceAll("$$", "");
  return [...withoutEscapedDollars.matchAll(BINDING_REF)].map((match) => match[1]);
}

function directSuccessCases(spec) {
  if (!Array.isArray(spec.success) || spec.success.length !== 1) return undefined;
  const signal = spec.success[0];
  if (!signal || typeof signal !== "object" || !("response" in signal)) return undefined;
  const response = signal.response;
  if (!response || typeof response.from !== "string" || typeof response.path !== "string" || response.equals === undefined) {
    return undefined;
  }
  return { input: `${response.from}.${response.path}`, equals: response.equals };
}

function mapInput(op) {
  return typeof op.input === "string" && op.input.startsWith("$") ? op.input.slice(1) : "";
}

function isDerivedOutput(values, gated) {
  const refs = values.flatMap(bindingRefs);
  return refs.length > 0 && refs.every((ref) => gated.has(ref));
}

function isBusinessGate(op, success) {
  return Boolean(
    success &&
    op.op === "map" &&
    op.default === undefined &&
    Array.isArray(op.cases) &&
    op.cases.length > 0 &&
    mapInput(op) === success.input &&
    op.cases.every((item) => item && Object.is(item.equals, success.equals)),
  );
}

function derivedBinding(op, gated) {
  if (op.op === "payload.build" && Array.isArray(op.parts)) {
    return isDerivedOutput(op.parts.map((part) => part?.value), gated);
  }
  if (op.op === "map" && Array.isArray(op.cases)) {
    const values = op.cases.map((item) => item?.value);
    if (op.default !== undefined) values.push(op.default);
    return isDerivedOutput(values, gated);
  }
  return false;
}

function issue(path, binding) {
  return {
    code: "AUTH_SESSION_UNGATED",
    message: binding
      ? `会话写入 ${path} 引用了未证明业务成功的绑定 $${binding}`
      : `会话写入 ${path} 必须引用业务成功门控绑定`,
    path,
    ...(binding ? { binding } : {}),
  };
}

function checkTemplate(value, path, gated, issues) {
  const refs = bindingRefs(value);
  if (refs.length === 0) issues.push(issue(path));
  for (const binding of refs) {
    if (!gated.has(binding)) issues.push(issue(path, binding));
  }
}

function checkWrites(auth, gated) {
  const issues = [];
  const cookies = Array.isArray(auth.cookiesWrite) ? auth.cookiesWrite : [];
  if (auth.cookiesWrite !== undefined && !Array.isArray(auth.cookiesWrite)) {
    issues.push(issue("auth.cookiesWrite"));
  }
  for (const [area, writes] of [["localStorageWrite", auth.localStorageWrite], ["sessionStorageWrite", auth.sessionStorageWrite]]) {
    if (writes !== undefined && !Array.isArray(writes)) issues.push(issue(`auth.${area}`));
  }
  cookies.forEach((write, index) => {
    checkTemplate(write?.value, `auth.cookiesWrite[${index}].value`, gated, issues);
    if (write?.expiresFrom !== undefined) {
      const from = write.expiresFrom?.from;
      if (typeof from !== "string" || !gated.has(from)) {
        issues.push(issue(`auth.cookiesWrite[${index}].expiresFrom.from`, typeof from === "string" ? from : undefined));
      }
    }
  });
  for (const area of ["localStorageWrite", "sessionStorageWrite"]) {
    const writes = Array.isArray(auth[area]) ? auth[area] : [];
    writes.forEach((write, index) => {
      checkTemplate(write?.value, `auth.${area}[${index}].value`, gated, issues);
    });
  }
  return issues;
}

/**
 * Skill-only fail-closed lint. It recognizes a single direct response-equals
 * business signal and no-default map gates, plus payload/map derived bindings.
 */
export function findSessionGateIssues(spec) {
  if (spec?.auth?.mode !== "engine") return [];
  if (!Array.isArray(spec.ops)) return [issue("ops")];
  const success = directSuccessCases(spec);
  const gated = new Set();
  const issues = [];
  for (const op of spec.ops) {
    if (!op || typeof op !== "object") continue;
    if (op.op === "auth.write") {
      issues.push(...checkWrites(spec.auth, gated));
      continue;
    }
    if (typeof op.as !== "string" || !op.as) continue;
    if (isBusinessGate(op, success) || derivedBinding(op, gated)) gated.add(op.as);
    else gated.delete(op.as);
  }
  return issues;
}
