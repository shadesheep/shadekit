/** 用例集沿用用户 Seed；没有 Seed 时生成一次并写回，供重建用例使用。 */
export function createCaseSetSeed(seed: string | undefined): string {
  if (seed?.trim()) return seed.trim();
  const values = new Uint32Array(4);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 0xffffffff);
    }
  }
  return Array.from(values, (value) => value.toString(36)).join("");
}
