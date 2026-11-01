import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceImports(...roots: string[]): string[] {
  const imports: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".output")) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (/\.(?:ts|vue)$/.test(entry.name)) {
        const source = readFileSync(child, "utf8");
        for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)) {
          imports.push(match[1]);
        }
      }
    }
  };
  for (const root of roots) visit(root);
  return imports;
}

const read = (...parts: string[]): string =>
  readFileSync(new URL(`../${parts.join("/")}`, import.meta.url), "utf8");

const packageJson = JSON.parse(read("package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function backgroundMessageKeys(): string[] {
  const source = read("entrypoints", "shared", "messages.ts");
  const start = source.indexOf("export interface BackgroundMessageMap");
  const end = source.indexOf("export type BackgroundMessageType");
  const mapBody = source.slice(start, end);
  return [...mapBody.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{/gm)].map((match) => match[1]!);
}

const BackgroundMessageMapKeys = backgroundMessageKeys();
const panelSource = read("entrypoints", "tools", "account-switch", "SwitcherPanel.vue");

describe("extension-local login engine boundary", () => {
  it("contains no shared declaration, runtime, or page-agent import", () => {
    const imports = sourceImports("entrypoints", "tests");
    expect(
      imports.filter((name) =>
        /^@shadekit\/login-engine\/(spec|runtime|page-agent|protocol|tokens)(\/|$)/.test(name),
      ),
    ).toEqual([]);
  });

  it("exposes no master-password, lock, reset, resume, or shared-engine surface", () => {
    for (const type of [
      "VAULT_ENABLE_MASTER",
      "VAULT_CHANGE_MASTER",
      "VAULT_DISABLE_MASTER",
      "VAULT_UNLOCK",
      "VAULT_CANCEL_INTENT",
      "VAULT_LOCK",
      "VAULT_RESET",
      "VAULT_GET_STATUS",
    ]) {
      expect(BackgroundMessageMapKeys).not.toContain(type);
    }
    expect(BackgroundMessageMapKeys).toEqual(
      expect.arrayContaining(["VAULT_PUT_SECRET", "VAULT_PREPARE_BACKUP", "VAULT_CONFIRM_BACKUP"]),
    );
    expect(panelSource).not.toContain("data-master-password");
    expect(sourceImports("entrypoints", "tests").filter((name) => name.startsWith("@shadekit/login-engine/")))
      .toEqual([]);
    expect(packageJson.dependencies?.["@shadekit/login-engine"]).toBeUndefined();
    expect(packageJson.devDependencies?.["@shadekit/login-engine"]).toBeUndefined();
    expect(packageJson.optionalDependencies?.["@shadekit/login-engine"]).toBeUndefined();
  });

  it("retains no PBKDF2 or backup-envelope crypto surface", () => {
    const securitySources = readdirSync("entrypoints/shared/security")
      .filter((name) => /\.ts$/.test(name))
      .map((name) => readFileSync(join("entrypoints/shared/security", name), "utf8"))
      .join("\n");
    expect(securitySources).not.toContain("PBKDF2");
    expect(securitySources).not.toContain("BackupKdf");
  });
});
