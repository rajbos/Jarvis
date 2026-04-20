/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Dashboard plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the dashboard handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify shape and
 * error-handling behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

// ── Track registered handlers ─────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/git-health', () => ({
  checkRepoHealth: vi.fn(
    (id: number, localPath: string, name: string) => ({
      id,
      localPath,
      name,
      linkedGithubRepo: null,
      notifCount: 0,
      failedRuns: 0,
      lastPushedAt: null,
      branches: [],
      remotes: [],
      hasUncommittedChanges: false,
    }),
  ),
  deriveWarnings: vi.fn(() => []),
}));

vi.mock('../../src/services/local-discovery', () => ({
  listLocalRepos: vi.fn(() => []),
  normalizeGitHubUrl: vi.fn(() => null),
}));

// Mock fs.existsSync — default: path does NOT contain a .git folder
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

// Mock child_process.execFile so git commands never actually run
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: vi.fn() };
});

import { registerHandlers } from '../../src/plugins/dashboard/handler';
import { listLocalRepos } from '../../src/services/local-discovery';
import { existsSync } from 'fs';
import { execFile } from 'child_process';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dashboard plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-dashboard-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── dashboard:get-summary ───────────────────────────────────────────────────

  describe('dashboard:get-summary', () => {
    it('returns a correctly-shaped summary with zero repos on a fresh DB', async () => {
      const result = (await callHandler('dashboard:get-summary')) as Record<string, unknown>;

      expect(Array.isArray(result.repos)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result.totalRepos).toBe(0);
      expect(result.reposWithWarnings).toBe(0);
      expect(result.totalNotifications).toBe(0);
      expect(result.totalFailedRuns).toBe(0);
      expect(typeof result.generatedAt).toBe('string');
    });

    it('returns the empty fallback shape when listLocalRepos throws', async () => {
      vi.mocked(listLocalRepos).mockImplementationOnce(() => {
        throw new Error('disk error');
      });

      const result = (await callHandler('dashboard:get-summary')) as Record<string, unknown>;

      expect(result.totalRepos).toBe(0);
      expect(result.repos).toEqual([]);
      expect(typeof result.generatedAt).toBe('string');
    });
  });

  // ── dashboard:get-recent-failed-runs ────────────────────────────────────────

  describe('dashboard:get-recent-failed-runs', () => {
    it('returns an empty array on a fresh DB', async () => {
      const result = await callHandler('dashboard:get-recent-failed-runs');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('returns failed runs present in the DB', async () => {
      db.run(
        `INSERT INTO github_workflow_runs
           (id, repo_full_name, workflow_name, head_branch, conclusion, run_started_at, html_url)
         VALUES
           ('run1','owner/repo','CI','main','failure', datetime('now', '-1 day'), 'https://example.com/1')`,
      );

      const result = (await callHandler(
        'dashboard:get-recent-failed-runs',
      )) as Record<string, unknown>[];

      expect(result).toHaveLength(1);
      expect(result[0].repo_full_name).toBe('owner/repo');
      expect(result[0].conclusion).toBe('failure');
    });
  });

  // ── dashboard:push-branch-upstream ──────────────────────────────────────────

  describe('dashboard:push-branch-upstream', () => {
    it('returns error when repoPath is not a git repository', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = (await callHandler(
        'dashboard:push-branch-upstream',
        '/not/a/repo',
        'main',
      )) as Record<string, unknown>;

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Not a git repository');
    });

    it('returns error for an invalid branch name', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const result = (await callHandler(
        'dashboard:push-branch-upstream',
        '/some/repo',
        'feature; rm -rf /',
      )) as Record<string, unknown>;

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Invalid branch name');
    });

    it('returns ok:true when git push succeeds', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execFile).mockImplementation(
        (_cmd, _args, _opts, callback) => {
          (callback as (err: null, stdout: string, stderr: string) => void)(
            null,
            '',
            'Branch set up to track origin/main.',
          );
          return {} as ReturnType<typeof execFile>;
        },
      );

      const result = (await callHandler(
        'dashboard:push-branch-upstream',
        '/some/repo',
        'main',
      )) as Record<string, unknown>;

      expect(result.ok).toBe(true);
    });

    it('returns ok:false when git push fails', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execFile).mockImplementation(
        (_cmd, _args, _opts, callback) => {
          const err = Object.assign(new Error('push failed'), { code: 1 });
          (callback as (err: Error, stdout: string, stderr: string) => void)(
            err,
            '',
            'error: failed to push some refs',
          );
          return {} as ReturnType<typeof execFile>;
        },
      );

      const result = (await callHandler(
        'dashboard:push-branch-upstream',
        '/some/repo',
        'main',
      )) as Record<string, unknown>;

      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });
});
