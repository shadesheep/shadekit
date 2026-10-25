// entrypoints/tools/account-switch/spec/types.ts
var LOGIN_SPEC_VERSION = 2;

// entrypoints/tools/account-switch/spec/package.ts
var CONFIG_PACKAGE_FORMAT = "dt-login-config/v1";
var PACKAGE_PATTERN = /^dt-login-config\/v(\d+)$/;
function configPackageVersion(format) {
  if (typeof format !== "string") return void 0;
  const match = PACKAGE_PATTERN.exec(format);
  return match ? Number(match[1]) : void 0;
}
var SUPPORTED_PACKAGE_VERSION = 1;
function findScriptOps(spec) {
  const issues = [];
  spec.ops.forEach((op, index) => {
    if (op.op === "script") {
      issues.push({
        opIndex: index,
        message: `\u7B2C ${index + 1} \u6B65\uFF08script\uFF09\u5305\u542B\u53EF\u6267\u884C\u4EE3\u7801\uFF0C\u4E0D\u80FD\u968F\u914D\u7F6E\u5305\u5206\u53D1`
      });
    }
  });
  return issues;
}
function findSecretVars(spec) {
  return (spec.vars ?? []).filter((variable) => variable.secret === true).map((variable) => variable.name);
}
function checkRequiredVars(requiredNames, spec) {
  const declared = new Set((spec.vars ?? []).map((v) => v.name));
  return requiredNames.filter((name) => !declared.has(name)).map((name) => ({
    varName: name,
    message: `\u9700\u8981\u586B\u5199\u7684\u53D8\u91CF\u300C${name}\u300D\u4E0D\u5728\u767B\u5F55\u58F0\u660E\u7684 vars \u4E2D`
  }));
}
function buildConfigPackage(environment, origin, requiredVars) {
  const spec = environment.strategyConfig?.spec;
  if (!spec) {
    return {
      issues: [{ message: "\u8BE5\u73AF\u5883\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u767B\u5F55\u58F0\u660E\uFF08spec\uFF09" }]
    };
  }
  const issues = [];
  issues.push(...findScriptOps(spec));
  const secretVars = findSecretVars(spec);
  issues.push(
    ...secretVars.map((name) => ({
      varName: name,
      message: `\u53D8\u91CF\u300C${name}\u300D\u6807\u8BB0\u4E3A\u654F\u611F\uFF08secret\uFF09\uFF0C\u4E0D\u80FD\u968F\u914D\u7F6E\u5305\u5206\u53D1`
    }))
  );
  const packageVars = (spec.vars ?? []).filter((variable) => variable.secret !== true).map((variable) => ({ name: variable.name, title: variable.title }));
  const uniqueRequired = Array.from(new Set(requiredVars));
  issues.push(...checkRequiredVars(uniqueRequired, spec));
  for (const name of uniqueRequired) {
    if (secretVars.includes(name)) {
      issues.push({
        varName: name,
        message: `\u9700\u8981\u586B\u5199\u7684\u53D8\u91CF\u300C${name}\u300D\u662F\u654F\u611F\u53D8\u91CF\uFF08secret\uFF09\uFF0C\u4E0D\u80FD\u8FDB\u5305`
      });
    }
  }
  if (issues.length > 0) {
    return { issues };
  }
  const requiredVarDefs = uniqueRequired.map((name) => ({
    name,
    title: packageVars.find((v) => v.name === name)?.title
  }));
  const packageObj = {
    format: CONFIG_PACKAGE_FORMAT,
    specVersion: LOGIN_SPEC_VERSION,
    requiredVars: requiredVarDefs,
    environments: [
      {
        name: environment.name,
        url: origin,
        loginMethod: environment.loginMethod,
        spec,
        requiredVars: requiredVarDefs
      }
    ]
  };
  return { package: packageObj, issues: [] };
}
function validateConfigPackage(raw) {
  const issues = [];
  if (!isRecord(raw) || typeof raw.format !== "string") {
    return [{ code: "CONFIG_INVALID", message: "\u914D\u7F6E\u5305\u683C\u5F0F\u65E0\u6548" }];
  }
  if (raw.format !== CONFIG_PACKAGE_FORMAT) {
    return [
      {
        code: "CONFIG_INVALID",
        message: `\u914D\u7F6E\u5305\u683C\u5F0F ${raw.format} \u4E0D\u88AB\u652F\u6301\uFF08\u9700\u8981 ${CONFIG_PACKAGE_FORMAT}\uFF09`
      }
    ];
  }
  if (typeof raw.specVersion === "number" && raw.specVersion > LOGIN_SPEC_VERSION) {
    return [
      {
        code: "CONFIG_INVALID",
        message: `\u914D\u7F6E\u5305 spec \u7248\u672C ${raw.specVersion} \u9AD8\u4E8E\u5F53\u524D\u6269\u5C55\u652F\u6301\u7684 ${LOGIN_SPEC_VERSION}\uFF0C\u8BF7\u5148\u5347\u7EA7\u6269\u5C55\u540E\u518D\u5BFC\u5165`
      }
    ];
  }
  const envs = Array.isArray(raw.environments) ? raw.environments : [];
  if (envs.length === 0) {
    issues.push({ code: "CONFIG_INVALID", message: "\u914D\u7F6E\u5305\u4E0D\u542B\u4EFB\u4F55\u73AF\u5883" });
  }
  const packageRequired = [];
  if (Array.isArray(raw.requiredVars)) {
    for (const item of raw.requiredVars) {
      if (isRecord(item) && typeof item.name === "string") {
        packageRequired.push(item.name);
      }
    }
  }
  envs.forEach((env, envIndex) => {
    if (!isRecord(env)) {
      issues.push({
        code: "CONFIG_INVALID",
        message: `\u7B2C ${envIndex + 1} \u4E2A\u73AF\u5883\u4E0D\u662F\u5BF9\u8C61`
      });
      return;
    }
    const spec = env.spec;
    if (!isRecord(spec)) {
      issues.push({
        code: "CONFIG_INVALID",
        message: `\u7B2C ${envIndex + 1} \u4E2A\u73AF\u5883\u7F3A\u5C11\u767B\u5F55\u58F0\u660E\uFF08spec\uFF09`
      });
      return;
    }
    if (spec.version !== LOGIN_SPEC_VERSION) {
      issues.push({
        code: "CONFIG_INVALID",
        message: `\u7B2C ${envIndex + 1} \u4E2A\u73AF\u5883\u7684 spec \u7248\u672C\u4E0D\u652F\u6301\uFF08\u9700\u8981 ${LOGIN_SPEC_VERSION}\uFF09`
      });
      return;
    }
    const loginSpec = spec;
    const scriptOps = findScriptOps(loginSpec);
    for (const s of scriptOps) {
      issues.push({
        code: "CONFIG_INVALID",
        message: s.message,
        ...s.opIndex === void 0 ? {} : { opIndex: s.opIndex }
      });
    }
    const secretVars = findSecretVars(loginSpec);
    for (const name of secretVars) {
      issues.push({
        code: "CONFIG_INVALID",
        varName: name,
        message: `\u7B2C ${envIndex + 1} \u4E2A\u73AF\u5883\u542B\u654F\u611F\u53D8\u91CF\u300C${name}\u300D\uFF08secret\uFF09\uFF0Cv1 \u914D\u7F6E\u5305\u4E0D\u5141\u8BB8\u5206\u53D1\u654F\u611F\u53D8\u91CF`
      });
    }
    const envRequired = Array.isArray(
      env.requiredVars
    ) ? env.requiredVars.filter((item) => isRecord(item) && typeof item.name === "string").map((item) => item.name) : [];
    const overflow = checkRequiredVars(
      Array.from(/* @__PURE__ */ new Set([...packageRequired, ...envRequired])),
      loginSpec
    );
    for (const o of overflow) {
      issues.push({
        code: "CONFIG_INVALID",
        message: `\u7B2C ${envIndex + 1} \u4E2A\u73AF\u5883\uFF1A${o.message}`,
        ...o.varName === void 0 ? {} : { varName: o.varName }
      });
    }
  });
  return issues;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
export {
  CONFIG_PACKAGE_FORMAT,
  SUPPORTED_PACKAGE_VERSION,
  buildConfigPackage,
  checkRequiredVars,
  configPackageVersion,
  findScriptOps,
  findSecretVars,
  validateConfigPackage
};
function buildConfigPackageSnapshot(input) { const declared = Array.isArray(input.spec?.vars) ? input.spec.vars : []; const requiredVars = input.requiredVars ?? declared.filter((v) => v && v.secret !== true && v.default === undefined).map((v) => v.name); return buildConfigPackage({ name: input.name, loginMethod: input.loginMethod, strategyConfig: { spec: input.spec } }, input.url, requiredVars); } export { validateConfigPackage as validateConfigPackageSnapshot, buildConfigPackageSnapshot };
