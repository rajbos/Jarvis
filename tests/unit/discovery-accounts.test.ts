/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Discovery for the non-primary accounts: a second github.com login and a
 * GHE.com account are indexed into the same tables, each repo recorded as
 * visible to the account that found it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() } }));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/github-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/github-accounts')>();
  return {
    ...actual,
    listGhCliAccounts: vi.fn(async () => [
      { host: 'github.com', login: 'guest', active: false },
      { host: 'corp.ghe.com', login: 'bob', active: true },
    ]),
    resolveAccountToken: vi.fn(async (_db: unknown, id: string) => {
      const [login, host = 'github.com'] = id.split('@');
      return { id, host, login, token: `tok-${login}`, source: 'gh-cli' as const };
    }),
  };
});

import { discoverAdditionalAccounts, accountIndexedKey } from '../../src/plugins/discovery/accounts';
import { saveGitHubAuth } from '../../src/services/github-oauth';
import { listRepoViewers } from '../../src/services/github-repo-visibility';
import { resolveAccountForRepo } from '../../src/services/github-accounts';
import { getConfigValue } from '../../src/storage/database';

function repo(fullName: string, ownerType = 'User') {
  const [owner, name] = fullName.split('/');
  return { full_name: fullName, name, owner: { login: owner, type: ownerType }, private: false, archived: false, fork: false };
}

const requested: Array<{ url: string; token: string }> = [];

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const token = (init?.headers?.Authorization ?? '').replace('Bearer ', '');
    requested.push({ url, token });
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;
    if (url.includes('/user/orgs')) return json([]);
    if (url.includes('/user/starred')) return json([repo('starred/by-guest')]);
    if (url.includes('/user/repos') && token === 'tok-guest') return json([repo('guestonly/x'), repo('shared/lib')]);
    if (url.includes('/user/repos') && token === 'tok-bob') return json([repo('corp-org/svc', 'Organization')]);
    return json([]);
  }));
}

describe('discoverAdditionalAccounts', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-discovery-accounts';
    requested.length = 0;
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    saveGitHubAuth(db, 'main', 'tok-main', 'repo');
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('indexes every other account on its own host and records who can see each repo', async () => {
    await discoverAdditionalAccounts(db, () => null, false);

    const hosts = Object.fromEntries(
      (db.exec('SELECT full_name, host FROM github_repos')[0]?.values ?? []).map((r) => [r[0] as string, r[1] as string]),
    );
    expect(hosts).toEqual({
      'guestonly/x': 'github.com',
      'shared/lib': 'github.com',
      'corp-org/svc': 'corp.ghe.com',
    });
    expect(listRepoViewers(db, 'guestonly/x')).toEqual(['guest']);
    expect(listRepoViewers(db, 'corp.ghe.com/corp-org/svc')).toEqual(['bob@corp.ghe.com']);

    // The primary account was not re-discovered, and the GHE.com account hit its own API.
    expect(requested.some((r) => r.token === 'tok-main')).toBe(false);
    expect(requested.filter((r) => r.token === 'tok-bob').every((r) => new URL(r.url).host === 'api.corp.ghe.com')).toBe(true);
    expect(requested.filter((r) => r.token === 'tok-guest').every((r) => new URL(r.url).host === 'api.github.com')).toBe(true);
  });

  it('leaves stars to the primary account', async () => {
    await discoverAdditionalAccounts(db, () => null, false);
    expect(requested.some((r) => r.url.includes('/user/starred'))).toBe(false);
    expect(db.exec("SELECT COUNT(*) FROM github_repos WHERE starred = 1")[0].values[0][0]).toBe(0);
  });

  it('lets a repo only the second account can see resolve to that account', async () => {
    await discoverAdditionalAccounts(db, () => null, false);
    expect(resolveAccountForRepo(db, 'guestonly/x', 'main')).toMatchObject({ login: 'guest', via: 'discovered' });
    expect(resolveAccountForRepo(db, 'corp.ghe.com/corp-org/svc', 'main')).toMatchObject({ login: 'bob@corp.ghe.com', via: 'discovered' });
  });

  it('does a full pass first and a lightweight refresh afterwards', async () => {
    await discoverAdditionalAccounts(db, () => null, false);
    expect(getConfigValue(db, accountIndexedKey('guest'))).not.toBeNull();
    expect(requested.some((r) => r.url.includes('/orgs/'))).toBe(false);

    requested.length = 0;
    await discoverAdditionalAccounts(db, () => null, false);
    // Lightweight refresh: orgs + user repos only.
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.some((r) => r.url.includes('/user/starred'))).toBe(false);
  });
});
