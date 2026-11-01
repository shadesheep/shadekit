const DB_NAME = "shadekit-h0-key-spike";
const STORE_NAME = "keys";
const KEY_ID = "primary-kek";
const WRAPPED_DEK_KEY = "h0-wrapped-dek";
const INSTANCE_ID = crypto.randomUUID();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withKeyStore(mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

const getKek = () => withKeyStore("readonly", (store) => store.get(KEY_ID));
const putKek = (key) => withKeyStore("readwrite", (store) => store.put(key, KEY_ID));
const deleteKek = () => withKeyStore("readwrite", (store) => store.delete(KEY_ID));

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

async function unwrapDek(kek, wrapped) {
  return crypto.subtle.unwrapKey(
    "raw",
    new Uint8Array(wrapped),
    kek,
    { name: "AES-KW" },
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function probeVault() {
  try {
    let kek = await getKek();
    const stored = await chrome.storage.local.get(WRAPPED_DEK_KEY);
    let wrapped = stored[WRAPPED_DEK_KEY];
    if (!kek && wrapped) {
      return { ok: false, code: "VAULT_UNAVAILABLE", plaintextFallback: false };
    }
    if (!kek) {
      kek = await crypto.subtle.generateKey(
        { name: "AES-KW", length: 256 },
        false,
        ["wrapKey", "unwrapKey"],
      );
      await putKek(kek);
    }
    if (!wrapped) {
      const transientDek = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const wrappedBuffer = await crypto.subtle.wrapKey("raw", transientDek, kek, { name: "AES-KW" });
      wrapped = Array.from(new Uint8Array(wrappedBuffer));
      await chrome.storage.local.set({ [WRAPPED_DEK_KEY]: wrapped });
    }
    const dek = await unwrapDek(kek, wrapped);
    const iv = new Uint8Array(12);
    const plaintext = new TextEncoder().encode("h0-round-trip");
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dek, plaintext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, dek, encrypted);
    let exportBlocked = false;
    try {
      await crypto.subtle.exportKey("raw", kek);
    } catch {
      exportBlocked = true;
    }
    const wrappedDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(wrapped))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      ok: true,
      instanceId: INSTANCE_ID,
      keyType: kek.type,
      algorithm: kek.algorithm.name,
      extractable: kek.extractable,
      exportBlocked,
      dekExtractable: dek.extractable,
      wrappedBytes: wrapped.length,
      wrappedDigest,
      challengeRoundTrip: new TextDecoder().decode(decrypted) === "h0-round-trip",
      plaintextFallback: false,
    };
  } catch {
    return { ok: false, code: "VAULT_UNAVAILABLE", plaintextFallback: false };
  }
}

async function executeHttp(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
    });
    const buffer = await response.arrayBuffer();
    return {
      kind: "response",
      status: response.status,
      finalUrl: response.url,
      redirected: response.redirected,
      headers: Array.from(response.headers.entries()),
      setCookies: response.headers.getSetCookie?.() ?? [],
      text: new TextDecoder("utf-8").decode(buffer),
      bodyBase64: bytesToBase64(new Uint8Array(buffer)),
    };
  } catch {
    const timedOut = controller.signal.aborted;
    return {
      kind: "error",
      code: timedOut ? "HTTP_TIMEOUT" : "HTTP_TRANSPORT_ERROR",
      cause: timedOut ? "timeout" : "unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const work = (async () => {
    if (message.type === "probe") return probeVault();
    if (message.type === "forget-key") {
      await deleteKek();
      return { ok: true };
    }
    if (message.type === "http") return executeHttp(message.request);
    if (message.type === "cookie-names") {
      const cookies = await chrome.cookies.getAll({ url: message.url });
      return cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        session: cookie.session,
        hostOnly: cookie.hostOnly,
        expirationDate: cookie.expirationDate,
      }));
    }
    return { ok: false, code: "UNKNOWN_SPIKE_MESSAGE" };
  })();
  work.then(sendResponse).catch(() => sendResponse({ ok: false, code: "SPIKE_INTERNAL_ERROR" }));
  return true;
});
