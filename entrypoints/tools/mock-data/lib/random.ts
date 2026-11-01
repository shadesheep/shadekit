/** 可复现随机数与基础随机工具。所有生成路径都只通过 RandomSource 取随机数。 */

export type RandomSource = () => number;

/** 未指定 seed 时保留旧的非确定性行为；此文件是唯一使用 Math.random 的位置。 */
export const defaultRandom: RandomSource = () => Math.random();

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** FNV-1a + Mulberry32：同一 seed 在浏览器与 Node 中产生相同序列。 */
export function createRandom(seed?: string): RandomSource {
  if (seed === undefined) return defaultRandom;
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(
  min: number,
  max: number,
  rng: RandomSource = defaultRandom,
): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi < lo) return lo;
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}

export function randomFloat(
  min: number,
  max: number,
  precision = 2,
  rng: RandomSource = defaultRandom,
): number {
  const p = Number.isFinite(precision) ? Math.trunc(precision) : 2;
  const clamped = Math.min(Math.max(p, 0), 6);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Number((rng() * (hi - lo) + lo).toFixed(clamped));
}

export function pick<T>(
  arr: readonly T[],
  rng: RandomSource = defaultRandom,
): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function randomString(
  length: number,
  charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  rng: RandomSource = defaultRandom,
): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += charset.charAt(Math.floor(rng() * charset.length));
  }
  return out;
}

export function randomDigits(
  length: number,
  rng: RandomSource = defaultRandom,
): string {
  return randomString(length, "0123456789", rng);
}
