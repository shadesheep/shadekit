import { SecurityError } from "./errors";
import { VAULT_FORMAT, type VaultRecord } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function generateDek(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function generateWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

export function importDek(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapDek(
  raw: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = raw.slice();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      material,
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    const wrapped = await crypto.subtle.wrapKey("raw", key, kek, { name: "AES-KW" });
    return new Uint8Array(wrapped);
  } finally {
    material.fill(0);
  }
}

export async function unwrapDek(
  wrapped: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
): Promise<CryptoKey> {
  try {
    return await crypto.subtle.unwrapKey(
      "raw",
      wrapped,
      kek,
      { name: "AES-KW" },
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new SecurityError("VAULT_AUTH_FAILED", "保险库密钥认证失败");
  }
}

function vaultAad(credentialId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`shadekit/vault/v1/account-switch/${credentialId}`);
}

export async function encryptSecret(
  dek: CryptoKey,
  credentialId: string,
  plaintext: string,
): Promise<VaultRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: vaultAad(credentialId), tagLength: 128 },
    dek,
    encoder.encode(plaintext),
  );
  return {
    format: VAULT_FORMAT,
    credentialId,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptSecret(
  dek: CryptoKey,
  record: VaultRecord,
): Promise<string> {
  try {
    if (record.format !== VAULT_FORMAT || !record.credentialId) {
      throw new Error("invalid record");
    }
    const iv = decodeBase64(record.iv);
    if (iv.length !== 12) throw new Error("invalid iv");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: vaultAad(record.credentialId),
        tagLength: 128,
      },
      dek,
      decodeBase64(record.ciphertext),
    );
    return decoder.decode(plaintext);
  } catch {
    throw new SecurityError("VAULT_AUTH_FAILED", "保险库记录认证或解密失败");
  }
}

export type { VaultRecord } from "./types";
