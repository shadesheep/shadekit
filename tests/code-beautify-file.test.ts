import { describe, expect, it } from 'vitest';
import {
  CODE_TYPE_FILE_META,
  detectTypeFromFileName,
} from '../entrypoints/shared/lib/code-beautifier';

describe('detectTypeFromFileName', () => {
  it('按后缀匹配支持的语言', () => {
    expect(detectTypeFromFileName('app.js')).toBe('javascript');
    expect(detectTypeFromFileName('style.css')).toBe('css');
    expect(detectTypeFromFileName('index.html')).toBe('html');
    expect(detectTypeFromFileName('config.xml')).toBe('xml');
    expect(detectTypeFromFileName('query.sql')).toBe('sql');
    expect(detectTypeFromFileName('data.json')).toBe('json');
  });

  it('常见变体后缀', () => {
    expect(detectTypeFromFileName('bundle.mjs')).toBe('javascript');
    expect(detectTypeFromFileName('legacy.cjs')).toBe('javascript');
    expect(detectTypeFromFileName('page.htm')).toBe('html');
  });

  it('后缀大小写不敏感', () => {
    expect(detectTypeFromFileName('APP.JS')).toBe('javascript');
    expect(detectTypeFromFileName('Style.CSS')).toBe('css');
  });

  it('多级后缀取最后一段', () => {
    expect(detectTypeFromFileName('archive.min.js')).toBe('javascript');
  });

  it('不支持的后缀返回 null', () => {
    expect(detectTypeFromFileName('readme.md')).toBeNull();
    expect(detectTypeFromFileName('image.png')).toBeNull();
    expect(detectTypeFromFileName('script.py')).toBeNull();
    expect(detectTypeFromFileName('code.ts')).toBeNull();
  });

  it('无后缀或隐藏文件返回 null', () => {
    expect(detectTypeFromFileName('Makefile')).toBeNull();
    expect(detectTypeFromFileName('.gitignore')).toBeNull();
    expect(detectTypeFromFileName('')).toBeNull();
  });
});

describe('CODE_TYPE_FILE_META', () => {
  it('每种语言的下载后缀与 MIME 类型齐全', () => {
    expect(CODE_TYPE_FILE_META.javascript).toEqual({
      ext: 'js',
      mime: 'text/javascript',
    });
    expect(CODE_TYPE_FILE_META.css).toEqual({ ext: 'css', mime: 'text/css' });
    expect(CODE_TYPE_FILE_META.html).toEqual({
      ext: 'html',
      mime: 'text/html',
    });
    expect(CODE_TYPE_FILE_META.xml).toEqual({
      ext: 'xml',
      mime: 'application/xml',
    });
    expect(CODE_TYPE_FILE_META.sql).toEqual({ ext: 'sql', mime: 'text/plain' });
    expect(CODE_TYPE_FILE_META.json).toEqual({
      ext: 'json',
      mime: 'application/json',
    });
  });
});
