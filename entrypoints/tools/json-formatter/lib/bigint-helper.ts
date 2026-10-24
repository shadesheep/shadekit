/**
 * BigNumber 辅助模块
 * 从 FeHelper json-bigint.js 改写为 TypeScript
 */

import { isBigNumberLike } from './json-utils';

/**
 * 将 BigNumber 对象还原为字符串
 */
export function rebuildBigNumberFromParts(value: {
  s: number;
  e: number;
  c: number[];
}): string {
  const sign = value.s < 0 ? '-' : '';
  const CHUNK_SIZE = 14;
  let digits = '';

  for (let i = 0; i < value.c.length; i++) {
    let chunkStr = Math.abs(value.c[i]).toString();
    if (i > 0) {
      chunkStr = chunkStr.padStart(CHUNK_SIZE, '0');
    }
    digits += chunkStr;
  }

  digits = digits.replace(/^0+/, '') || '0';
  const decimalIndex = value.e + 1;

  if (decimalIndex <= 0) {
    const zeros = '0'.repeat(Math.abs(decimalIndex));
    let fraction = zeros + digits;
    fraction = fraction.replace(/0+$/, '');
    if (!fraction) return sign + '0';
    return sign + '0.' + fraction;
  }
  if (decimalIndex >= digits.length) {
    return sign + digits + '0'.repeat(decimalIndex - digits.length);
  }

  const intPart = digits.slice(0, decimalIndex);
  const fracPart = digits.slice(decimalIndex).replace(/0+$/, '');
  if (!fracPart) return sign + intPart;
  return sign + intPart + '.' + fracPart;
}

/**
 * 将 BigNumber 或 BigInt 转换为显示字符串
 */
export function getBigNumberDisplayString(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (!isBigNumberLike(value)) return String(value);

  const bn = value as {
    s: number;
    e: number;
    c: number[];
    toString?: () => string;
  };

  // 尝试使用对象自身的 toString
  if (
    typeof bn.toString === 'function' &&
    bn.toString !== Object.prototype.toString
  ) {
    try {
      const result = bn.toString();
      if (typeof result === 'string' && result !== '[object Object]') {
        return result;
      }
    } catch {
      /* ignore */
    }
  }

  return rebuildBigNumberFromParts(bn);
}
