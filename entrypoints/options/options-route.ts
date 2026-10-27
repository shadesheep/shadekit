import type { DomainConfig } from "../tools/account-switch/types";

export interface OptionsRoute {
  section?: string;
  editEnv?: string;
}

export function parseOptionsRoute(search: string): OptionsRoute {
  const params = new URLSearchParams(search);
  const section = params.get("section")?.trim();
  const editEnv = params.get("editEnv");
  return {
    ...(section ? { section } : {}),
    ...(editEnv ? { editEnv } : {}),
  };
}

export function accountEnvironmentOptionsQuery(envKey: string): string {
  return new URLSearchParams({ section: "account-switch", editEnv: envKey }).toString();
}

/** 初次挂载立即通知，后续浏览器 history 变化通过 popstate 通知。 */
export function subscribeOptionsRoute(listener: (route: OptionsRoute) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const notify = () => listener(parseOptionsRoute(window.location.search));
  notify();
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
}

export function resolveRequestedEnv(
  domains: Record<string, DomainConfig>,
  editEnv?: string,
): string | null {
  if (!editEnv || !Object.prototype.hasOwnProperty.call(domains, editEnv)) return null;
  return domains[editEnv] ? editEnv : null;
}
