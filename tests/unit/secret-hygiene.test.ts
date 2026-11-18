import { describe, it, expect } from 'vitest';
import {
  secretAgeDays,
  formatSecretAge,
  findStaleSecrets,
  findSharedSecretNames,
  findSecretsOnArchivedRepos,
} from '../../src/services/secret-hygiene';

const now = new Date('2026-06-01T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

describe('secretAgeDays', () => {
  it('uses updated_at, falls back to created_at', () => {
    expect(secretAgeDays({ updated_at: daysAgo(10), created_at: daysAgo(100) }, now)).toBe(10);
    expect(secretAgeDays({ updated_at: null, created_at: daysAgo(100) }, now)).toBe(100);
  });
  it('returns null (age unknown) for pre-migration rows or bad dates', () => {
    expect(secretAgeDays({ created_at: null, updated_at: null }, now)).toBeNull();
    expect(secretAgeDays({}, now)).toBeNull();
    expect(secretAgeDays({ updated_at: 'nonsense' }, now)).toBeNull();
  });
  it('never goes negative for future timestamps', () => {
    expect(secretAgeDays({ updated_at: daysAgo(-5) }, now)).toBe(0);
  });
});

describe('formatSecretAge', () => {
  it('formats units', () => {
    expect(formatSecretAge(null)).toBe('age unknown');
    expect(formatSecretAge(1)).toBe('1 day');
    expect(formatSecretAge(90)).toBe('3 months');
    expect(formatSecretAge(800)).toBe('2 years');
  });
});

describe('findStaleSecrets', () => {
  it('flags secrets older than the threshold, oldest first, skipping unknown ages', () => {
    const stale = findStaleSecrets([
      { full_name: 'a/x', secret_name: 'NEW', updated_at: daysAgo(30) },
      { full_name: 'a/x', secret_name: 'OLD', updated_at: daysAgo(400) },
      { full_name: 'a/y', secret_name: 'OLDER', updated_at: daysAgo(900) },
      { full_name: 'a/z', secret_name: 'UNKNOWN', updated_at: null, created_at: null },
    ], now);
    expect(stale.map((s) => s.secret_name)).toEqual(['OLDER', 'OLD']);
  });
  it('respects a custom threshold', () => {
    const rows = [{ full_name: 'a/x', secret_name: 'S', updated_at: daysAgo(100) }];
    expect(findStaleSecrets(rows, now, 12)).toHaveLength(0);
    expect(findStaleSecrets(rows, now, 3)).toHaveLength(1);
  });
});

describe('findSharedSecretNames', () => {
  it('groups by name case-insensitively and applies the minimum', () => {
    const shared = findSharedSecretNames([
      { full_name: 'o/a', secret_name: 'NPM_TOKEN' },
      { full_name: 'o/b', secret_name: 'npm_token' },
      { full_name: 'o/c', secret_name: 'NPM_TOKEN' },
      { full_name: 'o/c', secret_name: 'NPM_TOKEN' },
      { full_name: 'o/a', secret_name: 'ONLY_TWO' },
      { full_name: 'o/b', secret_name: 'ONLY_TWO' },
    ]);
    expect(shared).toEqual([{ secret_name: 'NPM_TOKEN', repos: ['o/a', 'o/b', 'o/c'] }]);
  });
});

describe('findSecretsOnArchivedRepos', () => {
  it('keeps only archived repos', () => {
    const rows = [
      { full_name: 'a/x', secret_name: 'S', archived: 1 },
      { full_name: 'a/y', secret_name: 'S', archived: 0 },
      { full_name: 'a/z', secret_name: 'S', archived: null },
    ];
    expect(findSecretsOnArchivedRepos(rows).map((r) => r.full_name)).toEqual(['a/x']);
  });
});
