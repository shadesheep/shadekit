import { describe, it, expect } from 'vitest';
import { compareJson, type DiffEntry } from '../entrypoints/tools/json-diff/lib/json-differ';

describe('compareJson', () => {
  it('returns no diff for identical JSON', () => {
    const result = compareJson('{"a": 1}', '{"a": 1}');
    expect(result.isDifferent).toBe(false);
    expect(result.differenceCount).toBe(0);
    expect(result.error).toBeNull();
  });

  it('detects added keys', () => {
    const result = compareJson('{"a": 1}', '{"a": 1, "b": 2}');
    expect(result.isDifferent).toBe(true);
    expect(result.differenceCount).toBe(1);
    expect(result.diffs[0].op).toBe('add');
  });

  it('detects removed keys', () => {
    const result = compareJson('{"a": 1, "b": 2}', '{"a": 1}');
    expect(result.isDifferent).toBe(true);
    expect(result.differenceCount).toBe(1);
    expect(result.diffs[0].op).toBe('remove');
  });

  it('detects replaced values', () => {
    const result = compareJson('{"a": 1}', '{"a": 2}');
    expect(result.isDifferent).toBe(true);
    expect(result.differenceCount).toBe(1);
    expect(result.diffs[0].op).toBe('replace');
  });

  it('returns error for invalid left JSON', () => {
    const result = compareJson('{invalid}', '{"a": 1}');
    expect(result.error).toContain('左侧 JSON');
  });

  it('returns error for invalid right JSON', () => {
    const result = compareJson('{"a": 1}', '{invalid}');
    expect(result.error).toContain('右侧 JSON');
  });

  it('returns empty diff for both empty inputs', () => {
    const result = compareJson('', '');
    expect(result.isDifferent).toBe(false);
    expect(result.differenceCount).toBe(0);
  });

  it('returns error when left is empty and right is not', () => {
    const result = compareJson('', '{"a": 1}');
    expect(result.error).toContain('左侧');
  });

  it('returns error when right is empty and left is not', () => {
    const result = compareJson('{"a": 1}', '');
    expect(result.error).toContain('右侧');
  });

  it('handles nested objects', () => {
    const result = compareJson(
      '{"a": {"b": 1}}',
      '{"a": {"b": 1, "c": 2}}',
    );
    expect(result.isDifferent).toBe(true);
    const diff = result.diffs[0] as DiffEntry;
    expect(diff.path).toBe('/a/c');
    expect(diff.op).toBe('add');
  });

  it('handles arrays', () => {
    const result = compareJson('[1, 2]', '[1, 2, 3]');
    expect(result.isDifferent).toBe(true);
    expect(result.diffs.some((d) => d.op === 'add')).toBe(true);
  });

  it('trims whitespace before parsing', () => {
    const result = compareJson('  {"a": 1}  ', '  {"a": 1}  ');
    expect(result.isDifferent).toBe(false);
  });
});
