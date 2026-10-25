import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLoginSpec } from "../entrypoints/tools/account-switch/spec/validate";
import { buildConfigPackage, validateConfigPackage } from "../entrypoints/tools/account-switch/spec/package";
import { validateLoginSpecSnapshot } from "../docs/skills/authoring-shadekit-login-specs/scripts/login-spec-validator.mjs";
import { buildConfigPackageSnapshot, validateConfigPackageSnapshot } from "../docs/skills/authoring-shadekit-login-specs/scripts/config-package.mjs";
import { verifyWithRepository, verificationStatus } from "../docs/skills/authoring-shadekit-login-specs/scripts/repo-verify";

const root = new URL("../docs/skills/authoring-shadekit-login-specs/", import.meta.url);
const fixture = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const rules = (issues: Array<{ rule?: string; opIndex?: number }>) => issues.map(({ rule, opIndex }) => ({ rule, opIndex }));

describe("standalone LoginSpec snapshot parity", () => {
  it("matches official validation for the valid fixture", async () => {
    const spec = await fixture("fixtures/valid/api-gated.json");
    expect(validateLoginSpecSnapshot(spec)).toEqual([]);
    expect(validateLoginSpec(spec)).toEqual([]);
    const pkg = await fixture("fixtures/valid/dt-login-config.json");
    expect(validateConfigPackageSnapshot(pkg)).toEqual([]);
    expect(validateConfigPackage(pkg)).toEqual([]);
  });

  it.each([
    "r1-success-after-write.json",
    "r2-missing-binding.json",
    "r3-restore-without-goto.json",
    "r4-unknown-input.json",
    "r5-duplicate-binding.json",
    "r6-dangling-apply.json",
    "r7-empty-any-of.json",
  ])("matches official rules for %s", async (file) => {
    const spec = await fixture(`fixtures/invalid/${file}`);
    expect(rules(validateLoginSpecSnapshot(spec))).toEqual(rules(validateLoginSpec(spec)));
  });

  it("matches the official package builder including requiredVars", async () => {
    const spec = await fixture("fixtures/valid/api-gated.json");
    spec.vars.push({ name: "tenant", title: "Tenant" });
    spec.ops[0].parts.push({ key: "tenant", value: "{tenant}" });
    const snapshot = buildConfigPackageSnapshot({ spec, name: "Example", url: "{origin}" });
    const official = buildConfigPackage({ name: "Example", tags: [], strategyConfig: { spec } }, "{origin}", ["tenant"]);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.package).toEqual(official.package);
  });
});

describe("repository verification states", () => {
  it("returns REPO_VERIFIED for the current checkout", async () => {
    const result = await verifyWithRepository({
      repo: process.cwd(),
      spec: await fixture("fixtures/valid/api-gated.json"),
      package: await fixture("fixtures/valid/dt-login-config.json"),
    });
    expect(result.status).toBe("REPO_VERIFIED");
    expect(result.differences).toEqual([]);
  });

  it("returns NOT_RUN for a missing repository", async () => {
    const result = await verifyWithRepository({ repo: join(tmpdir(), "definitely-no-shadekit-repo"), spec: {}, package: {} });
    expect(result.status).toBe("NOT_RUN");
    expect(JSON.stringify(result)).not.toContain('"status":"REPO_VERIFIED"');
  });

  it("returns NOT_RUN when repository dependencies are missing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "shadekit-no-deps-"));
    await mkdir(join(repo, "entrypoints/tools/account-switch/spec"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "shadekit" }));
    await writeFile(join(repo, "entrypoints/tools/account-switch/spec/validate.ts"), "");
    await writeFile(join(repo, "entrypoints/tools/account-switch/spec/package.ts"), "");
    const result = await verifyWithRepository({ repo, spec: {}, package: {} });
    expect(result.status).toBe("NOT_RUN");
  });

  it("returns FAILED for official rejection and for snapshot/current disagreement", async () => {
    const spec = await fixture("fixtures/valid/api-gated.json");
    const pkg = await fixture("fixtures/valid/dt-login-config.json");
    pkg.environments[0].spec.ops[2].cases[0].equals = 99;
    const officialFailure = await verifyWithRepository({ repo: process.cwd(), spec, package: pkg });
    expect(officialFailure.status).toBe("FAILED");
    expect(verificationStatus({ snapshotFailed: false, officialFailed: false, differences: ["forced difference"] })).toBe("FAILED");
    expect(verificationStatus({ snapshotFailed: false, officialFailed: false, differences: [] })).toBe("REPO_VERIFIED");
  });
});
