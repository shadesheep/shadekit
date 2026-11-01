import type { LoginSpec, SpecOpName } from "../spec/types";
import type { DomAction } from "../page-agent/generic-target";

export interface LoginRunInput {
  spec: LoginSpec;
  inputs: {
    username: string;
    password: string;
    origin: string;
    targetUrl?: string;
    debugRedirect?: string;
    vars?: Record<string, string>;
  };
}

export interface HostCapabilities {
  specVersions: number[];
  ops: SpecOpName[];
  page: boolean;
  session: boolean;
  script: boolean;
}

export interface HttpRequestDto {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResponseDto {
  status: number;
  finalUrl: string;
  redirected: boolean;
  headers: Record<string, string>;
  text: string;
  bodyBase64?: string;
}

export interface HostErrorDto {
  code: "HTTP_TIMEOUT" | "HTTP_TRANSPORT_ERROR";
  reason?: "timeout" | "network" | "tls" | "unknown";
  message: string;
}

export interface HttpPort {
  execute(request: HttpRequestDto): Promise<HttpResponseDto>;
}

export type PageAgentCommand =
  | { action: "dom"; input: DomAction; frameId?: number }
  | { action: "scanLoginForm" }
  | { action: "storage.read"; area: "local" | "session"; keys: string[] | null; allFrames?: boolean }
  | { action: "storage.has"; area: "local" | "session"; key: string }
  | { action: "storage.write"; area: "local" | "session"; entries: Record<string, string> }
  | { action: "storage.clear"; area: "local" | "session"; keys: string[] | null };

export interface PageFrameResult {
  frameId?: number;
  result?: unknown;
}

export interface PagePort {
  execute(command: PageAgentCommand): Promise<PageFrameResult[]>;
  currentUrl(): Promise<string>;
  navigate(url: string): Promise<void>;
  waitForLoad(timeoutMs: number): Promise<void>;
  reload(timeoutMs: number): Promise<void>;
}

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
  session: boolean;
  hostOnly: boolean;
}

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

export interface SessionPort {
  listCookies(filter?: { name?: string }): Promise<CookieRecord[]>;
  removeCookie(url: string, name: string): Promise<void>;
  setCookie(details: CookieSetDetails): Promise<void>;
}

export interface ScriptRequestDto {
  code: string;
  bindings: Record<string, unknown>;
  world: "MAIN" | "ISOLATED";
}

export interface ScriptPort {
  execute(request: ScriptRequestDto): Promise<unknown>;
}

export interface HostBridge {
  http: HttpPort;
  page?: PagePort;
  session?: SessionPort;
  script?: ScriptPort;
  capabilities(): HostCapabilities;
}
