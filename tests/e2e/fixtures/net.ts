export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'] as const;

export function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const closing = hostname.indexOf(']');
    return closing === -1 ? hostname : hostname.slice(0, closing + 1);
  }
  const colon = hostname.indexOf(':');
  return colon === -1 ? hostname : hostname.slice(0, colon);
}

export function redactQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of url.searchParams.keys()) {
    query[key] = '[redacted]';
  }
  return query;
}

export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}
