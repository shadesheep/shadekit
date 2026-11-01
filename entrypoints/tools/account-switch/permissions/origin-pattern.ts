import { PermissionError } from "./permission-error";

export function originToMatchPattern(url: URL): string {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PermissionError("ORIGIN_UNSUPPORTED", `ORIGIN_UNSUPPORTED: 不支持的环境协议 ${url.protocol}`);
  }
  return `${url.protocol}//${url.hostname}/*`;
}
