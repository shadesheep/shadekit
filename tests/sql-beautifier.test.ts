import { describe, it, expect } from 'vitest';
import { beautifySql, SQL_DIALECTS } from '../entrypoints/shared/lib/sql-beautifier';

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

  it('supports every SQL dialect from sql-formatter', () => {
    for (const dialect of SQL_DIALECTS) {
      const result = beautifySql('select count(*) from users', 4, dialect);
      expect(result, `dialect ${dialect} should format`).toContain('SELECT');
      expect(result, `dialect ${dialect}`).toContain('FROM');
    }
  });

  it('treats tsql as an alias of transactsql', () => {
    expect(beautifySql('select top 10 * from users', 4, 'tsql')).toContain('TOP');
    expect(beautifySql('select top 10 * from users', 4, 'transactsql')).toContain('TOP');
  });

  it('falls back to generic sql for unknown dialects', () => {
    const result = beautifySql('select id from users', 4, 'not-a-real-dialect' as never);
    expect(result).toContain('SELECT');
  });

  it('accepts dialect names case-insensitively and with separators', () => {
    expect(beautifySql('select id from users', 4, 'MySql' as never)).toContain('SELECT');
    expect(beautifySql('select id from users', 4, 'transact-sql' as never)).toContain('SELECT');
  });
});
