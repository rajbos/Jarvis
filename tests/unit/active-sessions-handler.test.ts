/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import type { ActiveSessionsSnapshot, PrReadiness } from '../../src/plugins/types';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const notificationShow = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  Notification: Object.assign(vi.fn().mockImplementation(function () { return { show: notificationShow }; }), { isSupported: () => true }),
  shell: { openExternal: vi.fn(async () => undefined) },
  clipboard: { writeText: vi.fn() },
}));

vi.mock('../../src/services/process-launch', () => ({
  openTerminal: vi.fn(),
  resolveDirectory: vi.fn((p: string) => (p.startsWith('C:\missing') ? null : p)),
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/github-repo-access', () => ({
  accessForPrimary: vi.fn(async () => ({ id: 'me', host: 'github.com', login: 'me', token: 'tok', source: 'oauth', isPrimary: true })),
  // An org repo resolves to the org account.
  accessForRepo: vi.fn(async () => ({ id: 'me-org', host: 'github.com', login: 'me-org', token: 'tok-org', source: 'gh-cli', isPrimary: false })),
  ghCliFallbacks: vi.fn(async () => []),
}));

vi.mock('../../src/services/active-sessions', () => ({
  collectActiveSessions: vi.fn(),
}));

import { Notification, shell, clipboard } from 'electron';
import { openTerminal } from '../../src/services/process-launch';
import {
  recordReadiness,
  refreshActiveSessions,
  registerHandlers,
  resetActiveSessionsState,
  runActiveSessionsSweep,
} from '../../src/plugins/active-sessions/handler';
import { collectActiveSessions } from '../../src/services/active-sessions';
import { saveDatabase } from '../../src/storage/database';
import { ghCliFallbacks } from '../../src/services/github-repo-access';

function pr(overrides: Partial<PrReadiness> = {}): PrReadiness {
  const stage = { light: 'green' as const, label: 'ok', detail: 'ok', blocking: false };
  return {
    repoFullName: 'me/repo',
    prNumber: 1,
    title: 'Title',
    url: 'https://github.com/me/repo/pull/1',
    state: 'OPEN',
    isDraft: false,
    headSha: 'sha1',
    headRef: 'feature',
    checks: { ...stage, total: 1, pending: 0, failed: 0, passed: 1 },
    copilotReview: { ...stage, status: 'completed' },
    ready: true,
    waitingOn: [],
    checkedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function snapshotWith(prs: PrReadiness[]): ActiveSessionsSnapshot {
  return {
    entries: prs.map((p, i) => ({
      session: {
        key: `k${i}`, provider: 'copilot', origin: 'local', client: 'Copilot app', sessionId: `s${i}`, title: null,
        cwd: null, repoFullName: p.repoFullName, branch: p.headRef, activity: 'idle', startedAt: null, updatedAt: null,
        cloudTaskId: null, pid: 1,
      },
      agent: { light: 'green', label: 'Idle', detail: '', blocking: false },
      pr: p,
      prError: null,
      verdict: p.ready ? 'ready' : 'waiting',
      verdictLabel: p.ready ? 'Ready for review' : 'Waiting',
    })),
    sources: {
      copilotLocal: { ok: true, count: prs.length },
      claudeLocal: { ok: true, count: 0 },
      copilotCloud: { ok: false, count: 0, error: 'Agent tasks API 403' },
    },
    readyCount: prs.filter((p) => p.ready).length,
    refreshedAt: '2026-03-01T00:00:00Z',
  };
}

let db: SqlJsDatabase;

beforeEach(async () => {
  vi.clearAllMocks();
  handlers.clear();
  resetActiveSessionsState();
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(getSchema());
});

describe('recordReadiness', () => {
  it('reports a PR as newly ready only once per head commit', () => {
    expect(recordReadiness(db, [pr()])).toHaveLength(1);
    expect(recordReadiness(db, [pr()])).toHaveLength(0);

    // New commit: not ready yet, then ready again → notify for the new sha
    expect(recordReadiness(db, [pr({ headSha: 'sha2', ready: false, waitingOn: ['checks'] })])).toHaveLength(0);
    const row = db.exec('SELECT head_sha, ready, waiting_on, ready_notified_sha FROM pr_readiness')[0].values[0];
    expect(row).toEqual(['sha2', 0, 'checks', 'sha1']);
    expect(recordReadiness(db, [pr({ headSha: 'sha2' })])).toHaveLength(1);
  });

  it('does not report PRs that are not ready', () => {
    expect(recordReadiness(db, [pr({ ready: false, waitingOn: ['copilot_review'] })])).toEqual([]);
  });

  it('holds the notification for held PRs without marking them notified', () => {
    expect(recordReadiness(db, [pr()], new Set(['me/repo#1']))).toEqual([]);
    expect(db.exec('SELECT ready, ready_notified_sha FROM pr_readiness')[0].values[0]).toEqual([1, null]);
    expect(recordReadiness(db, [pr()])).toHaveLength(1);
  });
});

describe('refreshActiveSessions', () => {
  it('persists readiness, notifies once and pushes the snapshot to the renderer', async () => {
    vi.mocked(collectActiveSessions).mockResolvedValue(snapshotWith([pr(), pr({ prNumber: 2, ready: false, waitingOn: ['checks'] })]));
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };

    const snap = await refreshActiveSessions(db, () => win as never);

    const opts = vi.mocked(collectActiveSessions).mock.calls[0][0];
    expect(opts).toMatchObject({ accessToken: 'tok', accessAccount: 'me' });
    const access = await opts.accessForRepo!('org/app');
    expect(access).toMatchObject({ token: 'tok-org', account: 'me-org' });
    // The GitHub CLI's logins back up a token that can't see the repo.
    vi.mocked(ghCliFallbacks).mockResolvedValueOnce([{ id: 'me', host: 'github.com', login: 'me', token: 'cli-me', source: 'gh-cli' }]);
    await expect(access!.fallbacks!()).resolves.toEqual([{ token: 'cli-me', account: 'me' }]);
    expect(saveDatabase).toHaveBeenCalled();
    expect(Notification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Notification).mock.calls[0][0]).toMatchObject({ title: 'PR ready for your review' });
    expect(notificationShow).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('active-sessions:updated', snap);

    await refreshActiveSessions(db, () => null);
    expect(Notification).toHaveBeenCalledTimes(1);
  });

  it('waits to notify until the linked agent has stopped working', async () => {
    const working = snapshotWith([pr()]);
    working.entries[0].session.activity = 'working';
    vi.mocked(collectActiveSessions).mockResolvedValue(working);
    await refreshActiveSessions(db, () => null);
    expect(Notification).not.toHaveBeenCalled();

    vi.mocked(collectActiveSessions).mockResolvedValue(snapshotWith([pr()]));
    await refreshActiveSessions(db, () => null);
    expect(Notification).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight sweep between concurrent callers', async () => {
    let resolve!: (s: ActiveSessionsSnapshot) => void;
    vi.mocked(collectActiveSessions).mockReturnValue(new Promise((r) => { resolve = r; }));
    const a = refreshActiveSessions(db, () => null);
    const b = refreshActiveSessions(db, () => null);
    resolve(snapshotWith([]));
    expect(await a).toBe(await b);
    expect(collectActiveSessions).toHaveBeenCalledTimes(1);
  });
});

describe('runActiveSessionsSweep', () => {
  it('summarises the sweep for the task log', async () => {
    vi.mocked(collectActiveSessions).mockResolvedValue(snapshotWith([pr(), pr({ prNumber: 2, ready: false, waitingOn: ['checks'] })]));
    expect(await runActiveSessionsSweep(db, () => null)).toEqual({
      sessions: 2, ready: 1, waiting: 1, errors: ['copilotCloud: Agent tasks API 403'],
    });
  });
});

describe('IPC handlers', () => {
  it('returns null before the first sweep and the latest snapshot afterwards', async () => {
    registerHandlers(db, () => null);
    const get = handlers.get('active-sessions:get')!;
    const refresh = handlers.get('active-sessions:refresh')!;
    expect(await get({})).toBeNull();

    const snapshot = snapshotWith([pr()]);
    vi.mocked(collectActiveSessions).mockResolvedValue(snapshot);
    expect(await refresh({})).toEqual(snapshot);
    expect(await get({})).toEqual(snapshot);
  });

  it('wraps sweep failures in the IPC error shape', async () => {
    registerHandlers(db, () => null);
    vi.mocked(collectActiveSessions).mockRejectedValue(new Error('boom'));
    expect(await handlers.get('active-sessions:refresh')!({})).toMatchObject({ ok: false, error: expect.stringContaining('boom') });
  });
});

describe('active-sessions:run-action', () => {
  const failing = pr({
    ready: true,
    checks: { light: 'red', label: '2 failed', detail: '', blocking: false, total: 3, pending: 0, failed: 2, passed: 1, failedNames: ['build', 'lint'] },
    baseRef: 'main',
    mergeable: 'CONFLICTING',
  });

  async function snapshotReady(entryPatch: Partial<ActiveSessionsSnapshot['entries'][number]['session']> = {}) {
    const snapshot = snapshotWith([failing]);
    Object.assign(snapshot.entries[0].session, entryPatch);
    vi.mocked(collectActiveSessions).mockResolvedValue(snapshot);
    registerHandlers(db, () => null);
    await handlers.get('active-sessions:refresh')!({});
    return snapshot.entries[0].session.key;
  }

  it('rejects bad arguments and unknown sessions', async () => {
    registerHandlers(db, () => null);
    expect(await handlers.get('active-sessions:run-action')!({}, 'k0', 'nope')).toEqual({ ok: false, error: 'Invalid arguments' });
    expect(await handlers.get('active-sessions:run-action')!({}, 'k0', 'open')).toMatchObject({ ok: false, error: expect.stringContaining('refresh') });
  });

  it('opens Copilot app sessions through a ghapp:// deep link', async () => {
    const key = await snapshotReady({ client: 'Copilot app', sessionId: 'app-1' });
    const result = await handlers.get('active-sessions:run-action')!({}, key, 'open');
    expect(result).toMatchObject({ ok: true, kind: 'deep-link' });
    expect(vi.mocked(shell.openExternal)).toHaveBeenCalledWith('ghapp://sessions/app-1');
    expect(vi.mocked(clipboard.writeText)).not.toHaveBeenCalled();
  });

  it('resumes Claude Code in a terminal with the fix-checks prompt', async () => {
    const key = await snapshotReady({ provider: 'claude', client: 'Claude Code', sessionId: 'c-1', cwd: 'C:\src\repo' });
    const result = await handlers.get('active-sessions:run-action')!({}, key, 'fix_checks');
    expect(result).toMatchObject({ ok: true, kind: 'terminal', prompt: expect.stringContaining('build, lint') });
    const [cwd, command] = vi.mocked(openTerminal).mock.calls[0];
    expect(cwd).toBe('C:\src\repo');
    expect(command).toMatchObject({ file: 'claude', args: ['--resume', 'c-1', expect.stringContaining('build, lint')] });
  });

  it('fails cleanly when the session folder is gone', async () => {
    const key = await snapshotReady({ provider: 'claude', client: 'Claude Code', cwd: 'C:\missing\repo' });
    expect(await handlers.get('active-sessions:run-action')!({}, key, 'open')).toMatchObject({ ok: false, error: expect.stringContaining('missing') });
    expect(vi.mocked(openTerminal)).not.toHaveBeenCalled();
  });

  it('asks @copilot to resolve conflicts on a cloud task via a PR comment', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const key = await snapshotReady({ origin: 'cloud', client: 'Copilot cloud agent', cloudTaskId: 't1', cwd: null });
    const result = await handlers.get('active-sessions:run-action')!({}, key, 'resolve_conflicts');
    expect(result).toMatchObject({ ok: true, kind: 'pr-comment', message: expect.stringContaining('as @me-org') });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.github.com/repos/me/repo/issues/1/comments');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-org');
    expect(JSON.parse(init.body)).toEqual({ body: expect.stringMatching(/^@copilot The pull request .*merge conflicts/) });
    vi.unstubAllGlobals();
  });

  it('reports why a prompt action is unavailable instead of doing anything', async () => {
    vi.mocked(collectActiveSessions).mockResolvedValue(snapshotWith([pr()]));
    registerHandlers(db, () => null);
    await handlers.get('active-sessions:refresh')!({});
    expect(await handlers.get('active-sessions:run-action')!({}, 'k0', 'fix_checks')).toEqual({ ok: false, error: 'No failing checks.' });
    expect(vi.mocked(shell.openExternal)).not.toHaveBeenCalled();
  });
});
