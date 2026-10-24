import { describe, it, expect } from 'vitest';

/**
 * json-tree 测试（ADR-0004 D3）
 * 从 json-format/App.vue 下沉的树节点纯函数 CRUD：
 * splitPath / getValueAtPath / deleteValueAtPath（不可变删除）。
 */

import {
  splitPath,
  getValueAtPath,
  deleteValueAtPath,
} from '../entrypoints/tools/json-formatter/lib/json-tree';

describe('splitPath', () => {
  it('根路径切分为空数组', () => {
    expect(splitPath('$')).toEqual([]);
  });

  it('对象属性路径', () => {
    expect(splitPath('$.a.b')).toEqual(['.a', '.b']);
  });

  it('数组下标路径（根节点为数组）', () => {
    expect(splitPath('$[0].a')).toEqual(['[0]', '.a']);
  });

  it('混合路径', () => {
    expect(splitPath('$.list[2].name')).toEqual(['.list', '[2]', '.name']);
  });
});

describe('getValueAtPath', () => {
  const data = {
    a: { b: [10, { c: 'x' }] },
    list: [{ name: 'n0' }, { name: 'n1' }],
  };

  it('$ 返回整体', () => {
    expect(getValueAtPath(data, '$')).toBe(data);
  });

  it('对象属性取值', () => {
    expect(getValueAtPath(data, '$.a.b[0]')).toBe(10);
    expect(getValueAtPath(data, '$.a.b[1].c')).toBe('x');
  });

  it('根为数组的路径', () => {
    expect(getValueAtPath([{ v: 1 }], '$[0].v')).toBe(1);
  });

  it('路径不存在返回 undefined', () => {
    expect(getValueAtPath(data, '$.missing')).toBeUndefined();
    expect(getValueAtPath(data, '$.a.b[9]')).toBeUndefined();
    expect(getValueAtPath(data, '$.a.b.c')).toBeUndefined();
  });

  it('中间遇 null/undefined 返回 undefined', () => {
    expect(getValueAtPath({ a: null }, '$.a.b')).toBeUndefined();
  });

  it('对数组用属性访问 / 对对象用下标访问返回 undefined', () => {
    expect(getValueAtPath({ a: [1] }, '$.a.b')).toBeUndefined();
    expect(getValueAtPath({ a: { b: 1 } }, '$.a[0]')).toBeUndefined();
  });
});

describe('deleteValueAtPath — 不可变删除', () => {
  it('删除对象属性', () => {
    const data = { a: 1, b: 2 };
    const result = deleteValueAtPath(data, '$.a');
    expect(result).toEqual({ b: 2 });
    expect(data).toEqual({ a: 1, b: 2 });
  });

  it('删除数组元素（splice 语义）', () => {
    const data = { list: [1, 2, 3] };
    const result = deleteValueAtPath(data, '$.list[1]');
    expect(result).toEqual({ list: [1, 3] });
    expect(data.list).toEqual([1, 2, 3]);
  });

  it('深层嵌套删除', () => {
    const data = { a: { b: { c: 1, d: 2 } } };
    expect(deleteValueAtPath(data, '$.a.b.c')).toEqual({ a: { b: { d: 2 } } });
  });

  it('根为数组的删除', () => {
    expect(deleteValueAtPath([{ v: 1 }, { v: 2 }], '$[0].v')).toEqual([{}, { v: 2 }]);
  });

  it('路径类型不匹配时原样返回', () => {
    const data = { a: { b: 1 } };
    expect(deleteValueAtPath(data, '$.a[0]')).toEqual(data);
    expect(deleteValueAtPath(data, '$.a.b.c')).toEqual(data);
  });

  it('空路径（$）原样返回', () => {
    const data = { a: 1 };
    expect(deleteValueAtPath(data, '$')).toBe(data);
  });
});
