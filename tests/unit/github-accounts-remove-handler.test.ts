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
import { saveGitHubAuth } from '../../src/services/github-oauth';
import {
  listAssignments,
  listRepoViewers,
  recordRepoVisibility,
  saveHostAccountPat,
  setAssignment,
} from '../../src/services/github-accounts';
import { setConfigValue, getConfigValue } from '../../src/storage/database';

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
