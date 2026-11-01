import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateDek,
  generateWrappingKey,
  importDek,
  unwrapDek,
  wrapDek,
} from "../entrypoints/shared/security/crypto";
import type { VaultRecord } from "../entrypoints/shared/security/types";

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function testDek(): Promise<CryptoKey> {
  return importDek(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
}

describe("shadekit-vault/v1 密码学原语", () => {
  it("支持空、Unicode 与长秘密的完整往返，且记录不包含明文", async () => {
    const dek = await testDek();
    for (const plaintext of ["", "密码🔐\n".repeat(100), "token-91"]) {
      const record = await encryptSecret(dek, "cred-A", plaintext);
      expect(Object.keys(record).sort()).toEqual(["ciphertext", "credentialId", "format", "iv"]);
      expect(record.format).toBe("shadekit-vault/v1");
      expect(JSON.stringify(record)).not.toContain(plaintext || "unreachable");
      expect(await decryptSecret(dek, record)).toBe(plaintext);
    }
  });

  it("相同秘密每次使用独立的 96-bit IV", async () => {
    const dek = await testDek();
    const a = await encryptSecret(dek, "cred-A", "same");
    const b = await encryptSecret(dek, "cred-A", "same");
    expect(decode(a.iv)).toHaveLength(12);
    expect(decode(b.iv)).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("AAD 绑定不可变 credential ID，复制到其他 ID 后认证失败", async () => {
    const dek = await testDek();
    const record = await encryptSecret(dek, "cred-A", "SAVED-PASSWORD-91");
    const copied: VaultRecord = { ...record, credentialId: "cred-B" };
    await expect(decryptSecret(dek, copied)).rejects.toMatchObject({ code: "VAULT_AUTH_FAILED" });
  });

  it("拒绝密文、IV 和格式篡改", async () => {
    const dek = await testDek();
    const record = await encryptSecret(dek, "cred-A", "SAVED-PASSWORD-91");
    const ciphertext = decode(record.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    const tamperedCiphertext = { ...record, ciphertext: btoa(String.fromCharCode(...ciphertext)) };
    const iv = decode(record.iv);
    iv[0] = (iv[0] ?? 0) ^ 1;
    const tamperedIv = { ...record, iv: btoa(String.fromCharCode(...iv)) };
    for (const tampered of [
      tamperedCiphertext,
      tamperedIv,
      { ...record, format: "shadekit-vault/v2" },
    ]) {
      await expect(decryptSecret(dek, tampered as VaultRecord)).rejects.toMatchObject({
        code: "VAULT_AUTH_FAILED",
      });
    }
  });

  it("生成 256-bit DEK，并用不可提取 AES-KW 密钥包装后恢复不可提取 DEK", async () => {
    const raw = generateDek();
    expect(raw).toHaveLength(32);
    expect(generateDek()).not.toEqual(raw);
    const kek = await generateWrappingKey();
    expect(kek.extractable).toBe(false);
    expect(kek.algorithm.name).toBe("AES-KW");
    const wrapped = await wrapDek(raw, kek);
    expect(wrapped).toHaveLength(40);
    const dek = await unwrapDek(wrapped, kek);
    expect(dek.extractable).toBe(false);
    const record = await encryptSecret(dek, "cred-wrap", "wrapped-secret");
    expect(await decryptSecret(dek, record)).toBe("wrapped-secret");
    const otherKek = await generateWrappingKey();
    await expect(unwrapDek(wrapped, otherKek)).rejects.toMatchObject({ code: "VAULT_AUTH_FAILED" });
  });
});
