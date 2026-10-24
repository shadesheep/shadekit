import net from "node:net";

export const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:7890";

export function proxyUp(url = PROXY_URL) {
  return new Promise((resolvePromise) => {
    const u = new URL(url);
    const sock = net.connect(Number(u.port), u.hostname);
    sock.setTimeout(1500);
    sock.on("connect", () => { sock.end(); resolvePromise(true); });
    sock.on("timeout", () => { sock.destroy(); resolvePromise(false); });
    sock.on("error", () => resolvePromise(false));
  });
}

/** 让 undici 的 fetch（含全局 fetch）走本地代理 */
export async function enableProxy(url = PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(url));
}
