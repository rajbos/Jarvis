/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Notifications across several accounts (github.com + GHE.com): each account
 * syncs its own inbox, keeps only the repos assigned to / served by it, and
 * actions on a notification run as the account it belongs to.
 */
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

vi.mock('../../src/services/github-oauth', () => ({
  getPrimaryGitHubLogin: vi.fn(() => 'main'),
}));

type Access = { id: string; host: string; login: string; token: string; source: 'oauth'; isPrimary: boolean };
const ACCOUNTS: Access[] = [
  { id: 'main', host: 'github.com', login: 'main', token: 'tok-main', source: 'oauth', isPrimary: true },
  { id: 'guest', host: 'github.com', login: 'guest', token: 'tok-guest', source: 'oauth', isPrimary: false },
  { id: 'bob@corp.ghe.com', host: 'corp.ghe.com', login: 'bob', token: 'tok-ghe', source: 'oauth', isPrimary: false },
];
let tracked: Access[] = ACCOUNTS;

vi.mock('../../src/services/github-repo-access', () => ({
  listAccountsWithAccess: vi.fn(async () => tracked),
  accessForAccount: vi.fn(async (_db: unknown, id: string) => tracked.find((a) => a.id === id) ?? null),
  accessForRepo: vi.fn(async () => null),
  accessForOwner: vi.fn(async () => null),
}));

vi.mock('../../src/services/github-workflows', () => ({
  fetchAndStoreWorkflowData: vi.fn().mockResolvedValue({ runsStored: 0 }),
}));
vi.mock('../../src/plugins/notifications/workflow-cache', () => ({ isWorkflowDataFresh: vi.fn().mockReturnValue(true) }));

import { registerHandlers, syncGitHubNotifications } from '../../src/plugins/notifications/handler';
import { setAssignment } from '../../src/services/github-accounts';

function notif(id: string, fullName: string) {
  const [owner, name] = fullName.split('/');
  return {
    id,
    unread: true,
    reason: 'subscribed',
    updated_at: '2026-09-01T00:00:00Z',
    subject: { type: 'Issue', title: `Issue in ${fullName}`, url: null },
    repository: { full_name: fullName, name, owner: { login: owner }, html_url: `https://example.invalid/${fullName}` },
  };
}

/** Inbox per `Authorization` token; the request URL tells which host was asked. */
const inboxes: Record<string, unknown[] | 'fail'> = {};
const requested: Array<{ url: string; method: string; token: string }> = [];

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = String(input);
    const token = (init?.headers?.Authorization ?? '').replace('Bearer ', '');
    requested.push({ url, method: init?.method ?? 'GET', token });
    if (url.includes('/notifications/threads/')) return { ok: true, status: 205 } as Response;
    const inbox = inboxes[token];
    if (inbox === 'fail' || inbox === undefined) return { ok: false, status: 500, statusText: 'boom' } as Response;
    return { ok: true, json: async () => inbox, headers: new Headers() } as Response;
  }));
}

function rows(db: SqlJsDatabase) {
  const res = db.exec('SELECT id, repo_full_name, host, account FROM github_notifications ORDER BY id');
  return (res[0]?.values ?? []).map((r) => ({ id: r[0], repo: r[1], host: r[2], account: r[3] }));
}

describe('notifications across accounts', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-notifications-multi';
    handlers.clear();
    requested.length = 0;
    tracked = ACCOUNTS;
    for (const k of Object.keys(inboxes)) delete inboxes[k];
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    registerHandlers(db, () => null);
    stubFetch();

    setAssignment(db, 'owner', 'barco', 'guest');
    inboxes['tok-main'] = [notif('1', 'acme/app'), notif('2', 'barco/emu'), notif('3', 'shared/lib')];
    inboxes['tok-guest'] = [notif('12', 'barco/emu'), notif('13', 'shared/lib'), notif('14', 'guestonly/x')];
    inboxes['tok-ghe'] = [notif('1', 'corp-org/svc')];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  it('stores each repo once, under the account that serves it, with host-safe ids', async () => {
    const result = await syncGitHubNotifications(db, () => null);
    expect(result.ok).toBe(true);

    expect(rows(db)).toEqual([
      { id: '1', repo: 'acme/app', host: 'github.com', account: 'main' },
      { id: '12', repo: 'barco/emu', host: 'github.com', account: 'guest' },
      { id: '14', repo: 'guestonly/x', host: 'github.com', account: 'guest' },
      { id: '3', repo: 'shared/lib', host: 'github.com', account: 'main' },
      // Thread ids restart per instance, so GHE.com ones are prefixed with their host.
      { id: 'corp.ghe.com|1', repo: 'corp-org/svc', host: 'corp.ghe.com', account: 'bob@corp.ghe.com' },
    ]);
  });

  it('asks every host with the matching token', async () => {
    await syncGitHubNotifications(db, () => null);
    const listCalls = requested.filter((r) => r.url.includes('/notifications?'));
    expect(listCalls.map((r) => [new URL(r.url).host, r.token])).toEqual([
      ['api.github.com', 'tok-main'],
      ['api.github.com', 'tok-guest'],
      ['api.corp.ghe.com', 'tok-ghe'],
    ]);
  });

  it('keeps an account\'s earlier notifications when its sync fails, and still syncs the others', async () => {
    await syncGitHubNotifications(db, () => null);
    inboxes['tok-guest'] = 'fail';
    inboxes['tok-main'] = [notif('1', 'acme/app')];

    await syncGitHubNotifications(db, () => null);

    expect(rows(db).map((r) => `${r.account}:${r.id}`)).toEqual([
      'main:1', 'guest:12', 'guest:14', 'bob@corp.ghe.com:corp.ghe.com|1',
    ]);
  });

  it('throws when every account fails', async () => {
    for (const k of ['tok-main', 'tok-guest', 'tok-ghe']) inboxes[k] = 'fail';
    await expect(syncGitHubNotifications(db, () => null)).rejects.toThrow(/notifications API error/);
  });

  it('drops notifications of accounts that are no longer tracked', async () => {
    await syncGitHubNotifications(db, () => null);
    tracked = ACCOUNTS.filter((a) => a.id !== 'guest');
    await syncGitHubNotifications(db, () => null);
    expect(rows(db).some((r) => r.account === 'guest')).toBe(false);
  });

  it('marks a notification read as its own account, on its own host, with the bare thread id', async () => {
    await syncGitHubNotifications(db, () => null);
    requested.length = 0;

    const dismiss = handlers.get('github:dismiss-notification')!;
    await dismiss({}, 'corp.ghe.com|1');
    await dismiss({}, '12');

    const patches = requested.filter((r) => r.method === 'PATCH');
    expect(patches.map((r) => [r.url, r.token])).toEqual([
      ['https://api.corp.ghe.com/notifications/threads/1', 'tok-ghe'],
      ['https://api.github.com/notifications/threads/12', 'tok-guest'],
    ]);
    expect(rows(db).map((r) => r.id)).not.toContain('12');
    expect(rows(db).map((r) => r.id)).not.toContain('corp.ghe.com|1');
  });
});
