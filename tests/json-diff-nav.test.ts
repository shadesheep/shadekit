import { describe, it, expect } from 'vitest';
import { compareJson, getDiffMarkers } from '../entrypoints/tools/json-diff/lib/json-differ';
import { buildDiffPositions } from '../entrypoints/tools/json-diff/lib/diff-nav';

// 用户报告的场景：「配置选项」示例，4 处差异全部为 replace
const LEFT = JSON.stringify(
  {
    appConfig: {
      theme: 'light',
      language: 'zh-CN',
      notifications: { email: true, push: true, sms: false },
      security: { twoFactorAuth: true, passwordExpiry: 90 },
    },
  },
  null,
  2,
);
const RIGHT = JSON.stringify(
  {
    appConfig: {
      theme: 'dark',
      language: 'zh-CN',
      notifications: { email: true, push: false, sms: true },
      security: { twoFactorAuth: true, passwordExpiry: 60 },
    },
  },
  null,
  2,
);

describe('buildDiffPositions（差异导航位置）', () => {
  it('replace 差异同时包含左右两侧行号（右侧高亮才能跟随导航）', () => {
    const result = compareJson(LEFT, RIGHT);
    expect(result.error).toBeNull();
    expect(result.differenceCount).toBe(4);

    const markers = getDiffMarkers(result.diffs, LEFT, RIGHT);
    const positions = buildDiffPositions(markers);

    expect(positions).toHaveLength(4);
    for (const pos of positions) {
      expect(pos.left).toBeDefined();
      // Bug：旧逻辑按 diffIndex 去重只保留左侧 marker，right 永远 undefined，
      // navigateDiff 从不滚动/高亮右侧编辑器
      expect(pos.right).toBeDefined();
    }
  });

  it('add 差异只有右侧行号，remove 差异只有左侧行号', () => {
    const result = compareJson('{"a": 1, "b": 2}', '{"a": 1, "c": 3}');
    const markers = getDiffMarkers(result.diffs, '{"a": 1, "b": 2}', '{"a": 1, "c": 3}');
    const positions = buildDiffPositions(markers);

    const removePos = positions.find((p) => p.left !== undefined && p.right === undefined);
    const addPos = positions.find((p) => p.right !== undefined && p.left === undefined);
    expect(removePos).toBeDefined();
    expect(addPos).toBeDefined();
  });

  it('位置按行号升序排列', () => {
    const result = compareJson(LEFT, RIGHT);
    const markers = getDiffMarkers(result.diffs, LEFT, RIGHT);
    const positions = buildDiffPositions(markers);

    const lines = positions.map((p) => p.left ?? p.right ?? 0);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});
