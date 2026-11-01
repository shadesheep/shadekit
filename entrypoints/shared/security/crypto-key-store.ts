import { SecurityError } from "./errors";

const DB_NAME = "shadekit-account-switch-vault";
const STORE_NAME = "keys";
const KEK_ID = "primary-kek";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new SecurityError("VAULT_UNAVAILABLE", "当前平台无法持久化保险库密钥"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

async function withKeyStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  try {
    const db = await openDatabase();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => {
        db.close();
        resolve(result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error);
      };
    });
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    throw new SecurityError("VAULT_UNAVAILABLE", "保险库密钥存储不可用");
  }
}

export function loadVaultKek(): Promise<CryptoKey | undefined> {
  return withKeyStore("readonly", (store) => store.get(KEK_ID) as IDBRequest<CryptoKey | undefined>);
}

export async function saveVaultKek(kek: CryptoKey): Promise<void> {
  await withKeyStore("readwrite", (store) => store.put(kek, KEK_ID));
}
