import type { CookieRecord } from "./host";
import { captureHostCookies, clearHostCookies } from "./host-cookies";
import { ErrorCodes, LoginError } from "../utils/error-codes";
import type { AuthRange } from "../page-agent/types";
import type { SpecOp } from "../spec/types";
import type { HostBridge, PagePort } from "./host";
import { assertPageOnOrigin } from "./session";

export type AuthCaptureOp = Extract<SpecOp, { op: "auth.capture" }>;
export type AuthRestoreOp = Extract<SpecOp, { op: "auth.restore" }>;

export interface CapturedSnapshot {
  origin: string;
  cookies: CookieRecord[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

function storageKeys(range: AuthRange): string[] | null | undefined {
  if (range === "none") return undefined;
  return range === "all" ? null : range;
}

async function readStorage(
  page: PagePort,
  area: "local" | "session",
  keys: string[] | null,
): Promise<Record<string, string>> {
  const results = await page.execute({ action: "storage.read", area, keys });
  return (results[0]?.result as Record<string, string>) ?? {};
}

export async function runAuthCapture(
  host: HostBridge,
  origin: string,
  op: AuthCaptureOp,
): Promise<CapturedSnapshot> {
  if (!host.page || !host.session) {
    throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, "auth.capture 缺少 PagePort 或 SessionPort");
  }
  const cookiesRange = op.cookies ?? "none";
  const snapshot: CapturedSnapshot = {
    origin,
    cookies: cookiesRange === "none"
      ? []
      : await captureHostCookies(host.session, origin, cookiesRange === "all" ? undefined : cookiesRange),
  };
  const localKeys = storageKeys(op.localStorage ?? "none");
  if (localKeys !== undefined) snapshot.localStorage = await readStorage(host.page, "local", localKeys);
  const sessionKeys = storageKeys(op.sessionStorage ?? "none");
  if (sessionKeys !== undefined) snapshot.sessionStorage = await readStorage(host.page, "session", sessionKeys);
  return snapshot;
}

export async function runAuthRestore(host: HostBridge, snapshot: CapturedSnapshot, targetOrigin = snapshot.origin): Promise<void> {
  if (!host.page || !host.session) {
    throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, "auth.restore 缺少 PagePort 或 SessionPort");
  }
  const { origin } = snapshot;
  await assertPageOnOrigin(host.page, targetOrigin);
  const cookieNames = snapshot.cookies.map((cookie) => cookie.name);
  if (cookieNames.length > 0) await clearHostCookies(host.session, origin, { names: cookieNames });

  for (const cookie of snapshot.cookies) {
    await host.session.setCookie({
      url: `${cookie.secure ? "https" : "http"}://${origin.replace(/^https?:\/\//, "").replace(/\/$/, "")}${cookie.path ?? "/"}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(!cookie.session && cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
    });
  }
  if (snapshot.localStorage !== undefined) {
    await host.page.execute({ action: "storage.clear", area: "local", keys: Object.keys(snapshot.localStorage) });
    await host.page.execute({ action: "storage.write", area: "local", entries: snapshot.localStorage });
  }
  if (snapshot.sessionStorage !== undefined) {
    await host.page.execute({ action: "storage.clear", area: "session", keys: Object.keys(snapshot.sessionStorage) });
    await host.page.execute({ action: "storage.write", area: "session", entries: snapshot.sessionStorage });
  }
}

export function isCapturedSnapshot(value: unknown): value is CapturedSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.origin !== "string") return false;
  if (!Array.isArray(candidate.cookies)) return false;
  if (candidate.localStorage !== undefined && (typeof candidate.localStorage !== "object" || candidate.localStorage === null)) {
    return false;
  }
  if (candidate.sessionStorage !== undefined && (typeof candidate.sessionStorage !== "object" || candidate.sessionStorage === null)) {
    return false;
  }
  return true;
}
