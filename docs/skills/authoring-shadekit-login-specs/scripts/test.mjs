import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateLoginSpecSnapshot } from "./login-spec-validator.mjs";
import { findSessionGateIssues } from "./session-gate.mjs";
import { buildConfigPackageSnapshot, validateConfigPackageSnapshot } from "./config-package.mjs";
import { validateDeliverables } from "./validate.mjs";
import { simulateLoginSpec } from "./simulator.mjs";

const skillRoot = fileURLToPath(new URL("../", import.meta.url));
const readJson = async (relative) => JSON.parse(await readFile(new URL(`../${relative}`, import.meta.url), "utf8"));

const invalidCases = [
  ["r1-success-after-write.json", "R1", 0],
  ["r2-missing-binding.json", "R2", 0],
  ["r3-restore-without-goto.json", "R3", 1],
  ["r4-unknown-input.json", "R4", 0],
  ["r5-duplicate-binding.json", "R5", 1],
  ["r6-dangling-apply.json", "R6", 0],
  ["r7-empty-any-of.json", "R7", undefined],
];

test("valid gated API LoginSpec passes snapshot validation", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  assert.deepEqual(validateLoginSpecSnapshot(spec), []);
});

test("automatic and exact legacy defaults pass, while auto misuse fails closed", async () => {
  for (const file of ["auto-login.json", "legacy-empty-default.json"]) {
    assert.deepEqual(validateLoginSpecSnapshot(await readJson(`fixtures/valid/${file}`)), [], file);
  }
  const misuse = await readJson("fixtures/invalid/auto-login-misuse.json");
  assert.ok(validateLoginSpecSnapshot(misuse).some((issue) => issue.code === "CONFIG_INVALID"));

  const spec = await readJson("fixtures/valid/auto-login.json");
  const built = buildConfigPackageSnapshot({ spec, name: "Auto", url: "{origin}" });
  assert.deepEqual(built.issues, []);
  assert.equal(built.package.format, "dt-login-config/v1");
  assert.equal(built.package.specVersion, 2);
});

for (const [file, rule, opIndex] of invalidCases) {
  test(`invalid fixture ${file} reports ${rule}`, async () => {
    const issues = validateLoginSpecSnapshot(await readJson(`fixtures/invalid/${file}`));
    assert.ok(issues.some((issue) => issue.code === "CONFIG_INVALID" && issue.rule === rule && (opIndex === undefined || issue.opIndex === opIndex)), JSON.stringify(issues));
  });
}

test("malformed inputs produce issues without throwing", () => {
  for (const raw of [null, [], 42, { version: 2, ops: [null], success: [], auth: null }]) {
    assert.doesNotThrow(() => validateLoginSpecSnapshot(raw));
    const issues = validateLoginSpecSnapshot(raw);
    assert.ok(issues.length > 0);
    for (const issue of issues) assert.equal(issue.code, "CONFIG_INVALID");
  }
});

test("success shapes accept nested anyOf and escaped literals are not refs", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  const response = spec.success[0];
  spec.success = [response, { anyOf: [response, { token: { from: "accepted", path: "token" } }] }];
  spec.ops[0].parts.push({ key: "literal", value: "{{origin}}-$$accepted" });
  assert.deepEqual(validateLoginSpecSnapshot(spec), []);
});

test("R6 rejects body.ref produced by string payload.build", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  spec.ops[0] = { op: "payload.build", join: "", parts: [{ value: "raw" }], as: "credentials" };
  const issues = validateLoginSpecSnapshot(spec);
  assert.ok(issues.some((issue) => issue.rule === "R6" && issue.opIndex === 1), JSON.stringify(issues));
});

test("auth refs must exist at auth.write rather than only at spec end", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  const [gate] = spec.ops.splice(2, 1);
  spec.ops.push(gate);
  const issues = validateLoginSpecSnapshot(spec);
  assert.ok(issues.some((issue) => issue.rule === "R2"), JSON.stringify(issues));
});

test("all issue paths are serializable and skill root is local", () => {
  assert.ok(skillRoot.length > 0);
  const issues = validateLoginSpecSnapshot({ version: 2, ops: "bad", success: null, auth: {} });
  assert.doesNotThrow(() => JSON.stringify(issues));
});

test("accepted map output is gated for every session destination", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  assert.deepEqual(validateLoginSpecSnapshot(spec), []);
  assert.deepEqual(findSessionGateIssues(spec), []);
});

test("direct response writes reject Cookie, localStorage, sessionStorage and expiry", async () => {
  const spec = await readJson("fixtures/invalid/session-ungated.json");
  assert.deepEqual(validateLoginSpecSnapshot(spec), []);
  const issues = findSessionGateIssues(spec);
  for (const path of ["auth.cookiesWrite[0].value", "auth.cookiesWrite[0].expiresFrom.from", "auth.localStorageWrite[0].value", "auth.sessionStorageWrite[0].value"]) {
    assert.ok(issues.some((issue) => issue.code === "AUTH_SESSION_UNGATED" && issue.path === path && issue.binding === "login"), `${path}: ${JSON.stringify(issues)}`);
  }
});

test("expiry cannot bypass a gated session value", async () => {
  const issues = findSessionGateIssues(await readJson("fixtures/invalid/session-ungated-expiry.json"));
  assert.deepEqual(issues.map((issue) => issue.path), ["auth.cookiesWrite[0].expiresFrom.from"]);
});

test("derived bindings stay gated while compound success fails closed", async () => {
  const derived = await readJson("fixtures/valid/api-gated.json");
  derived.ops.splice(3, 0, {
    op: "payload.build",
    parts: [{ key: "token", value: "$accepted.token" }, { key: "expires", value: "$accepted.expires" }, { key: "realm", value: "$accepted.realm" }],
    as: "session",
  });
  derived.auth.cookiesWrite[0].value = "$session.token";
  derived.auth.cookiesWrite[0].expiresFrom.from = "session";
  derived.auth.localStorageWrite[0].value = "$session.token";
  derived.auth.sessionStorageWrite[0].value = "$session.realm";
  assert.deepEqual(findSessionGateIssues(derived), []);

  const compound = await readJson("fixtures/valid/api-gated.json");
  compound.success.push({ token: { from: "accepted", path: "token" } });
  assert.ok(findSessionGateIssues(compound).length > 0);
});

test("page-managed auth needs no engine gate and malformed input fails closed", async () => {
  const spec = await readJson("fixtures/invalid/session-ungated.json");
  spec.auth.mode = "page";
  assert.deepEqual(findSessionGateIssues(spec), []);
  assert.ok(findSessionGateIssues({ auth: { mode: "engine", cookiesWrite: "bad" }, ops: [{ op: "auth.write" }] }).length > 0);
});

test("package builder synchronizes requiredVars and excludes credentials", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  spec.vars.push({ name: "tenant", title: "Tenant" });
  spec.ops[0].parts.push({ key: "tenant", value: "{tenant}" });
  const result = buildConfigPackageSnapshot({ spec, name: "Example", url: "{origin}" });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.package.requiredVars, [{ name: "tenant", title: "Tenant" }]);
  assert.deepEqual(result.package.environments[0].requiredVars, result.package.requiredVars);
  const serialized = JSON.stringify(result.package);
  assert.ok(!serialized.includes("correct horse"));
  assert.ok(!Object.hasOwn(result.package, "accounts"));
});

test("valid package and deliverables pass all snapshot checks", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  const pkg = await readJson("fixtures/valid/dt-login-config.json");
  assert.deepEqual(validateConfigPackageSnapshot(pkg), []);
  assert.deepEqual(validateDeliverables({ spec, package: pkg }), { specIssues: [], packageIssues: [], equalityIssues: [], gateIssues: [] });
});

for (const file of ["package-empty.json", "package-version.json", "package-script.json", "package-secret.json"]) {
  test(`invalid ${file} is rejected`, async () => {
    const issues = validateConfigPackageSnapshot(await readJson(`fixtures/invalid/${file}`));
    assert.ok(issues.length > 0);
  });
}

test("deep spec equality ignores object key order", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  const pkg = await readJson("fixtures/valid/dt-login-config.json");
  const nested = pkg.environments[0].spec;
  pkg.environments[0].spec = Object.fromEntries(Object.entries(nested).reverse());
  assert.deepEqual(validateDeliverables({ spec, package: pkg }).equalityIssues, []);
});

test("package rejects overflow vars and delivery rejects nested spec drift", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  const overflow = buildConfigPackageSnapshot({ spec, name: "Example", url: "{origin}", requiredVars: ["missing", "missing"] });
  assert.ok(overflow.issues.some((issue) => issue.varName === "missing"));
  const pkg = await readJson("fixtures/valid/dt-login-config.json");
  pkg.environments[0].spec.template = "drift";
  const result = validateDeliverables({ spec, package: pkg });
  assert.ok(result.equalityIssues.some((issue) => issue.path === "environments[0].spec"));
});

test("offline API success records requests, AND/OR signals and memory session without fetch", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  spec.success.push({ anyOf: [{ response: { from: "login", path: "code", equals: 99 } }, { token: { from: "accepted", path: "token" } }] });
  const fixture = await readJson("fixtures/behavior/api-success.json");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => { fetchCalls += 1; throw new Error("real fetch forbidden"); };
  let result;
  try { result = await simulateLoginSpec(spec, fixture); } finally { globalThis.fetch = originalFetch; }
  assert.equal(fetchCalls, 0);
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.equal(result.success, true);
  assert.deepEqual(result.requests, fixture.expect.requests);
  assert.deepEqual(result.session, fixture.expect.session);
  assert.ok(!JSON.stringify(result.issues).includes("good"));
});

test("repeat switch clears previous auth state before writing the accepted session", async () => {
  const spec = await readJson("fixtures/valid/api-repeat-switch.json");
  const fixture = await readJson("fixtures/behavior/api-repeat-switch.json");
  assert.deepEqual(validateLoginSpecSnapshot(spec), []);
  assert.deepEqual(findSessionGateIssues(spec), []);
  const result = await simulateLoginSpec(spec, fixture);
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.equal(result.success, true);
  assert.deepEqual(result.session, fixture.expect.session);
  assert.ok(!JSON.stringify(result.session).includes("old-fixture"));

  const parentSpec = structuredClone(spec);
  parentSpec.ops[0].includeParent = true;
  const parentResult = await simulateLoginSpec(parentSpec, fixture);
  assert.equal(parentResult.status, "NOT_SIMULATED");
});

test("top-level success signals are AND", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  spec.success.push({ token: { from: "accepted", path: "missing" } });
  const fixture = await readJson("fixtures/behavior/api-success.json");
  fixture.expect.success = false;
  fixture.expect.errorCode = "SUCCESS_CONDITION_UNMET";
  delete fixture.expect.session;
  const result = await simulateLoginSpec(spec, fixture);
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "SUCCESS_CONDITION_UNMET");
});

test("200 business rejection produces CONFIG_INVALID and zero auth writes", async () => {
  const result = await simulateLoginSpec(await readJson("fixtures/valid/api-gated.json"), await readJson("fixtures/behavior/api-business-rejected.json"));
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "CONFIG_INVALID");
  assert.deepEqual(result.session, { cookies: [], localStorage: {}, sessionStorage: {} });
  assert.ok(!JSON.stringify(result.issues).includes("bad"));
});

test("missing or mismatched responses and unresolved bindings fail closed", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  const missing = await readJson("fixtures/behavior/api-success.json");
  missing.responses = [];
  missing.expect = { success: false, errorCode: "FIXTURE_RESPONSE_MISSING" };
  assert.equal((await simulateLoginSpec(spec, missing)).status, "PASS");
  const mismatch = await readJson("fixtures/behavior/api-success.json");
  mismatch.responses[0].body.code = 1;
  assert.equal((await simulateLoginSpec(spec, mismatch)).status, "FAIL");
  const unresolved = { version: 2, ops: [{ op: "map", input: "$missing", cases: [], default: "x", as: "x" }], success: [{ token: { from: "x", path: "token" } }], auth: { mode: "engine" } };
  const unresolvedResult = await simulateLoginSpec(unresolved, { inputs: {}, responses: [], expect: { success: false, errorCode: "TEMPLATE_UNRESOLVED" } });
  assert.equal(unresolvedResult.status, "PASS", JSON.stringify(unresolvedResult));
});

test("request paths cannot pollute prototypes and storage keys stay own properties", async () => {
  const spec = await readJson("fixtures/valid/api-gated.json");
  spec.ops.splice(1, 0, { op: "apply.set", target: "body", key: "__proto__.polluted", value: "yes" });
  const fixture = await readJson("fixtures/behavior/api-success.json");
  fixture.responses = [];
  fixture.expect = { success: false, errorCode: "CONFIG_INVALID" };
  try {
    const result = await simulateLoginSpec(spec, fixture);
    assert.equal(result.status, "PASS", JSON.stringify(result));
    assert.equal(Object.prototype.polluted, undefined);
  } finally {
    delete Object.prototype.polluted;
  }

  const storageSpec = await readJson("fixtures/valid/api-gated.json");
  storageSpec.auth.localStorageWrite = [{ key: "__proto__", value: "$accepted.token" }];
  const storageFixture = await readJson("fixtures/behavior/api-success.json");
  storageFixture.expect = { success: true };
  const storageResult = await simulateLoginSpec(storageSpec, storageFixture);
  assert.equal(storageResult.status, "PASS", JSON.stringify(storageResult));
  assert.equal(Object.hasOwn(storageResult.session.localStorage, "__proto__"), true);
});

test("digest and both RSA algorithms pass standalone valid paths", async () => {
  const digestSpec = {
    version: 2,
    ops: [
      { op: "digest", algorithm: "sha256", input: "abc", as: "hash" },
      { op: "http.execute", url: "{origin}/digest", method: "POST", headers: { "X-Digest": "$hash" }, body: { json: {} }, as: "login" },
    ],
    success: [{ response: { from: "login", path: "code", equals: 0 } }],
    auth: { mode: "engine" },
  };
  const digestFixture = {
    inputs: { origin: "https://example.test" },
    responses: [{ status: 200, body: { code: 0 } }],
    expect: { success: true, requests: [{ url: "https://example.test/digest", method: "POST", headers: { "X-Digest": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }, body: "{}" }] },
  };
  assert.equal((await simulateLoginSpec(digestSpec, digestFixture)).status, "PASS");

  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  for (const algorithm of ["rsa-pkcs1v15", "rsa-oaep"]) {
    const spec = { version: 2, ops: [{ op: "crypto.encrypt", algorithm, publicKey: "{publicKey}", input: "{password}", as: "encrypted" }], success: [{ token: { from: "encrypted", path: "" } }], auth: { mode: "engine" } };
    const fixture = { inputs: { publicKey, password: "fixture-password" }, responses: [], expect: { success: true } };
    const result = await simulateLoginSpec(spec, fixture);
    assert.equal(result.status, "PASS", `${algorithm}: ${JSON.stringify(result)}`);
  }
});

test("malformed RSA returns RSA_ENCRYPT_ERROR without leaking inputs", async () => {
  const spec = { version: 2, ops: [{ op: "crypto.encrypt", algorithm: "rsa-oaep", publicKey: "{publicKey}", input: "{password}", as: "encrypted" }], success: [{ token: { from: "encrypted", path: "" } }], auth: { mode: "engine" } };
  const fixture = { inputs: { publicKey: "not-a-key", password: "fixture-password" }, responses: [], expect: { success: false, errorCode: "RSA_ENCRYPT_ERROR" } };
  const result = await simulateLoginSpec(spec, fixture);
  assert.equal(result.status, "PASS", JSON.stringify(result));
  assert.ok(!JSON.stringify(result.issues).includes("fixture-password"));
});

test("page behavior is NOT_SIMULATED and CLI exits 2", async () => {
  const spec = { version: 2, ops: [{ op: "goto", url: "{origin}/login" }, { op: "fill", target: "#u", value: "{username}" }, { op: "click", target: "#login" }, { op: "auth.write" }], success: [{ page: { type: "urlChanged" } }], auth: { mode: "page" } };
  const fixture = await readJson("fixtures/behavior/page-unsupported.json");
  const result = await simulateLoginSpec(spec, fixture);
  assert.equal(result.status, "NOT_SIMULATED");
  assert.deepEqual(result.requests, []);
  const dir = await mkdtemp(join(tmpdir(), "shadekit-skill-sim-"));
  const specPath = join(dir, "page.json");
  const fixturePath = join(dir, "fixture.json");
  await import("node:fs/promises").then(({ writeFile }) => Promise.all([writeFile(specPath, JSON.stringify(spec)), writeFile(fixturePath, JSON.stringify(fixture))]));
  const cli = fileURLToPath(new URL("./simulate.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "--spec", specPath, "--fixture", fixturePath], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 2, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, "NOT_SIMULATED");
});

test("evaluation records do not disclose local absolute paths", async () => {
  for (const file of ["evaluations/baseline.md", "evaluations/isolation.md"]) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]Users[\\/]|\/home\/[^/]+\/|\/cygdrive\//, file);
  }
});

test("package and validation CLIs work from another cwd", async () => {
  const spec = fileURLToPath(new URL("../fixtures/valid/api-gated.json", import.meta.url));
  const pkg = fileURLToPath(new URL("../fixtures/valid/dt-login-config.json", import.meta.url));
  const packageCli = fileURLToPath(new URL("./package.mjs", import.meta.url));
  const validateCli = fileURLToPath(new URL("./validate.mjs", import.meta.url));
  const cwd = await mkdtemp(join(tmpdir(), "shadekit-skill-cli-"));
  const out = join(cwd, "package.json");
  const built = spawnSync(process.execPath, [packageCli, "--spec", spec, "--name", "Example", "--url", "{origin}", "--out", out], { cwd, encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(JSON.parse(await readFile(out, "utf8")).format, "dt-login-config/v1");
  const valid = spawnSync(process.execPath, [validateCli, "--spec", spec, "--package", pkg], { cwd, encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).status, "SNAPSHOT_STATIC_VALIDATED");
  const badSpec = fileURLToPath(new URL("../fixtures/invalid/session-ungated.json", import.meta.url));
  const invalid = spawnSync(process.execPath, [validateCli, "--spec", badSpec, "--package", pkg], { cwd, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.ok(invalid.stdout.includes("AUTH_SESSION_UNGATED") || invalid.stdout.includes("environments[0].spec"));
});
