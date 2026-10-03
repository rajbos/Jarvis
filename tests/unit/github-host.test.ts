import { describe, it, expect } from 'vitest';
import {
  accountId,
  apiBaseForHost,
  currentApiBase,
  currentHost,
  hostKey,
  hostOfUrl,
  isGitHubApiUrl,
  isSupportedHost,
  normalizeHost,
  parseAccountId,
  parseHostKey,
  runWithHost,
  webBaseForHost,
} from '../../src/services/github-host';

describe('hosts', () => {
  it('accepts github.com and *.ghe.com only', () => {
    expect(isSupportedHost('github.com')).toBe(true);
    expect(isSupportedHost('Corp.GHE.com')).toBe(true);
    expect(isSupportedHost('https://corp.ghe.com/some/path')).toBe(true);
    for (const bad of ['git.example.com', 'ghe.com', 'evil.com/.ghe.com', 'corp.ghe.com.evil.com', 'a.b.ghe.com', '', null, undefined]) {
      expect(isSupportedHost(bad as string), String(bad)).toBe(false);
    }
  });

  it('maps hosts to API and web base URLs and refuses others', () => {
    expect(apiBaseForHost('github.com')).toBe('https://api.github.com');
    expect(apiBaseForHost('corp.ghe.com')).toBe('https://api.corp.ghe.com');
    expect(webBaseForHost('corp.ghe.com')).toBe('https://corp.ghe.com');
    expect(() => apiBaseForHost('git.example.com')).toThrow(/Unsupported/);
  });

  it('works out the host of an API or web URL', () => {
    expect(hostOfUrl('https://api.github.com/repos/a/b')).toBe('github.com');
    expect(hostOfUrl('https://api.corp.ghe.com/repos/a/b')).toBe('corp.ghe.com');
    expect(hostOfUrl('https://corp.ghe.com/a/b')).toBe('corp.ghe.com');
    expect(hostOfUrl('https://api.evil.com/repos')).toBeNull();
    expect(isGitHubApiUrl('https://api.corp.ghe.com/repos/a/b')).toBe(true);
    expect(isGitHubApiUrl('https://api.evil.com/repos/a/b')).toBe(false);
  });

  it('normalises host names', () => {
    expect(normalizeHost(' HTTPS://Corp.ghe.com:443/x ')).toBe('corp.ghe.com');
    expect(normalizeHost('')).toBeNull();
  });
});

describe('account ids and keys', () => {
  it('uses the bare login on github.com and login@host elsewhere', () => {
    expect(accountId('github.com', 'alice')).toBe('alice');
    expect(accountId('corp.ghe.com', 'bob')).toBe('bob@corp.ghe.com');
    expect(parseAccountId('alice')).toEqual({ host: 'github.com', login: 'alice' });
    expect(parseAccountId('bob@corp.ghe.com')).toEqual({ host: 'corp.ghe.com', login: 'bob' });
  });

  it('prefixes keys with the host off github.com and round-trips them', () => {
    expect(hostKey('github.com', 'Acme/App')).toBe('acme/app');
    expect(hostKey('corp.ghe.com', 'Acme/App')).toBe('corp.ghe.com/acme/app');
    expect(parseHostKey('acme/app')).toEqual({ host: 'github.com', rest: 'acme/app' });
    expect(parseHostKey('corp.ghe.com/acme/app')).toEqual({ host: 'corp.ghe.com', rest: 'acme/app' });
  });
});

describe('host context', () => {
  it('defaults to github.com and scopes the API base to the callback', async () => {
    expect(currentApiBase()).toBe('https://api.github.com');
    await runWithHost('corp.ghe.com', async () => {
      await Promise.resolve();
      expect(currentApiBase()).toBe('https://api.corp.ghe.com');
      expect(currentHost()).toBe('corp.ghe.com');
    });
    expect(currentApiBase()).toBe('https://api.github.com');
  });

  it('keeps concurrent contexts apart', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithHost('one.ghe.com', async () => { await new Promise((r) => setTimeout(r, 5)); seen.push(currentHost()); }),
      runWithHost('two.ghe.com', async () => { seen.push(currentHost()); }),
    ]);
    expect(seen.sort()).toEqual(['one.ghe.com', 'two.ghe.com']);
  });
});
