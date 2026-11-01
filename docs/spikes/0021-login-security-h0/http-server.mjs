import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startHttpFixtures() {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/http.json", import.meta.url), "utf8"));
  const cookieCase = fixture.cases.find((item) => item.id === "set-cookie-replay");
  const handler = (request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/final?from=redirect" });
      response.end();
      return;
    }
    if (request.url === "/final?from=redirect") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("final");
      return;
    }
    if (request.url === "/decode") {
      response.writeHead(200, { "content-type": "text/plain; charset=gbk" });
      response.end(Buffer.from("1tDOxA==", "base64"));
      return;
    }
    if (request.url === "/timeout") {
      setTimeout(() => {
        response.writeHead(200);
        response.end("late");
      }, 250);
      return;
    }
    if (request.url === "/set-cookie") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "set-cookie": cookieCase.serverSetCookies,
      });
      response.end("cookies-set");
      return;
    }
    response.writeHead(404);
    response.end("not-found");
  };

  const httpServer = http.createServer(handler);
  const certDir = await mkdtemp(path.join(tmpdir(), "shadekit-h0-cert-"));
  const keyPath = path.join(certDir, "fixture.key");
  const certPath = path.join(certDir, "fixture.crt");
  await execFileAsync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const secureServer = https.createServer({ key, cert }, handler);
  const httpPort = await listen(httpServer);
  const httpsPort = await listen(secureServer);

  const closedServer = http.createServer();
  const closedPort = await listen(closedServer);
  await close(closedServer);

  return {
    httpPort,
    httpsPort,
    closedPort,
    async cleanup() {
      await Promise.all([close(httpServer), close(secureServer)]);
      await rm(certDir, { recursive: true, force: true });
    },
  };
}
