import { describe, it, expect } from 'vitest';
import { matchDomain } from '../entrypoints/tools/account-switch/utils/env';

describe('matchDomain', () => {
  it('returns true for exact match', () => {
    expect(matchDomain('https://example.com', 'https://example.com')).toBe(true);
  });

  it('returns false for different origins', () => {
    expect(matchDomain('https://example.com', 'https://other.com')).toBe(false);
  });

  it('matches single wildcard subdomain', () => {
    expect(matchDomain('https://*.example.com', 'https://dev.example.com')).toBe(true);
    expect(matchDomain('https://*.example.com', 'https://prod.example.com')).toBe(true);
  });

  it('does not match wildcard with different base domain', () => {
    expect(matchDomain('https://*.example.com', 'https://other.com')).toBe(false);
  });

  it('matches multi-level wildcard subdomain', () => {
    expect(matchDomain('https://*.*.example.com', 'https://dev.us.example.com')).toBe(true);
    expect(matchDomain('https://*.*.example.com', 'https://prod.eu.example.com')).toBe(true);
  });

  it('does not match multi-level wildcard with wrong levels', () => {
    expect(matchDomain('https://*.*.example.com', 'https://example.com')).toBe(false);
    expect(matchDomain('https://*.*.example.com', 'https://dev.example.com')).toBe(false);
  });

  it('is case insensitive for wildcard matches', () => {
    expect(matchDomain('https://*.EXAMPLE.com', 'https://dev.example.com')).toBe(true);
  });

  it('does not match wildcard for empty subdomain', () => {
    expect(matchDomain('https://*.example.com', 'https://example.com')).toBe(false);
  });

  it('returns false for non-wildcard mismatch', () => {
    expect(matchDomain('https://example.com', 'https://example.com:8080')).toBe(false);
  });

  it('matches domain with trailing slash', () => {
    expect(matchDomain('http://192.0.2.17:31135/', 'http://192.0.2.17:31135')).toBe(true);
    expect(matchDomain('https://example.com/', 'https://example.com')).toBe(true);
  });

  it('matches domain with trailing path', () => {
    expect(matchDomain('https://example.com/login/', 'https://example.com')).toBe(true);
  });

  it('matches domain with trailing slash and different case', () => {
    expect(matchDomain('HTTPS://EXAMPLE.COM/', 'https://example.com')).toBe(true);
  });

  it('matches wildcard domain with trailing slash', () => {
    expect(matchDomain('https://*.example.com/', 'https://dev.example.com')).toBe(true);
  });

  it('matches wildcard domain with port', () => {
    expect(
      matchDomain(
        'http://*.dev.example.com:16800',
        'http://app.dev.example.com:16800',
      ),
    ).toBe(true);
  });

  it('matches wildcard domain with port and trailing slash/path', () => {
    const origin = 'http://app.dev.example.com:16800';
    expect(matchDomain('http://*.dev.example.com:16800/', origin)).toBe(true);
    expect(matchDomain('http://*.dev.example.com:16800/app/', origin)).toBe(true);
  });

  it('keeps explicit default ports when matching (regression: URL.origin strips them)', () => {
    expect(matchDomain('http://*.example.com:80', 'http://a.example.com:80')).toBe(true);
    expect(matchDomain('https://*.example.com:443', 'https://a.example.com:443')).toBe(true);
    expect(matchDomain('http://example.com:80', 'http://example.com:80')).toBe(true);
    expect(matchDomain('http://example.com:80/', 'http://example.com:80')).toBe(true);
  });
});
