import { webcrypto } from "node:crypto";
import { performance } from "node:perf_hooks";

const iterations = 600_000;
const samplesMs = [];
for (let sample = 0; sample < 3; sample += 1) {
  const started = performance.now();
  const material = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("H1-benchmark-password"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  await webcrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(16).fill(sample + 1),
      iterations,
    },
    material,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
  samplesMs.push(Number((performance.now() - started).toFixed(2)));
}

console.log(JSON.stringify({
  format: "shadekit-kdf-benchmark/v1",
  measuredAt: new Date().toISOString(),
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  algorithm: "PBKDF2-SHA-256",
  iterations,
  samplesMs,
  note: "本机 Node Web Crypto 实测，不代表浏览器或其他平台性能承诺。",
}, null, 2));
