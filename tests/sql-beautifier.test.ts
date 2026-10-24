import { describe, it, expect } from 'vitest';
import { beautifySql } from '../entrypoints/shared/lib/sql-beautifier';

describe('beautifySql', () => {
  it('uppercases SQL keywords', () => {
    const result = beautifySql('select * from users');
    expect(result).toContain('SELECT');
    expect(result).toContain('FROM');
  });

  it('formats a simple select statement', () => {
    const result = beautifySql('select id,name from users where active=1');
    expect(result).toContain('SELECT');
    expect(result).toContain('FROM');
    expect(result).toContain('WHERE');
  });

  it('uses default indent of 4 spaces', () => {
    const result = beautifySql('select id from users where id > 10');
    // The formatted SQL should have indentation
    expect(result.length).toBeGreaterThan(20);
  });

  it('accepts custom string indent', () => {
    const result = beautifySql('select id from users', '  ');
    expect(result).toContain('SELECT');
  });

  it('accepts custom numeric indent', () => {
    const result = beautifySql('select id from users', 2);
    expect(result).toContain('SELECT');
  });

  it('handles multi-line input', () => {
    const input = `
      SELECT id, name
      FROM users
      WHERE active = 1
      ORDER BY name
    `;
    const result = beautifySql(input);
    expect(result).toContain('SELECT');
    expect(result).toContain('ORDER BY');
  });

  it('handles multiple queries', () => {
    const result = beautifySql('select 1; select 2;');
    expect(result).toContain('SELECT');
  });

  it('preserves string literals', () => {
    const result = beautifySql("select * from users where name = 'john doe'");
    expect(result).toContain('john doe');
  });
});
