import { describe, it, expect } from 'vitest';

/**
 * json-path 测试（ADR-0004 D3）
 * pathToLanguage：把 '$' 开头的 JSON 路径翻译成各语言访问表达式。
 */

import {
  pathToLanguage,
  PATH_LANGUAGES,
} from '../entrypoints/tools/json-formatter/lib/json-path';

describe('pathToLanguage — 根路径', () => {
  it('各语言根标识符', () => {
    expect(pathToLanguage('$', 'javascript')).toBe('$');
    expect(pathToLanguage('$', 'php')).toBe('$data');
    expect(pathToLanguage('$', 'python')).toBe('data');
    expect(pathToLanguage('$', 'java')).toBe('jsonObject');
    expect(pathToLanguage('$', 'csharp')).toBe('jsonObject');
    expect(pathToLanguage('$', 'go')).toBe('data');
    expect(pathToLanguage('$', 'ruby')).toBe('data');
    expect(pathToLanguage('$', 'swift')).toBe('jsonObject');
  });

  it('未知语言回退原路径', () => {
    expect(pathToLanguage('$', 'cobol')).toBe('$');
    expect(pathToLanguage('$.a', 'cobol')).toBe('$.a');
  });
});

describe('pathToLanguage — 属性与下标', () => {
  it('javascript：点属性 + 下标', () => {
    expect(pathToLanguage('$.a.b', 'javascript')).toBe('$.a.b');
    expect(pathToLanguage('$.list[2].name', 'javascript')).toBe('$.list[2].name');
  });

  it('php：关联数组访问', () => {
    expect(pathToLanguage('$.a.b', 'php')).toBe('$data["a"]["b"]');
    expect(pathToLanguage('$.list[0]', 'php')).toBe('$data["list"][0]');
  });

  it('python：dict 访问', () => {
    expect(pathToLanguage('$.a.b', 'python')).toBe('data["a"]["b"]');
  });

  it('java：get 链', () => {
    expect(pathToLanguage('$.a.b', 'java')).toBe('jsonObject.get("a").get("b")');
    expect(pathToLanguage('$.list[1]', 'java')).toBe('jsonObject.get("list").get(1)');
  });

  it('ruby：symbol 访问', () => {
    expect(pathToLanguage('$.a.b', 'ruby')).toBe('data[:"a"][:"b"]');
    expect(pathToLanguage('$[0].a', 'ruby')).toBe('data[0][:"a"]');
  });

  it('根为数组的路径', () => {
    expect(pathToLanguage('$[0].a', 'javascript')).toBe('$[0].a');
    expect(pathToLanguage('$[0].a', 'go')).toBe('data[0]["a"]');
  });
});

describe('PATH_LANGUAGES', () => {
  it('包含全部八种语言且 value 与 pathToLanguage 分支一致', () => {
    const values = PATH_LANGUAGES.map((l) => l.value);
    expect(values).toEqual([
      'javascript', 'php', 'python', 'java', 'csharp', 'go', 'ruby', 'swift',
    ]);
  });
});
