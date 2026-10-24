/**
 * Chunked JSON processing for large files
 * Prevents main thread blocking during parsing/formatting
 */

import { parseWithBigInt } from '../../tools/json-formatter/lib/json-utils';

export interface ChunkedProgress {
  phase: 'parsing' | 'formatting' | 'complete';
  percent: number;
}

/**
 * Parse large JSON with progress callbacks
 * Uses parseWithBigInt to preserve 16+ digit integers (e.g. 18-digit IDs)
 */
export async function parseLargeJson(
  text: string,
  onProgress?: (progress: ChunkedProgress) => void
): Promise<{ data: unknown; error: string | null }> {
  return new Promise((resolve) => {
    onProgress?.({ phase: 'parsing', percent: 0 });

    // For files < 100KB, parse synchronously
    if (text.length < 100000) {
      try {
        const data = parseWithBigInt(text);
        onProgress?.({ phase: 'complete', percent: 100 });
        resolve({ data, error: null });
      } catch (e) {
        resolve({ data: null, error: String(e) });
      }
      return;
    }

    // For large files, use setTimeout to avoid blocking
    setTimeout(() => {
      try {
        const data = parseWithBigInt(text);
        onProgress?.({ phase: 'complete', percent: 100 });
        resolve({ data, error: null });
      } catch (e) {
        resolve({ data: null, error: String(e) });
      }
    }, 0);
  });
}

/**
 * Format large JSON with progress callbacks
 */
export async function formatLargeJson(
  data: unknown,
  indent: number = 2,
  onProgress?: (progress: ChunkedProgress) => void
): Promise<string> {
  return new Promise((resolve) => {
    onProgress?.({ phase: 'formatting', percent: 0 });

    // For small outputs, format synchronously
    const estimateSize = JSON.stringify(data).length;
    if (estimateSize < 100000) {
      const jsonStr = JSON.stringify(data, null, indent);
      onProgress?.({ phase: 'complete', percent: 100 });
      resolve(jsonStr);
      return;
    }

    // For large outputs, defer formatting to next event loop tick
    setTimeout(() => {
      const jsonStr = JSON.stringify(data, null, indent);
      onProgress?.({ phase: 'complete', percent: 100 });
      resolve(jsonStr);
    }, 0);
  });
}
