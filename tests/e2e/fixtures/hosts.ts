export const E2E_HOSTS = [
  'exact.test',
  'a.wild.test',
  'b.wild.test',
  'deep.a.wild.test',
  'wild.test',
  'evilwild.test',
  'wild.test.evil.test',
  'other.test',
  'api.wild.test', // API-14 跨 origin：页面 exact.test → 请求 api.wild.test
] as const;

export type E2EHost = (typeof E2E_HOSTS)[number];

export function hostResolverRules(): string {
  return E2E_HOSTS.map((host) => `MAP ${host} 127.0.0.1`).join(', ');
}

export function originFor(host: E2EHost, port: number): string {
  return `http://${host}:${port}`;
}
