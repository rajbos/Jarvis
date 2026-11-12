/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

const ghAccounts: { host: string; login: string; active: boolean }[] = [];
vi.mock('../../src/services/github-accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/github-accounts')>();
  return { ...actual, listGhCliAccounts: vi.fn(async () => ghAccounts) };
});

import { registerHandlers, getAccountBudget } from '../../src/plugins/github-accounts/handler';
import { saveGitHubAuth, loadGitHubAuth } from '../../src/services/github-oauth';
import {
  listAssignments,
  listRepoViewers,
  recordRepoVisibility,
  saveHostAccountPat,
  setAssignment,
} from '../../src/services/github-accounts';
import { setConfigValue, getConfigValue } from '../../src/storage/database';
import { githubRequest, githubEtagCacheSize, resetGitHubApiStats, tokenLabelOf } from '../../src/services/github-api';

let db: SqlJsDatabase;
const remove = (id: string) => handlers.get('github-accounts:remove')!({}, id) as Promise<{ ok: boolean }>;

function seed(account: string) {
  setConfigValue(db, `copilot_aic_monthly_budget:${account.toLowerCase()}`, '500');
  setAssignment(db, 'owner', `${account}-org`, account);
  setAssignment(db, 'repo', `${account}-org/app`, account);
  recordRepoVisibility(db, `${account}-org/app`, account);
}

describe('github-accounts:remove data cleanup', () => {
  beforeEach(async () => {
    handlers.clear();
    ghAccounts.length = 0;
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    registerHandlers(db);
  });
  afterEach(() => db.close());

  it('removes the account budget, assignments and visibility but leaves other accounts alone', async () => {
    saveGitHubAuth(db, 'alice', 't1', '');
    saveGitHubAuth(db, 'bob', 't2', '');
    seed('alice');
    seed('bob');
    setConfigValue(db, 'copilot_aic_monthly_budget', '999');

    expect(await remove('alice')).toEqual({ ok: true });

    expect(getAccountBudget(db, 'alice', false)).toBeNull();
    expect(listAssignments(db).map((a) => a.login)).toEqual(['bob', 'bob']);
    expect(listRepoViewers(db, 'alice-org/app')).toEqual([]);
    expect(getAccountBudget(db, 'bob', false)).toBe(500);
    expect(listRepoViewers(db, 'bob-org/app')).toEqual(['bob']);
    expect(getConfigValue(db, 'copilot_aic_monthly_budget')).toBe('999');
  });

  it("purges the removed account's cached responses and label but not other accounts'", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { etag: '"v1"' } })) as unknown as typeof fetch;
    try {
      resetGitHubApiStats(1000);
      saveGitHubAuth(db, 'alice', 'tok-alice', '');
      saveGitHubAuth(db, 'bob', 'tok-bob', '');
      loadGitHubAuth(db, 'alice');
      loadGitHubAuth(db, 'bob');
      const as = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
      await githubRequest('https://api.github.com/user/orgs', as('tok-alice'), { purpose: 'test' });
      await githubRequest('https://api.github.com/user/orgs', as('tok-bob'), { purpose: 'test' });
      expect(githubEtagCacheSize()).toBe(2);

      await remove('alice');

      expect(githubEtagCacheSize()).toBe(1);
      expect(tokenLabelOf(as('tok-alice'))).toBe('other');
      expect(tokenLabelOf(as('tok-bob'))).not.toBe('other');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("purges a removed host account PAT's cached responses", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { etag: '"v1"' } })) as unknown as typeof fetch;
    try {
      resetGitHubApiStats(1000);
      const id = saveHostAccountPat(db, 'acme.ghe.com', 'carol', 'tok-carol', null);
      const init = { headers: { Authorization: 'Bearer tok-carol' } };
      await githubRequest('https://api.acme.ghe.com/user', init, { purpose: 'test' });
      expect(githubEtagCacheSize()).toBe(1);

      await remove(id);

      expect(githubEtagCacheSize()).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('matches the account id case-insensitively', async () => {
    saveGitHubAuth(db, 'Alice', 't1', '');
    seed('Alice');
    await remove('Alice');
    expect(listAssignments(db)).toEqual([]);
    expect(listRepoViewers(db, 'alice-org/app')).toEqual([]);
  });

  it('cleans up GHE.com host accounts by their login@host id', async () => {
    const id = saveHostAccountPat(db, 'acme.ghe.com', 'carol', 'pat', null);
    seed(id);
    await remove(id);
    expect(getAccountBudget(db, id, false)).toBeNull();
    expect(listAssignments(db)).toEqual([]);
  });

  it('keeps the data when the account is still logged in through the GitHub CLI', async () => {
    saveGitHubAuth(db, 'alice', 't1', '');
    seed('alice');
    ghAccounts.push({ host: 'github.com', login: 'alice', active: true });
    await remove('alice');
    expect(getAccountBudget(db, 'alice', false)).toBe(500);
    expect(listAssignments(db)).toHaveLength(2);
  });
});
