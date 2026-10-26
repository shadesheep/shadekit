// entrypoints/tools/account-switch/spec/types.ts
var AUTO_LOGIN_TARGET = Object.freeze({ auto: "login" });
var LOGIN_SPEC_VERSION = 2;
var SPEC_OP_NAMES = [
  "clear.cookies",
  "clear.storage",
  "goto",
  "http.execute",
  "digest",
  "crypto.encrypt",
  "payload.build",
  "map",
  "apply.set",
  "auth.write",
  "auth.capture",
  "auth.restore",
  "fill",
  "click",
  "waitFor",
  "extract",
  "script"
];
var SPEC_OP_LABELS = {
  "clear.cookies": "\u6E05\u7406 Cookie",
  "clear.storage": "\u6E05\u7406\u5B58\u50A8",
  goto: "\u5BFC\u822A",
  "http.execute": "\u8BF7\u6C42",
  digest: "\u6458\u8981",
  "crypto.encrypt": "\u52A0\u5BC6",
  "payload.build": "\u6784\u9020\u8F7D\u8377",
  map: "\u6620\u5C04",
  "apply.set": "\u6539\u5199\u8BF7\u6C42",
  "auth.write": "\u5199\u4F1A\u8BDD",
  "auth.capture": "\u6355\u83B7\u4F1A\u8BDD",
  "auth.restore": "\u6062\u590D\u4F1A\u8BDD",
  fill: "\u586B\u5145",
  click: "\u70B9\u51FB",
  waitFor: "\u7B49\u5F85",
  extract: "\u63D0\u53D6",
  script: "\u811A\u672C"
};
var BINDING_PRODUCER_OPS = /* @__PURE__ */ new Set([
  "http.execute",
  "digest",
  "crypto.encrypt",
  "payload.build",
  "map",
  "auth.capture",
  "extract",
  "script"
]);
function isBindingProducer(op) {
  return BINDING_PRODUCER_OPS.has(op.op);
}
var DOM_INTERACTION_OPS = /* @__PURE__ */ new Set([
  "fill",
  "click",
  "waitFor",
  "goto",
  "script"
]);
function isDomInteraction(op) {
  return DOM_INTERACTION_OPS.has(op.op);
}
var DEFAULT_LIMITS = {
  requestMs: 15e3,
  stepMs: 5e3,
  settleMs: 1e4
};
var DEFAULT_AUTH = { mode: "engine" };
var BUILTIN_INPUT_NAMES = [
  "username",
  "password",
  "origin",
  "targetUrl",
  "debugRedirect"
];

// entrypoints/tools/account-switch/spec/editor.ts
var USERNAME_VALUE = "{username}";
var PASSWORD_VALUE = "{password}";
var SIMPLE_EXCLUDED = /* @__PURE__ */ new Set(["clear.cookies", "clear.storage", "auth.write"]);
function isFillWith(op, value) {
  return op.op === "fill" && op.value.trim() === value;
}
function simpleSpecShape(spec) {
  const kept = [];
  for (let i = 0; i < spec.ops.length; i++) {
    const op = spec.ops[i];
    if (!SIMPLE_EXCLUDED.has(op.op)) kept.push({ op, index: i });
  }
  if (kept.length < 3 || kept.length > 4) return null;
  const hasGoto = kept[0].op.op === "goto";
  const offset = hasGoto ? 1 : 0;
  if (kept.length !== offset + 3) return null;
  const username = kept[offset];
  const password = kept[offset + 1];
  const submit = kept[offset + 2];
  if (!isFillWith(username.op, USERNAME_VALUE)) return null;
  if (!isFillWith(password.op, PASSWORD_VALUE)) return null;
  if (submit.op.op !== "click") return null;
  return {
    ...hasGoto ? { gotoIndex: kept[0].index } : {},
    usernameIndex: username.index,
    passwordIndex: password.index,
    submitIndex: submit.index
  };
}
var SPEC_OP_OPTIONS = SPEC_OP_NAMES.map((name) => ({ label: SPEC_OP_LABELS[name], value: name }));

// entrypoints/tools/account-switch/spec/auto-login.ts
function isAutoLoginTarget(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "auto" && value.auto === "login";
}
var LEGACY_EMPTY_DEFAULT_SPEC = {
  version: LOGIN_SPEC_VERSION,
  template: "generic",
  ops: [
    { op: "clear.cookies", range: "all" },
    { op: "fill", target: "", value: "{username}", clearFirst: true },
    { op: "fill", target: "", value: "{password}", clearFirst: true },
    { op: "click", target: "", onNotFound: "fail" },
    { op: "auth.write" }
  ],
  success: [{ page: { type: "any", of: [{ type: "formGone" }, { type: "urlChanged" }] } }],
  auth: { ...DEFAULT_AUTH },
  limits: { ...DEFAULT_LIMITS }
};
function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  const a = left;
  const b = right;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return deepEqual(aKeys, bKeys) && aKeys.every((key) => deepEqual(a[key], b[key]));
}
function isLegacyEmptyDefaultSpec(value) {
  return deepEqual(value, LEGACY_EMPTY_DEFAULT_SPEC);
}
function autoLoginSpecShape(spec) {
  const shape = simpleSpecShape(spec);
  if (!shape) return null;
  const targets = [shape.usernameIndex, shape.passwordIndex, shape.submitIndex].map((index) => {
    const op = spec.ops[index];
    return op && (op.op === "fill" || op.op === "click") ? op.target : void 0;
  });
  return targets.every(isAutoLoginTarget) ? shape : null;
}

// entrypoints/tools/account-switch/spec/namespace.ts
var AUX_NAMES = ["nonce", "timestamp"];
var VAR_NAME = /^[A-Za-z_]\w*$/;
function buildInputNamespace(spec) {
  const names = new Set(BUILTIN_INPUT_NAMES);
  const errors = [];
  if (spec.aux?.nonce === "auto" || spec.aux?.timestamp === "auto") {
    for (const name of AUX_NAMES) {
      if (spec.aux[name] === "auto") names.add(name);
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const vars = Array.isArray(spec.vars) ? spec.vars : [];
  for (const [index, variable] of vars.entries()) {
    const name = typeof variable?.name === "string" ? variable.name.trim() : "";
    if (!name) {
      errors.push(`vars[${index}] \u7F3A\u5C11 name`);
      continue;
    }
    if (!VAR_NAME.test(name)) {
      errors.push(`vars[${index}] \u7684 name\u300C${name}\u300D\u4E0D\u662F\u5408\u6CD5\u6807\u8BC6\u7B26`);
      continue;
    }
    if (BUILTIN_INPUT_NAMES.includes(name)) {
      errors.push(`vars \u4E2D\u7684\u300C${name}\u300D\u4E0E\u5185\u7F6E\u8F93\u5165\u91CD\u540D`);
      continue;
    }
    if (AUX_NAMES.includes(name)) {
      errors.push(`vars \u4E2D\u7684\u300C${name}\u300D\u4E0E aux \u81EA\u52A8\u751F\u6210\u503C\u91CD\u540D`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`vars \u4E2D\u7684\u300C${name}\u300D\u91CD\u590D\u58F0\u660E`);
      continue;
    }
    seen.add(name);
    names.add(name);
  }
  return { names, errors };
}

// entrypoints/tools/account-switch/spec/template.ts
var TemplateError = class extends Error {
  code;
  /** 出错的原始记号（如 `{usernam}` / `$resp.dat`） */
  token;
  constructor(code, message, token) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
    this.token = token;
  }
};
var INPUT_NAME = /^[A-Za-z_]\w*$/;
var BINDING_REF = /^\$([A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\.\d+)*)/;
function scan(template) {
  const tokens = [];
  let text = "";
  const flush = () => {
    if (text) {
      tokens.push({ kind: "text", text });
      text = "";
    }
  };
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{") {
      if (template[i + 1] === "{") {
        text += "{";
        i += 2;
        continue;
      }
      const end = template.indexOf("}", i + 1);
      if (end < 0) {
        throw new TemplateError(
          "TEMPLATE_SYNTAX",
          "\u6A21\u677F\u4E2D\u5B58\u5728\u672A\u95ED\u5408\u7684 `{`",
          template.slice(i)
        );
      }
      const name = template.slice(i + 1, end);
      if (!INPUT_NAME.test(name)) {
        throw new TemplateError(
          "TEMPLATE_SYNTAX",
          `\u6A21\u677F\u5F15\u7528\u540D\u65E0\u6548\uFF1A\`{${name}}\``,
          template.slice(i, end + 1)
        );
      }
      flush();
      tokens.push({ kind: "input", name, raw: template.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (ch === "}") {
      if (template[i + 1] === "}") {
        text += "}";
        i += 2;
        continue;
      }
      throw new TemplateError("TEMPLATE_SYNTAX", "\u6A21\u677F\u4E2D\u5B58\u5728\u5B64\u7ACB\u7684 `}`", "}");
    }
    if (ch === "$") {
      if (template[i + 1] === "$") {
        text += "$";
        i += 2;
        continue;
      }
      const match = BINDING_REF.exec(template.slice(i));
      if (!match) {
        throw new TemplateError("TEMPLATE_SYNTAX", "\u6A21\u677F\u4E2D\u5B58\u5728\u5B64\u7ACB\u7684 `$`", "$");
      }
      const raw = match[0];
      const segments = raw.slice(1).split(".");
      flush();
      tokens.push({ kind: "binding", path: segments, raw });
      i += raw.length;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return tokens;
}
function collectTemplateRefs(template) {
  const inputs = [];
  const bindings = [];
  for (const token of scan(template)) {
    if (token.kind === "input" && !inputs.includes(token.name)) {
      inputs.push(token.name);
    }
    if (token.kind === "binding") {
      const path = token.path.join(".");
      if (!bindings.includes(path)) bindings.push(path);
    }
  }
  return { inputs, bindings };
}

// entrypoints/tools/account-switch/spec/validate.ts
var OP_NAMES = new Set(SPEC_OP_NAMES);
function issue(message, extra = {}) {
  return { code: "CONFIG_INVALID", message, ...extra };
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
function validateDomTarget(target, index, issues, allowLegacyEmpty) {
  if (isAutoLoginTarget(target)) return;
  if (isRecord(target) && "auto" in target) {
    issues.push(issue(`\u7B2C ${index + 1} \u6B65\u7684\u81EA\u52A8\u5B9A\u4F4D\u6807\u8BB0\u65E0\u6548\uFF0C\u53EA\u63A5\u53D7 { auto: "login" }`, { opIndex: index }));
    return;
  }
  if (!allowLegacyEmpty && typeof target === "string" && target.trim() === "") {
    issues.push(issue(`\u7B2C ${index + 1} \u6B65\u5B9A\u4F4D\u4E3A\u7A7A\uFF0C\u8BF7\u8865\u5168\u6216\u660E\u786E\u9009\u62E9\u81EA\u52A8\uFF08\u767B\u5F55\u8868\u5355\uFF09`, { opIndex: index }));
  }
}
function refsOf(template, issues, opIndex, field) {
  if (typeof template !== "string") return { inputs: [], bindings: [] };
  try {
    return collectTemplateRefs(template);
  } catch (e) {
    if (e instanceof TemplateError) {
      issues.push(issue(`${field}\uFF1A${e.message}`, { opIndex }));
      return { inputs: [], bindings: [] };
    }
    throw e;
  }
}
var NORMALIZE_RULES = /* @__PURE__ */ new Set([
  "trim",
  "upper",
  "lower",
  "numericString",
  "base64",
  "base64url"
]);
function validateOpShape(raw, index, issues, allowLegacyEmpty = false) {
  if (!isRecord(raw)) {
    issues.push(issue(`\u7B2C ${index + 1} \u6B65\u4E0D\u662F\u5BF9\u8C61`, { opIndex: index }));
    return false;
  }
  const op = raw.op;
  if (typeof op !== "string" || !OP_NAMES.has(op)) {
    issues.push(
      issue(`\u7B2C ${index + 1} \u6B65\u7684\u7B97\u5B50\u7C7B\u578B\u672A\u77E5\uFF08${String(op)}\uFF09`, {
        opIndex: index
      })
    );
    return false;
  }
  const before = issues.length;
  const missing = (field) => issues.push(
    issue(`\u7B2C ${index + 1} \u6B65\uFF08${op}\uFF09\u7F3A\u5C11 ${field}`, { opIndex: index })
  );
  switch (op) {
    case "clear.cookies":
      if (!isAuthRange(raw.range)) missing("range");
      break;
    case "clear.storage":
      if (raw.area !== "local" && raw.area !== "session") missing("area");
      if (!isAuthRange(raw.range)) missing("range");
      break;
    case "goto":
      if (!nonEmptyString(raw.url)) missing("url");
      break;
    case "http.execute": {
      if (!nonEmptyString(raw.url)) missing("url");
      if (!nonEmptyString(raw.as)) missing("as");
      if (raw.method !== void 0 && !HTTP_METHODS.has(raw.method)) {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09method \u65E0\u6548`, {
            opIndex: index
          })
        );
      }
      if (raw.parse !== void 0 && raw.parse !== "json" && raw.parse !== "text") {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09parse \u65E0\u6548`, {
            opIndex: index
          })
        );
      }
      if (raw.expectStatus !== void 0 && !isExpectStatus(raw.expectStatus)) {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09expectStatus \u65E0\u6548`, {
            opIndex: index
          })
        );
      }
      if (raw.body !== void 0) validateHttpBody(raw.body, index, issues);
      if (raw.headers !== void 0) {
        if (!isRecord(raw.headers)) {
          issues.push(
            issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09headers \u5FC5\u987B\u662F\u5BF9\u8C61`, {
              opIndex: index
            })
          );
        } else {
          for (const [key, value] of Object.entries(raw.headers)) {
            if (typeof value !== "string") {
              issues.push(
                issue(
                  `\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09header\u300C${key}\u300D\u7684\u503C\u5FC5\u987B\u662F\u6A21\u677F\u5B57\u7B26\u4E32`,
                  {
                    opIndex: index
                  }
                )
              );
            }
          }
        }
      }
      break;
    }
    case "digest":
      if (raw.algorithm !== "sha1" && raw.algorithm !== "sha256")
        missing("algorithm");
      if (typeof raw.input !== "string") missing("input");
      if (!nonEmptyString(raw.as)) missing("as");
      if (raw.inputEncoding !== void 0 && !["utf8", "ascii", "latin1"].includes(raw.inputEncoding)) {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08digest\uFF09inputEncoding \u65E0\u6548`, {
            opIndex: index
          })
        );
      }
      if (raw.outputEncoding !== void 0 && !["hex", "base64", "base64url"].includes(raw.outputEncoding)) {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08digest\uFF09outputEncoding \u65E0\u6548`, {
            opIndex: index
          })
        );
      }
      break;
    case "crypto.encrypt":
      if (raw.algorithm !== "rsa-pkcs1v15" && raw.algorithm !== "rsa-oaep")
        missing("algorithm");
      if (typeof raw.publicKey !== "string") missing("publicKey");
      if (typeof raw.input !== "string") missing("input");
      if (!nonEmptyString(raw.as)) missing("as");
      break;
    case "payload.build": {
      if (!nonEmptyString(raw.as)) missing("as");
      if (!Array.isArray(raw.parts) || raw.parts.length === 0) {
        missing("parts");
        break;
      }
      for (const [partIndex, part] of raw.parts.entries()) {
        if (!isRecord(part) || typeof part.value !== "string") {
          issues.push(
            issue(
              `\u7B2C ${index + 1} \u6B65\uFF08payload.build\uFF09\u7B2C ${partIndex + 1} \u4E2A part \u7F3A\u5C11 value`,
              {
                opIndex: index
              }
            )
          );
          continue;
        }
        if (part.key !== void 0 && !nonEmptyString(part.key)) {
          issues.push(
            issue(
              `\u7B2C ${index + 1} \u6B65\uFF08payload.build\uFF09\u7B2C ${partIndex + 1} \u4E2A part \u7684 key \u65E0\u6548`,
              {
                opIndex: index
              }
            )
          );
        }
        if (part.normalize !== void 0) {
          if (!Array.isArray(part.normalize)) {
            issues.push(
              issue(
                `\u7B2C ${index + 1} \u6B65\uFF08payload.build\uFF09\u7B2C ${partIndex + 1} \u4E2A part \u7684 normalize \u5FC5\u987B\u662F\u6570\u7EC4`,
                { opIndex: index }
              )
            );
          } else {
            for (const rule of part.normalize) {
              if (!NORMALIZE_RULES.has(rule)) {
                issues.push(
                  issue(
                    `\u7B2C ${index + 1} \u6B65\uFF08payload.build\uFF09\u5F52\u4E00\u5316\u89C4\u5219\u65E0\u6548\uFF08${String(rule)}\uFF09`,
                    { opIndex: index }
                  )
                );
              }
            }
          }
        }
      }
      const keyed = raw.parts.filter(
        (p) => isRecord(p) && p.key !== void 0
      ).length;
      const hasJoin = typeof raw.join === "string";
      if (keyed === raw.parts.length) {
        if (hasJoin) {
          issues.push(
            issue(`\u7B2C ${index + 1} \u6B65\uFF08payload.build\uFF09\u5BF9\u8C61\u6A21\u5F0F\u4E0D\u80FD\u58F0\u660E join`, {
              rule: "R6",
              opIndex: index
            })
          );
        }
      } else if (keyed === 0) {
        if (!hasJoin) {
          issues.push(
            issue(
              `\u7B2C ${index + 1} \u6B65\uFF08payload.build\uFF09\u5B57\u7B26\u4E32\u6A21\u5F0F\u5FC5\u987B\u58F0\u660E join`,
              {
                rule: "R6",
                opIndex: index
              }
            )
          );
        }
      } else {
        issues.push(
          issue(
            `\u7B2C ${index + 1} \u6B65\uFF08payload.build\uFF09\u4E0D\u80FD\u6DF7\u7528\u5E26 key \u4E0E\u4E0D\u5E26 key \u7684 part`,
            {
              rule: "R6",
              opIndex: index
            }
          )
        );
      }
      break;
    }
    case "map": {
      if (typeof raw.input !== "string") missing("input");
      if (!nonEmptyString(raw.as)) missing("as");
      if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
        missing("cases");
        break;
      }
      for (const [caseIndex, item] of raw.cases.entries()) {
        const validEquals = isRecord(item) && (typeof item.equals === "string" || typeof item.equals === "number" || typeof item.equals === "boolean");
        if (!validEquals || typeof item.value !== "string") {
          issues.push(
            issue(
              `\u7B2C ${index + 1} \u6B65\uFF08map\uFF09\u7B2C ${caseIndex + 1} \u4E2A case \u7684 equals/value \u65E0\u6548`,
              {
                opIndex: index
              }
            )
          );
        }
      }
      if (raw.default !== void 0 && typeof raw.default !== "string") {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08map\uFF09default \u5FC5\u987B\u662F\u6A21\u677F\u5B57\u7B26\u4E32`, {
            opIndex: index
          })
        );
      }
      break;
    }
    case "apply.set":
      if (!["header", "body", "query"].includes(raw.target))
        missing("target");
      if (!nonEmptyString(raw.key)) missing("key");
      if (typeof raw.value !== "string") missing("value");
      break;
    case "auth.write":
      break;
    case "auth.capture":
      if (!nonEmptyString(raw.as)) missing("as");
      for (const field of [
        "cookies",
        "localStorage",
        "sessionStorage"
      ]) {
        if (raw[field] !== void 0 && !isAuthRange(raw[field])) {
          issues.push(
            issue(`\u7B2C ${index + 1} \u6B65\uFF08auth.capture\uFF09${field} \u8303\u56F4\u65E0\u6548`, {
              opIndex: index
            })
          );
        }
      }
      break;
    case "auth.restore":
      if (!nonEmptyString(raw.snapshot)) missing("snapshot");
      break;
    case "fill":
      if (typeof raw.value !== "string") missing("value");
      if (raw.target === void 0) missing("target");
      else validateDomTarget(raw.target, index, issues, allowLegacyEmpty);
      break;
    case "click":
      if (raw.target === void 0) missing("target");
      else validateDomTarget(raw.target, index, issues, allowLegacyEmpty);
      if (raw.onNotFound !== void 0 && raw.onNotFound !== "fail" && raw.onNotFound !== "skip") {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08click\uFF09onNotFound \u65E0\u6548`, {
            opIndex: index
          })
        );
      }
      break;
    case "waitFor":
      if (!isSettleConditionShape(raw.when)) missing("when\uFF08\u7ED3\u7B97\u6761\u4EF6\uFF09");
      break;
    case "extract":
      if (!["local", "session", "dom", "url", "cookie"].includes(
        raw.source
      )) {
        missing("source");
      } else if (raw.source !== "url" && !nonEmptyString(raw.key)) {
        missing("key");
      }
      if (!nonEmptyString(raw.as)) missing("as");
      if (raw.parse !== void 0 && raw.parse !== "raw" && raw.parse !== "jsonValue") {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08extract\uFF09parse \u65E0\u6548`, { opIndex: index })
        );
      }
      if (raw.default !== void 0 && typeof raw.default !== "string") {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08extract\uFF09default \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`, {
            opIndex: index
          })
        );
      }
      break;
    case "script":
      if (!nonEmptyString(raw.code)) missing("code");
      if (!nonEmptyString(raw.as)) missing("as");
      if (raw.world !== void 0 && raw.world !== "MAIN" && raw.world !== "ISOLATED") {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08script\uFF09world \u65E0\u6548`, { opIndex: index })
        );
      }
      break;
  }
  return issues.length === before;
}
var HTTP_METHODS = /* @__PURE__ */ new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
function isAuthRange(value) {
  if (value === "all" || value === "none") return true;
  return Array.isArray(value) && value.every((v) => nonEmptyString(v));
}
function isExpectStatus(value) {
  if (value === "2xx") return true;
  return Array.isArray(value) && value.every((v) => Number.isInteger(v));
}
function validateHttpBody(body, index, issues) {
  if (!isRecord(body)) {
    issues.push(
      issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09body \u5FC5\u987B\u662F\u5BF9\u8C61`, {
        opIndex: index
      })
    );
    return;
  }
  const forms = ["json", "raw", "ref"].filter((k) => body[k] !== void 0);
  if (forms.length !== 1) {
    issues.push(
      issue(
        `\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09body \u5FC5\u987B\u4E14\u53EA\u80FD\u58F0\u660E json / raw / ref \u4E4B\u4E00`,
        {
          opIndex: index
        }
      )
    );
    return;
  }
  if (forms[0] === "json" && !isRecord(body.json)) {
    issues.push(
      issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09body.json \u5FC5\u987B\u662F\u5BF9\u8C61`, {
        opIndex: index
      })
    );
  }
  if (forms[0] === "raw" && typeof body.raw !== "string") {
    issues.push(
      issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09body.raw \u5FC5\u987B\u662F\u6A21\u677F\u5B57\u7B26\u4E32`, {
        opIndex: index
      })
    );
  }
  if (forms[0] === "ref" && !nonEmptyString(body.ref)) {
    issues.push(
      issue(`\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09body.ref \u5FC5\u987B\u662F\u7ED1\u5B9A\u540D`, {
        opIndex: index
      })
    );
  }
}
function validateAuthShape(auth, issues) {
  if (!isRecord(auth)) {
    issues.push(issue("\u7F3A\u5C11\u8BA4\u8BC1\u58F0\u660E\uFF08auth\uFF09"));
    return;
  }
  if (auth.mode !== "engine" && auth.mode !== "page") {
    issues.push(issue("auth.mode \u5FC5\u987B\u662F engine \u6216 page"));
  }
  for (const field of [
    "cookiesWrite",
    "localStorageWrite",
    "sessionStorageWrite"
  ]) {
    const list = auth[field];
    if (list === void 0) continue;
    if (!Array.isArray(list)) {
      issues.push(issue(`auth.${field} \u5FC5\u987B\u662F\u6570\u7EC4`));
      continue;
    }
    for (const [i, item] of list.entries()) {
      if (!isRecord(item)) {
        issues.push(issue(`auth.${field}[${i}] \u5FC5\u987B\u662F\u5BF9\u8C61`));
        continue;
      }
      if (field === "cookiesWrite") {
        if (!nonEmptyString(item.name))
          issues.push(issue(`auth.cookiesWrite[${i}] \u7F3A\u5C11 name`));
        if (typeof item.value !== "string")
          issues.push(issue(`auth.cookiesWrite[${i}] \u7F3A\u5C11 value`));
        if (item.sameSite !== void 0 && !["unspecified", "lax", "strict", "no_restriction"].includes(
          item.sameSite
        )) {
          issues.push(issue(`auth.cookiesWrite[${i}] sameSite \u65E0\u6548`));
        }
        if (item.expiresFrom !== void 0) {
          if (!isRecord(item.expiresFrom) || !nonEmptyString(item.expiresFrom.from) || typeof item.expiresFrom.path !== "string" || !["epochMs", "epochS", "iso", "relativeSeconds"].includes(
            item.expiresFrom.unit
          )) {
            issues.push(issue(`auth.cookiesWrite[${i}] expiresFrom \u65E0\u6548`));
          }
        }
      } else {
        if (!nonEmptyString(item.key))
          issues.push(issue(`auth.${field}[${i}] \u7F3A\u5C11 key`));
        if (typeof item.value !== "string")
          issues.push(issue(`auth.${field}[${i}] \u7F3A\u5C11 value`));
      }
    }
  }
}
function validateLimitsShape(limits, issues) {
  if (limits === void 0) return;
  if (!isRecord(limits)) {
    issues.push(issue("limits \u5FC5\u987B\u662F\u5BF9\u8C61"));
    return;
  }
  for (const key of ["requestMs", "stepMs", "settleMs"]) {
    const value = limits[key];
    if (value === void 0) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      issues.push(issue(`limits.${key} \u5FC5\u987B\u662F\u5927\u4E8E 0 \u7684\u6BEB\u79D2\u6570`));
    }
  }
}
function opRefs(op, index, issues) {
  const inputs = [];
  const bindings = [];
  const add = (template, field) => {
    const refs = refsOf(template, issues, index, field);
    inputs.push(...refs.inputs);
    bindings.push(...refs.bindings);
  };
  const addDeep = (value, field) => {
    if (typeof value === "string") {
      add(value, field);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        addDeep(v, `${field}[${i}]`);
      });
    } else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) addDeep(v, `${field}.${k}`);
    }
  };
  switch (op.op) {
    case "goto":
      add(op.url, "url");
      if (op.when !== void 0) add(op.when, "when");
      break;
    case "http.execute":
      add(op.url, "url");
      if (op.headers)
        for (const [k, v] of Object.entries(op.headers)) add(v, `headers.${k}`);
      if (op.body) {
        if ("raw" in op.body) add(op.body.raw, "body.raw");
        else if ("json" in op.body) addDeep(op.body.json, "body.json");
        else if (typeof op.body.ref === "string") bindings.push(op.body.ref);
      }
      break;
    case "digest":
      add(op.input, "input");
      break;
    case "crypto.encrypt":
      add(op.publicKey, "publicKey");
      add(op.input, "input");
      break;
    case "payload.build":
      op.parts.forEach((part, i) => {
        add(part.value, `parts[${i}].value`);
      });
      break;
    case "map":
      add(op.input, "input");
      op.cases.forEach((item, i) => {
        add(item.value, `cases[${i}].value`);
      });
      if (op.default !== void 0) add(op.default, "default");
      break;
    case "apply.set":
      add(op.value, "value");
      break;
    case "fill":
      add(op.value, "value");
      break;
    case "script":
      break;
    default:
      break;
  }
  return {
    inputs: [...new Set(inputs)],
    bindings: [...new Set(bindings)]
  };
}
function successRefs(signal) {
  const bindings = [];
  const walk = (s) => {
    if (!isRecord(s)) return;
    if ("anyOf" in s && Array.isArray(s.anyOf)) {
      s.anyOf.forEach(walk);
      return;
    }
    if ("response" in s && isRecord(s.response)) {
      bindings.push(String(s.response.from));
      return;
    }
    if ("token" in s && isRecord(s.token)) {
      bindings.push(String(s.token.from));
    }
  };
  walk(signal);
  return { inputs: [], bindings: [...new Set(bindings)] };
}
function hasPageSignal(signal) {
  if (!isRecord(signal)) return false;
  if ("page" in signal) return true;
  if ("anyOf" in signal && Array.isArray(signal.anyOf)) {
    return signal.anyOf.some(hasPageSignal);
  }
  return false;
}
function authWriteRefs(spec, issues) {
  const inputs = [];
  const bindings = [];
  if (!isRecord(spec.auth)) return { inputs, bindings };
  const fields = [
    "cookiesWrite",
    "localStorageWrite",
    "sessionStorageWrite"
  ];
  for (const field of fields) {
    const list = spec.auth[field];
    if (!Array.isArray(list)) continue;
    for (const [i, item] of list.entries()) {
      if (!isRecord(item)) continue;
      const where = `auth.${field}[${i}]`;
      if (typeof item.value === "string") {
        const refs = refsOf(item.value, issues, void 0, `${where}.value`);
        inputs.push(...refs.inputs);
        bindings.push(...refs.bindings);
      }
      if (isRecord(item.expiresFrom) && nonEmptyString(item.expiresFrom.from)) {
        bindings.push(item.expiresFrom.from);
      }
    }
  }
  return { inputs, bindings: [...new Set(bindings)] };
}
function successSignalShape(signal, issues) {
  if (!isRecord(signal)) {
    issues.push(issue("\u6210\u529F\u4FE1\u53F7\u5FC5\u987B\u662F\u5BF9\u8C61"));
    return null;
  }
  if ("anyOf" in signal) {
    if (!Array.isArray(signal.anyOf)) {
      issues.push(issue("\u6210\u529F\u4FE1\u53F7 anyOf \u5FC5\u987B\u662F\u6570\u7EC4"));
      return null;
    }
    const items = signal.anyOf.map((s) => successSignalShape(s, issues)).filter((s) => s !== null);
    return { anyOf: items };
  }
  if ("response" in signal) {
    const r = signal.response;
    if (!isRecord(r) || !nonEmptyString(r.from) || typeof r.path !== "string") {
      issues.push(issue("\u6210\u529F\u4FE1\u53F7 response \u5FC5\u987B\u5305\u542B from \u4E0E path"));
      return null;
    }
    return { response: { from: r.from, path: r.path, equals: r.equals } };
  }
  if ("token" in signal) {
    const t = signal.token;
    if (!isRecord(t) || !nonEmptyString(t.from) || typeof t.path !== "string") {
      issues.push(issue("\u6210\u529F\u4FE1\u53F7 token \u5FC5\u987B\u5305\u542B from \u4E0E path"));
      return null;
    }
    return { token: { from: t.from, path: t.path } };
  }
  if ("page" in signal) {
    if (!isSettleConditionShape(signal.page)) {
      issues.push(issue("\u6210\u529F\u4FE1\u53F7 page \u5FC5\u987B\u662F\u7ED3\u7B97\u6761\u4EF6"));
      return null;
    }
    return { page: signal.page };
  }
  issues.push(issue("\u6210\u529F\u4FE1\u53F7\u5FC5\u987B\u662F response / token / page / anyOf \u4E4B\u4E00"));
  return null;
}
function rootBinding(path) {
  return path.split(".")[0];
}
function isObjectPayloadRef(ref, ops, producerIndex) {
  if (typeof ref !== "string") return false;
  const producer = producerIndex.get(ref);
  const producerOp = producer === void 0 ? void 0 : ops[producer];
  return isRecord(producerOp) && producerOp.op === "payload.build" && Array.isArray(producerOp.parts) && producerOp.parts.length > 0 && producerOp.parts.every((p) => isRecord(p) && p.key !== void 0) && producerOp.join === void 0;
}
var CROSS_ORIGIN_INPUTS = /* @__PURE__ */ new Set(["targetUrl", "debugRedirect"]);
function leadsToRestore(ops, index) {
  for (let i = index + 1; i < ops.length; i++) {
    const next = ops[i];
    if (!isRecord(next)) continue;
    if (next.op === "auth.restore") return true;
    if (next.op !== "goto") return false;
  }
  return false;
}
function isCrossOriginGoto(op) {
  if (!isRecord(op) || typeof op.url !== "string") return false;
  try {
    const refs = collectTemplateRefs(op.url);
    return refs.inputs.some((name) => CROSS_ORIGIN_INPUTS.has(name));
  } catch {
    return false;
  }
}
function validateLoginSpec(raw) {
  const issues = [];
  if (!isRecord(raw)) return [issue("\u767B\u5F55\u58F0\u660E\u5FC5\u987B\u662F\u5BF9\u8C61")];
  if (raw.version !== LOGIN_SPEC_VERSION) {
    issues.push(
      issue(
        `\u767B\u5F55\u58F0\u660E\u7248\u672C\u5FC5\u987B\u662F ${LOGIN_SPEC_VERSION}\uFF08\u6536\u5230 ${String(raw.version)}\uFF09`
      )
    );
    return issues;
  }
  if (!Array.isArray(raw.ops) || raw.ops.length === 0) {
    issues.push(issue("\u767B\u5F55\u58F0\u660E\u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u7B97\u5B50"));
  }
  if (!Array.isArray(raw.success)) {
    issues.push(issue("\u6210\u529F\u4FE1\u53F7\uFF08success\uFF09\u5FC5\u987B\u662F\u6570\u7EC4"));
  } else if (raw.success.length === 0) {
    issues.push(issue("\u81F3\u5C11\u9700\u8981\u4E00\u6761\u6210\u529F\u4FE1\u53F7", { rule: "R7" }));
  }
  validateAuthShape(raw.auth, issues);
  validateLimitsShape(raw.limits, issues);
  const namespace = buildInputNamespace({
    vars: Array.isArray(raw.vars) ? raw.vars : void 0,
    aux: isRecord(raw.aux) ? raw.aux : void 0
  });
  for (const message of namespace.errors) issues.push(issue(message));
  const ops = Array.isArray(raw.ops) ? raw.ops : [];
  const legacyEmptyDefault = isLegacyEmptyDefaultSpec(raw);
  const shapeOk = ops.map(
    (op, index) => validateOpShape(op, index, issues, legacyEmptyDefault)
  );
  const successSignals = [];
  if (Array.isArray(raw.success)) {
    for (const signal of raw.success) {
      const shaped = successSignalShape(signal, issues);
      if (shaped) successSignals.push(shaped);
    }
  }
  const spec = raw;
  const autoOpIndex = ops.findIndex(
    (op) => isRecord(op) && (op.op === "fill" || op.op === "click") && isAutoLoginTarget(op.target)
  );
  if (autoOpIndex >= 0 && !autoLoginSpecShape(spec)) {
    issues.push(issue("\u81EA\u52A8\u5B9A\u4F4D\u53EA\u9002\u7528\u4E8E\u8FDE\u7EED\u7684\u7528\u6237\u540D\u3001\u5BC6\u7801\u3001\u767B\u5F55\u6309\u94AE", { opIndex: autoOpIndex }));
  }
  const authMode = isRecord(spec.auth) ? spec.auth.mode : void 0;
  if (raw.failure !== void 0 && raw.failure !== null) {
    if (!Array.isArray(raw.failure)) {
      issues.push(issue("failure \u5FC5\u987B\u662F\u6570\u7EC4"));
    } else {
      raw.failure.forEach((condition, index) => {
        if (!isSettleConditionShape(condition)) {
          issues.push(issue(`failure[${index}] \u4E0D\u662F\u5408\u6CD5\u7684\u7ED3\u7B97\u6761\u4EF6`));
        }
      });
    }
  }
  const producerIndex = /* @__PURE__ */ new Map();
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op) || !isBindingProducer(op))
      return;
    const as = op.as;
    if (typeof as !== "string" || !as) return;
    if (producerIndex.has(as)) {
      issues.push(
        issue(
          `\u7ED1\u5B9A\u540D\u300C${as}\u300D\u91CD\u590D\uFF08\u9996\u6B21\u51FA\u73B0\u4E8E\u7B2C ${producerIndex.get(as) + 1} \u6B65\uFF09`,
          {
            rule: "R5",
            opIndex: index
          }
        )
      );
      return;
    }
    producerIndex.set(as, index);
  });
  const checkBinding = (path, atIndex, where) => {
    const root = rootBinding(path);
    const produced = producerIndex.get(root);
    if (produced === void 0) {
      issues.push(
        issue(
          `${where}\u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u7ED1\u5B9A ${path.startsWith("$") ? path : `$${path}`}`,
          {
            rule: "R2",
            opIndex: atIndex
          }
        )
      );
      return;
    }
    if (produced >= atIndex) {
      issues.push(
        issue(
          `${where}\u5F15\u7528\u4E86\u5C1A\u672A\u4EA7\u51FA\u7684\u7ED1\u5B9A $${path}\uFF08\u7531\u7B2C ${produced + 1} \u6B65\u4EA7\u51FA\uFF09`,
          { rule: "R2", opIndex: atIndex }
        )
      );
    }
  };
  const checkInputs = (inputs, atIndex, where) => {
    for (const name of inputs) {
      if (!namespace.names.has(name)) {
        issues.push(
          issue(`${where}\u5F15\u7528\u4E86\u672A\u58F0\u660E\u7684\u8F93\u5165 {${name}}`, {
            rule: "R4",
            ...atIndex === void 0 ? {} : { opIndex: atIndex }
          })
        );
      }
    }
  };
  ops.forEach((op, index) => {
    if (!shapeOk[index]) return;
    const refs = opRefs(op, index, issues);
    checkInputs(
      refs.inputs,
      index,
      `\u7B2C ${index + 1} \u6B65\uFF08${op.op}\uFF09`
    );
    for (const binding of refs.bindings) {
      checkBinding(
        binding,
        index,
        `\u7B2C ${index + 1} \u6B65\uFF08${op.op}\uFF09`
      );
    }
  });
  const endIndex = ops.length;
  for (const signal of successSignals) {
    const refs = successRefs(signal);
    checkInputs(refs.inputs, void 0, "\u6210\u529F\u4FE1\u53F7");
    for (const binding of refs.bindings) {
      checkBinding(binding, endIndex, "\u6210\u529F\u4FE1\u53F7");
    }
  }
  const authWriteIndex = ops.findIndex(
    (op, index) => shapeOk[index] && isRecord(op) && op.op === "auth.write" && spec.auth?.mode !== "page"
  );
  const authEvalIndex = authWriteIndex >= 0 ? authWriteIndex : endIndex;
  const authRefs = authWriteRefs(spec, issues);
  checkInputs(authRefs.inputs, void 0, "auth \u5199\u5165\u58F0\u660E");
  for (const binding of authRefs.bindings) {
    checkBinding(binding, authEvalIndex, "auth \u5199\u5165\u58F0\u660E");
  }
  const referencedBindings = new Set(
    successSignals.flatMap(
      (signal) => successRefs(signal).bindings.map(rootBinding)
    )
  );
  const pageSignal = successSignals.some(hasPageSignal);
  let lastDom = -1;
  ops.forEach((op, index) => {
    if (!shapeOk[index]) return;
    if (isCrossOriginGoto(op) && leadsToRestore(ops, index)) {
      return;
    }
    if (isDomInteraction(op)) lastDom = index;
  });
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op)) return;
    const name = op.op;
    if (name !== "auth.write" && name !== "auth.capture") return;
    if (name === "auth.write" && authMode === "page") return;
    for (const as of referencedBindings) {
      const produced = producerIndex.get(as);
      if (produced !== void 0 && produced >= index) {
        issues.push(
          issue(
            `\u7B2C ${index + 1} \u6B65\uFF08${name}\uFF09\u5FC5\u987B\u4F4D\u4E8E\u4EA7\u51FA\u6210\u529F\u4FE1\u53F7\u7ED1\u5B9A\u300C${as}\u300D\u7684\u7B2C ${produced + 1} \u6B65\u4E4B\u540E`,
            { rule: "R1", opIndex: index }
          )
        );
      }
    }
    if (pageSignal && lastDom >= index) {
      issues.push(
        issue(
          `\u7B2C ${index + 1} \u6B65\uFF08${name}\uFF09\u5FC5\u987B\u4F4D\u4E8E\u6700\u540E\u4E00\u4E2A DOM \u4EA4\u4E92\u7B97\u5B50\uFF08\u7B2C ${lastDom + 1} \u6B65\uFF09\u4E4B\u540E`,
          { rule: "R1", opIndex: index }
        )
      );
    }
  });
  const firstWrite = ops.findIndex(
    (op, index) => shapeOk[index] && isRecord(op) && op.op === "auth.write" && spec.auth?.mode !== "page"
  );
  if (firstWrite >= 0) {
    ops.forEach((op, index) => {
      if (index >= firstWrite) return;
      if (!shapeOk[index] || !isRecord(op) || op.op !== "goto") return;
      if (!isCrossOriginGoto(op)) return;
      issues.push(
        issue(
          `\u7B2C ${index + 1} \u6B65\uFF08goto\uFF09\u662F\u8DE8 origin \u5BFC\u822A\uFF0C\u4E0D\u5F97\u4F4D\u4E8E auth.write\uFF08\u7B2C ${firstWrite + 1} \u6B65\uFF09\u4E4B\u524D`,
          { rule: "R3", opIndex: index }
        )
      );
    });
  }
  const captureIndices = /* @__PURE__ */ new Map();
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op) || op.op !== "auth.capture") return;
    if (nonEmptyString(op.as) && !captureIndices.has(op.as)) {
      captureIndices.set(op.as, index);
    }
  });
  let sawGotoBefore = false;
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op)) return;
    if (op.op === "goto") {
      sawGotoBefore = true;
      return;
    }
    if (op.op !== "auth.restore") return;
    const snapshot = typeof op.snapshot === "string" ? op.snapshot : "";
    const captured = captureIndices.get(snapshot);
    if (captured === void 0) {
      issues.push(
        issue(
          `\u7B2C ${index + 1} \u6B65\uFF08auth.restore\uFF09\u7684\u5FEB\u7167\u300C${snapshot}\u300D\u4E0D\u662F\u4EFB\u4F55 auth.capture \u7684\u4EA7\u51FA`,
          {
            rule: "R6",
            opIndex: index
          }
        )
      );
    } else if (captured >= index) {
      issues.push(
        issue(
          `\u7B2C ${index + 1} \u6B65\uFF08auth.restore\uFF09\u7684\u5FEB\u7167\u300C${snapshot}\u300D\u7531\u66F4\u665A\u7684\u7B2C ${captured + 1} \u6B65\u6355\u83B7`,
          { rule: "R3", opIndex: index }
        )
      );
    }
    if (!sawGotoBefore) {
      issues.push(
        issue(`\u7B2C ${index + 1} \u6B65\uFF08auth.restore\uFF09\u5FC5\u987B\u4F4D\u4E8E\u4E00\u6B21 goto \u4E4B\u540E`, {
          rule: "R3",
          opIndex: index
        })
      );
    }
  });
  ops.forEach((op, index) => {
    if (!shapeOk[index] || !isRecord(op)) return;
    if (op.op === "apply.set") {
      const next = ops.findIndex(
        (later, laterIndex) => laterIndex > index && shapeOk[laterIndex] && isRecord(later) && later.op === "http.execute"
      );
      if (next < 0) {
        issues.push(
          issue(`\u7B2C ${index + 1} \u6B65\uFF08apply.set\uFF09\u4E4B\u540E\u6CA1\u6709 http.execute`, {
            rule: "R6",
            opIndex: index
          })
        );
        return;
      }
      if (op.target === "body") {
        const target = ops[next];
        const body = isRecord(target) ? target.body : void 0;
        const writable = isRecord(body) && ("json" in body || "ref" in body && isObjectPayloadRef(body.ref, ops, producerIndex));
        if (!writable) {
          issues.push(
            issue(
              `\u7B2C ${index + 1} \u6B65\uFF08apply.set\uFF09\u7684 target \u4E3A body\uFF0C\u4F46\u7B2C ${next + 1} \u6B65\uFF08http.execute\uFF09\u7684 body \u4E0D\u662F { json } \u6216\u5BF9\u8C61\u7ED1\u5B9A { ref }`,
              { rule: "R6", opIndex: index }
            )
          );
        }
      }
      return;
    }
    if (op.op === "http.execute" && isRecord(op.body) && "ref" in op.body) {
      const ref = op.body.ref;
      if (typeof ref !== "string") return;
      if (!isObjectPayloadRef(ref, ops, producerIndex)) {
        issues.push(
          issue(
            `\u7B2C ${index + 1} \u6B65\uFF08http.execute\uFF09\u7684 body.ref\u300C${ref}\u300D\u5FC5\u987B\u5F15\u7528\u5BF9\u8C61\u6A21\u5F0F\u7684 payload.build \u4EA7\u51FA`,
            { rule: "R6", opIndex: index }
          )
        );
      }
    }
  });
  const effectiveSignals = successSignals.filter(isEffectiveSignal);
  if (Array.isArray(raw.success) && raw.success.length > 0 && effectiveSignals.length === 0) {
    issues.push(issue("\u6210\u529F\u4FE1\u53F7\u6CA1\u6709\u6709\u6548\u6761\u4EF6", { rule: "R7" }));
  }
  return issues;
}
var SETTLE_TYPES = /* @__PURE__ */ new Set([
  "formGone",
  "urlChanged",
  "url",
  "selector",
  "cookie",
  "storage",
  "fixed",
  "any",
  "all"
]);
function isSettleConditionShape(value) {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (typeof type !== "string" || !SETTLE_TYPES.has(type)) return false;
  switch (type) {
    case "url":
      return nonEmptyString(value.glob);
    case "selector":
      return value.target !== void 0 && !(isRecord(value.target) && "auto" in value.target);
    case "cookie":
      return nonEmptyString(value.name);
    case "storage":
      return (value.area === "local" || value.area === "session") && nonEmptyString(value.key);
    case "fixed":
      return typeof value.ms === "number" && value.ms >= 0;
    case "any":
    case "all":
      return Array.isArray(value.of) && value.of.length > 0 && value.of.every(isSettleConditionShape);
    default:
      return true;
  }
}
function isEffectiveSignal(signal) {
  if ("anyOf" in signal) return signal.anyOf.some(isEffectiveSignal);
  return true;
}
export {
  BUILTIN_INPUT_NAMES,
  validateLoginSpec
};

export { validateLoginSpec as validateLoginSpecSnapshot };
