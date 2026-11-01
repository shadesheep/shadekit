import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeBase64,
  decryptSecret,
  encryptSecret,
  importDek,
} from "../entrypoints/shared/security/crypto";
import type { VaultRecord } from "../entrypoints/shared/security/types";
import { prepareSecretReferences } from "../entrypoints/tools/account-switch/secret-migration";
import type { AccountSwitchConfig } from "../entrypoints/tools/account-switch/types";

const vectors = JSON.parse(readFileSync(
  new URL("../docs/spikes/0021-login-security-h0/fixtures/h1-security-vectors.json", import.meta.url),
  "utf8",
)) as {
  vault: { plaintext: string; dek: string; iv: string; record: VaultRecord };
  migration: { source: AccountSwitchConfig; expectedRefs: Record<string, string> };
};

afterEach(() => vi.restoreAllMocks());

describe("H1 固定安全测试向量", () => {
  it("vault/v1 与独立 Web Crypto 计算逐字节一致", async () => {
    const dek = await importDek(decodeBase64(vectors.vault.dek));
    await expect(decryptSecret(dek, vectors.vault.record)).resolves.toBe(vectors.vault.plaintext);
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.set(decodeBase64(vectors.vault.iv));
      return array;
    });
    await expect(encryptSecret(dek, vectors.vault.record.credentialId, vectors.vault.plaintext))
      .resolves.toEqual(vectors.vault.record);
    await expect(decryptSecret(dek, { ...vectors.vault.record, credentialId: "account:other" }))
      .rejects.toMatchObject({ code: "VAULT_AUTH_FAILED" });
  });

  it("迁移向量生成稳定引用且普通配置不保留秘密", () => {
    const prepared = prepareSecretReferences(vectors.migration.source);
    expect(prepared.config.accounts[0]?.credentialRef).toBe(vectors.migration.expectedRefs.account);
    expect(prepared.config.domains["https://fixed.example.com"]?.defaultCredentialRef)
      .toBe(vectors.migration.expectedRefs.environment);
    expect(prepared.config.globalDefaultCredentialRef).toBe(vectors.migration.expectedRefs.global);
    expect(JSON.stringify(prepared.config)).not.toMatch(/H1-MIGRATION-SECRET|H1-ENV-SECRET|H1-GLOBAL-SECRET/);
  });
});
