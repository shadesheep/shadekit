import {
  decodeBase64,
  decryptSecret,
  encodeBase64,
  encryptSecret,
  generateDek,
  generateWrappingKey,
  unwrapDek,
  wrapDek,
} from "./crypto";
import { loadVaultKek, saveVaultKek } from "./crypto-key-store";
import { SecurityError } from "./errors";
import type { VaultRecord } from "./types";

export const VAULT_STORAGE_KEY = "devtools-account-switch-vault";
export const VAULT_META_KEY = "devtools-account-switch-vault-meta";
export const MIGRATION_RECOVERY_KEY = "devtools-account-switch-migration-recovery";
export const IMPORT_JOURNAL_KEY = "devtools-account-switch-import-journal";
const VAULT_LOCK = "devtools-lock-account-switch-vault";

/** 只保留无感模式：元数据不含任何用户输入的密钥材料。 */
interface SeamlessVaultMeta {
  mode: "seamless";
  wrappedDek: string;
}

let memoryDek: CryptoKey | undefined;
/**
 * 与 memoryDek 同时缓存的 wrappedDek 指纹。
 *
 * 导入回滚等恢复路径可能直接改写/删除 VAULT_META_KEY；只缓存 CryptoKey
 * 而不校验它仍属于当前元数据，后续写入就会加密在一份已不存在的 DEK 下，
 * 重启后永远无法解开。因此每次使用缓存前都对比指纹。
 */
let memoryDekFingerprint: string | undefined;

async function withVaultLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? locks.request(VAULT_LOCK, operation) : operation();
}

async function readMeta(): Promise<unknown> {
  const result = await chrome.storage.local.get([VAULT_META_KEY]);
  return result[VAULT_META_KEY];
}

async function writeMeta(meta: SeamlessVaultMeta): Promise<void> {
  await chrome.storage.local.set({ [VAULT_META_KEY]: meta });
}

async function readRecords(): Promise<Record<string, VaultRecord>> {
  const result = await chrome.storage.local.get([VAULT_STORAGE_KEY]);
  return (result[VAULT_STORAGE_KEY] as Record<string, VaultRecord> | undefined) ?? {};
}

async function writeRecords(records: Record<string, VaultRecord>): Promise<void> {
  await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: records });
}

function seamlessMetaOf(value: unknown): SeamlessVaultMeta | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { mode?: unknown }).mode === "seamless" &&
    typeof (value as { wrappedDek?: unknown }).wrappedDek === "string"
  ) {
    return value as SeamlessVaultMeta;
  }
  return undefined;
}

/**
 * 旧主密码模式或任何未知元数据只报不可用：绝不静默转换、改写或删除用户数据。
 */
function requireSeamlessMeta(value: unknown): SeamlessVaultMeta {
  const meta = seamlessMetaOf(value);
  if (meta) return meta;
  throw new SecurityError("VAULT_UNAVAILABLE", "保险库元数据不可用");
}

async function createSeamlessMeta(): Promise<SeamlessVaultMeta> {
  const rawDek = generateDek();
  try {
    const kek = (await loadVaultKek()) ?? await generateWrappingKey();
    const wrappedDek = await wrapDek(rawDek, kek);
    await saveVaultKek(kek);
    return { mode: "seamless", wrappedDek: encodeBase64(wrappedDek) };
  } finally {
    rawDek.fill(0);
  }
}

async function seamlessDek(meta: SeamlessVaultMeta): Promise<CryptoKey> {
  let kek: CryptoKey | undefined;
  try {
    kek = await loadVaultKek();
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError("VAULT_UNAVAILABLE", "无感保险库密钥不可用");
  }
  if (!kek) throw new SecurityError("VAULT_UNAVAILABLE", "无感保险库密钥不可用");
  return unwrapDek(decodeBase64(meta.wrappedDek), kek);
}

/** 读取记录前也拒绝旧/未知元数据，避免把主密码保险库静默当成空库或清理其密文。 */
async function assertVaultReadable(): Promise<void> {
  const stored = await readMeta();
  if (stored !== undefined) requireSeamlessMeta(stored);
}

function cachedDekFor(meta: SeamlessVaultMeta | undefined): CryptoKey | undefined {
  if (!memoryDek || memoryDekFingerprint === undefined) return undefined;
  return meta?.wrappedDek === memoryDekFingerprint ? memoryDek : undefined;
}

async function adoptDek(meta: SeamlessVaultMeta): Promise<CryptoKey> {
  const dek = await seamlessDek(meta);
  memoryDek = dek;
  memoryDekFingerprint = meta.wrappedDek;
  return dek;
}

/** 调用方必须已持有 vault 锁（避免首次创建元数据时并发生成两套 DEK/KEK）。 */
async function currentDekUnlocked(): Promise<CryptoKey> {
  const stored = await readMeta();
  if (stored === undefined) {
    const meta = await createSeamlessMeta();
    await writeMeta(meta);
    return adoptDek(meta);
  }
  const meta = requireSeamlessMeta(stored);
  return cachedDekFor(meta) ?? adoptDek(meta);
}

async function currentDek(): Promise<CryptoKey> {
  // 快速路径也要先校验元数据身份：恢复路径可能已删除/替换元数据。
  const stored = await readMeta();
  if (stored !== undefined) {
    const cached = cachedDekFor(requireSeamlessMeta(stored));
    if (cached) return cached;
  }
  // 元数据/KEK 的首次创建必须在锁内完成，并在锁内重新读取：
  // 两个并发首次使用否则会各自生成 DEK/KEK，后写的元数据会让先写记录永久不可解。
  return withVaultLock(currentDekUnlocked);
}

/**
 * 清除内存中的 DEK 缓存。
 *
 * 恢复流程删除/替换保险库元数据后必须调用；测试也用它模拟 Service Worker
 * 内存丢失。不是可路由消息，也不暴露给页面。
 */
export function resetVaultState(): void {
  memoryDek = undefined;
  memoryDekFingerprint = undefined;
}

/** 仅供测试模拟 Service Worker 内存丢失；不是可路由消息，也不暴露给页面。 */
export function clearCachedDek(): void {
  resetVaultState();
}

export async function sealLocalPayload(
  credentialId: string,
  payload: unknown,
): Promise<VaultRecord> {
  return encryptSecret(await currentDek(), credentialId, JSON.stringify(payload));
}

export async function openLocalPayload(
  credentialId: string,
  record: unknown,
): Promise<unknown> {
  if (
    typeof record !== "object" || record === null ||
    (record as VaultRecord).credentialId !== credentialId
  ) {
    throw new SecurityError("VAULT_AUTH_FAILED", "保险库记录认证或解密失败");
  }
  const plaintext = await decryptSecret(await currentDek(), record as VaultRecord);
  return JSON.parse(plaintext) as unknown;
}

export async function putSecret(credentialId: string, plaintext: string): Promise<void> {
  await withVaultLock(async () => {
    // 锁内重新读取元数据：旧主密码/未知元数据必须先拒绝，不能沿用缓存 DEK
    // 写出一批重启后无法解密的记录。
    await assertVaultReadable();
    const dek = await currentDekUnlocked();
    const record = await encryptSecret(dek, credentialId, plaintext);
    const records = await readRecords();
    records[credentialId] = record;
    await writeRecords(records);
  });
}

export async function resolveSecret(credentialId: string): Promise<string | undefined> {
  await assertVaultReadable();
  const records = await readRecords();
  const record = records[credentialId];
  if (!record) return undefined;
  return decryptSecret(await currentDek(), record);
}

export async function hasSecret(credentialId: string): Promise<boolean> {
  await assertVaultReadable();
  return Boolean((await readRecords())[credentialId]);
}

export async function removeSecret(credentialId: string): Promise<void> {
  await withVaultLock(async () => {
    await assertVaultReadable();
    const records = await readRecords();
    if (!(credentialId in records)) return;
    delete records[credentialId];
    await writeRecords(records);
  });
}

export async function cleanupOrphanSecrets(referenced: ReadonlySet<string>): Promise<void> {
  await withVaultLock(async () => {
    await assertVaultReadable();
    const records = await readRecords();
    let changed = false;
    for (const credentialId of Object.keys(records)) {
      if (referenced.has(credentialId)) continue;
      delete records[credentialId];
      changed = true;
    }
    if (changed) await writeRecords(records);
  });
}
