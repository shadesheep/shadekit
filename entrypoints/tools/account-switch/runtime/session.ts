import { ErrorCodes, LoginError } from "../utils/error-codes";
import { originMatches } from "../utils/env";
import { clearHostCookies } from "./host-cookies";
import type { AuthRange } from "../page-agent/types";
import { readBindingPath, resolveTemplate, TemplateError } from "../spec/template";
import type { AuthSpec, CookieWrite, StorageWrite } from "../spec/types";
import type { HostBridge, PagePort, SessionPort } from "./host";

export interface ClearCookiesOp {
  range: AuthRange;
  includeParent?: boolean;
}

export async function runClearCookies(
  session: SessionPort,
  origin: string,
  op: ClearCookiesOp,
): Promise<number> {
  if (op.range === "none") return 0;
  return clearHostCookies(session, origin, {
    ...(op.range === "all" ? {} : { names: op.range }),
    includeParent: op.includeParent === true,
  });
}

export interface ClearStorageOp {
  area: "local" | "session";
  range: AuthRange;
}

export async function runClearStorage(page: PagePort, op: ClearStorageOp): Promise<void> {
  if (op.range === "none") return;
  await page.execute({
    action: "storage.clear",
    area: op.area,
    keys: op.range === "all" ? null : op.range,
  });
}

export interface AuthWriteState {
  inputs: Record<string, unknown>;
  bindings: Record<string, unknown>;
}

export async function assertPageOnOrigin(page: PagePort, origin: string): Promise<void> {
  const url = await page.currentUrl();
  if (!originMatches(origin, url)) {
    throw new LoginError(
      ErrorCodes.INJECT_AUTH_FAILED,
      `无法写入认证数据：页面不在目标站点 (${origin})，当前为 ${url || "未知"}。` +
        "localStorage 属于 origin 作用域，必须先导航到目标站点再写入",
    );
  }
}

function cookieUrl(origin: string, write: Pick<CookieWrite, "domain" | "path">): string {
  const hostname = new URL(origin).hostname;
  const domain = write.domain ? write.domain.replace(/^\./, "") : hostname;
  const path = write.path ?? "/";
  const secure = new URL(origin).protocol === "https:";
  return `http${secure ? "s" : ""}://${domain}${path}`;
}

function resolveExpiration(ctx: AuthWriteState, write: CookieWrite): number | undefined {
  if (!write.expiresFrom) return undefined;
  const { from, path, unit } = write.expiresFrom;
  const { found, value } = readBindingPath(ctx.bindings[from], path);
  if (!found) {
    throw new LoginError(
      ErrorCodes.LOGIN_REJECTED,
      `cookie "${write.name}" 的过期时间来源 $${from}.${path} 不存在`,
    );
  }
  const raw = value as number;
  switch (unit) {
    case "epochMs": return raw / 1000;
    case "epochS": return raw;
    case "iso": {
      const ms = new Date(String(value)).getTime();
      if (Number.isNaN(ms)) {
        throw new LoginError(ErrorCodes.LOGIN_REJECTED, `cookie "${write.name}" 的过期时间无法解析（${String(value)}）`);
      }
      return ms / 1000;
    }
    case "relativeSeconds": return Math.floor(Date.now() / 1000) + Number(value);
  }
}

function resolveWriteValue(ctx: AuthWriteState, template: string): string {
  try {
    return resolveTemplate(template, ctx);
  } catch (error) {
    if (error instanceof TemplateError) {
      throw new LoginError(
        error.code === "TEMPLATE_UNRESOLVED" ? ErrorCodes.TEMPLATE_UNRESOLVED : ErrorCodes.CONFIG_INVALID,
        error.message,
      );
    }
    throw error;
  }
}

async function writeCookie(
  session: SessionPort,
  ctx: AuthWriteState,
  write: CookieWrite,
  origin: string,
): Promise<void> {
  const value = resolveWriteValue(ctx, write.value);
  const secure = write.secure === undefined || write.secure === "auto"
    ? new URL(origin).protocol === "https:"
    : write.secure;
  const expirationDate = resolveExpiration(ctx, write);
  await session.setCookie({
    url: cookieUrl(origin, write),
    name: write.name,
    value,
    secure,
    path: write.path ?? "/",
    ...(typeof write.domain === "string" ? { domain: write.domain } : {}),
    ...(write.httpOnly !== undefined ? { httpOnly: write.httpOnly } : {}),
    ...(write.sameSite && write.sameSite !== "unspecified" ? { sameSite: write.sameSite } : {}),
    ...(expirationDate !== undefined ? { expirationDate } : {}),
  });
}

async function writeStorage(
  page: PagePort,
  area: "local" | "session",
  entries: StorageWrite[],
  state: AuthWriteState,
): Promise<void> {
  if (entries.length === 0) return;
  const data: Record<string, string> = {};
  for (const entry of entries) data[entry.key] = resolveWriteValue(state, entry.value);
  await page.execute({ action: "storage.write", area, entries: data });
}

export async function runAuthWrite(
  host: HostBridge,
  origin: string,
  auth: AuthSpec,
  state: AuthWriteState,
): Promise<void> {
  if (auth.mode === "page") return;
  if (host.page) await assertPageOnOrigin(host.page, origin);
  const session = host.session;
  if (!session) throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, "auth.write 缺少 SessionPort");
  for (const write of auth.cookiesWrite ?? []) await writeCookie(session, state, write, origin);

  const local = auth.localStorageWrite ?? [];
  const sessionWrites = auth.sessionStorageWrite ?? [];
  if (local.length > 0 || sessionWrites.length > 0) {
    if (!host.page) throw new LoginError(ErrorCodes.HOST_CAPABILITY_MISSING, "Storage 写入缺少 PagePort");
    await assertPageOnOrigin(host.page, origin);
  }
  if (host.page && local.length > 0) await writeStorage(host.page, "local", local, state);
  if (host.page && sessionWrites.length > 0) await writeStorage(host.page, "session", sessionWrites, state);
}
