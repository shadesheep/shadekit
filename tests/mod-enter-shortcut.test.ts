import { describe, expect, it } from 'vitest';
import {
  formatModEnterHint,
  modEnterBinding,
} from '../entrypoints/shared/format-shortcut';

describe('formatModEnterHint', () => {
  it('mac 平台返回 ⌘↵', () => {
    expect(formatModEnterHint('MacIntel')).toBe('⌘↵');
    expect(formatModEnterHint('MacPPC')).toBe('⌘↵');
  });

  it('非 mac 平台返回 Ctrl+↵', () => {
    expect(formatModEnterHint('Win32')).toBe('Ctrl+↵');
    expect(formatModEnterHint('Linux x86_64')).toBe('Ctrl+↵');
    expect(formatModEnterHint('')).toBe('Ctrl+↵');
  });
});

describe('modEnterBinding', () => {
  it('绑定 Mod-Enter 且阻止默认行为', () => {
    const binding = modEnterBinding(() => {});
    expect(binding.key).toBe('Mod-Enter');
    expect(binding.preventDefault).toBe(true);
  });

  it('run 触发回调并返回 true（拦截按键）', () => {
    let called = 0;
    const binding = modEnterBinding(() => {
      called++;
    });
    const result = binding.run?.({} as never);
    expect(called).toBe(1);
    expect(result).toBe(true);
  });
});
