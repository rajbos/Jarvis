/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Notifications plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the notifications handlers against a
 * real in-memory DB, then invokes captured handlers directly to verify:
 * - Input validation guards
 * - `markNotificationRead` (not DELETE) is called when dismissing
 * - Auto-dismiss log CRUD
 * - `check-merged-dependabot-prs` and `check-deleted-branches` auth guards
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

vi.mock('../../src/services/github-oauth', () => ({
  loadGitHubAuth: vi.fn(() => null),
}));

vi.mock('../../src/services/github-notifications', () => ({
  fetchNotifications: vi.fn().mockResolvedValue([]),
  fetchNotificationsForRepo: vi.fn().mockResolvedValue([]),
  storeNotifications: vi.fn(),
  storeNotificationsForOwner: vi.fn(),
  storeNotificationsForRepo: vi.fn(),
  getNotificationCounts: vi.fn().mockReturnValue({ total: 0, perOrg: {}, perRepo: {}, starredTotal: 0, fetchedAt: null }),
  listNotificationsForRepo: vi.fn().mockReturnValue([]),
  listNotificationsForOwner: vi.fn().mockReturnValue([]),
  listNotificationsForStarred: vi.fn().mockReturnValue([]),
  listPrNotifications: vi.fn().mockReturnValue([]),
  listIssueNotifications: vi.fn().mockReturnValue([]),
  deleteNotification: vi.fn(),
  markNotificationRead: vi.fn().mockResolvedValue(undefined),
  listMergedDependabotPRNotifications: vi.fn().mockResolvedValue([]),
  listDeletedBranchNotifications: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/services/github-workflows', () => ({
  fetchAndStoreWorkflowData: vi.fn().mockResolvedValue({ runsStored: 0 }),
}));

vi.mock('../../src/plugins/notifications/workflow-cache', () => ({
  isWorkflowDataFresh: vi.fn().mockReturnValue(true),
}));

import { registerHandlers } from '../../src/plugins/notifications/handler';
import { loadGitHubAuth } from '../../src/services/github-oauth';
import {
  markNotificationRead,
  deleteNotification,
  listNotificationsForRepo,
  listMergedDependabotPRNotifications,
  listDeletedBranchNotifications,
  getNotificationCounts,
} from '../../src/services/github-notifications';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

type AuthStub = { accessToken: string; login: string };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Notifications plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-notifications-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerHandlers(db, () => null);

    vi.mocked(loadGitHubAuth).mockReturnValue(null);
  });

  afterEach(() => {
    db.close();
  });

  // ── github:fetch-notifications ────────────────────────────────────────────

  describe('github:fetch-notifications', () => {
    it('returns error when not authenticated', async () => {
      const result = (await callHandler('github:fetch-notifications')) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('returns notification counts when authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      const result = await callHandler('github:fetch-notifications');
      expect(getNotificationCounts).toHaveBeenCalled();
      expect(result).toMatchObject({ total: 0 });
    });
  });

  // ── github:notification-counts ────────────────────────────────────────────

  describe('github:notification-counts', () => {
    it('returns counts from the DB', () => {
      const result = callHandler('github:notification-counts');
      expect(getNotificationCounts).toHaveBeenCalledWith(db);
      expect(result).toMatchObject({ total: 0 });
    });
  });

  // ── github:fetch-notifications-for-owner ──────────────────────────────────

  describe('github:fetch-notifications-for-owner', () => {
    it('returns error for empty owner', async () => {
      const result = (await callHandler('github:fetch-notifications-for-owner', '')) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Invalid owner' });
    });

    it('returns error for non-string owner', async () => {
      const result = (await callHandler('github:fetch-notifications-for-owner', 42)) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Invalid owner' });
    });

    it('returns error when not authenticated', async () => {
      const result = (await callHandler('github:fetch-notifications-for-owner', 'myorg')) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });
  });

  // ── github:fetch-notifications-for-repo ───────────────────────────────────

  describe('github:fetch-notifications-for-repo', () => {
    it('returns error for repo name without slash', async () => {
      const result = (await callHandler('github:fetch-notifications-for-repo', 'noslash')) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Invalid repo' });
    });

    it('returns error for non-string repo name', async () => {
      const result = (await callHandler('github:fetch-notifications-for-repo', 123)) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Invalid repo' });
    });

    it('returns error when not authenticated', async () => {
      const result = (await callHandler('github:fetch-notifications-for-repo', 'owner/repo')) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });
  });

  // ── github:list-notifications-for-repo ───────────────────────────────────

  describe('github:list-notifications-for-repo', () => {
    it('returns empty array for empty repoFullName', () => {
      const result = callHandler('github:list-notifications-for-repo', '');
      expect(result).toEqual([]);
    });

    it('returns empty array for non-string repoFullName', () => {
      const result = callHandler('github:list-notifications-for-repo', null);
      expect(result).toEqual([]);
    });

    it('delegates to service for valid repoFullName', () => {
      callHandler('github:list-notifications-for-repo', 'owner/repo');
      expect(listNotificationsForRepo).toHaveBeenCalledWith(db, 'owner/repo');
    });
  });

  // ── github:list-notifications-for-owner ──────────────────────────────────

  describe('github:list-notifications-for-owner', () => {
    it('returns empty array for empty owner', () => {
      const result = callHandler('github:list-notifications-for-owner', '');
      expect(result).toEqual([]);
    });

    it('returns empty array for non-string owner', () => {
      const result = callHandler('github:list-notifications-for-owner', 0);
      expect(result).toEqual([]);
    });
  });

  // ── github:dismiss-notification ───────────────────────────────────────────

  describe('github:dismiss-notification', () => {
    it('does nothing for empty id', async () => {
      await callHandler('github:dismiss-notification', '');
      expect(markNotificationRead).not.toHaveBeenCalled();
      expect(deleteNotification).not.toHaveBeenCalled();
    });

    it('does nothing for non-string id', async () => {
      await callHandler('github:dismiss-notification', 42);
      expect(markNotificationRead).not.toHaveBeenCalled();
      expect(deleteNotification).not.toHaveBeenCalled();
    });

    it('calls markNotificationRead (not delete) when authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      await callHandler('github:dismiss-notification', 'notif-123');

      // Must use PATCH (markNotificationRead), never DELETE
      expect(markNotificationRead).toHaveBeenCalledWith('tok', 'notif-123');
    });

    it('deletes the notification from DB', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      await callHandler('github:dismiss-notification', 'notif-123');
      expect(deleteNotification).toHaveBeenCalledWith(db, 'notif-123');
    });

    it('still deletes the local notification when markNotificationRead fails', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      vi.mocked(markNotificationRead).mockRejectedValueOnce(new Error('network error'));

      await callHandler('github:dismiss-notification', 'notif-456');

      // Local deletion should still happen even if remote call fails
      expect(deleteNotification).toHaveBeenCalledWith(db, 'notif-456');
    });

    it('deletes the local notification even when not authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue(null);
      await callHandler('github:dismiss-notification', 'notif-789');

      expect(markNotificationRead).not.toHaveBeenCalled();
      expect(deleteNotification).toHaveBeenCalledWith(db, 'notif-789');
    });
  });

  // ── github:check-merged-dependabot-prs ───────────────────────────────────

  describe('github:check-merged-dependabot-prs', () => {
    it('returns empty array when not authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue(null);
      const result = await callHandler('github:check-merged-dependabot-prs');
      expect(result).toEqual([]);
      expect(listMergedDependabotPRNotifications).not.toHaveBeenCalled();
    });

    it('delegates to listMergedDependabotPRNotifications when authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      vi.mocked(listMergedDependabotPRNotifications).mockResolvedValueOnce([
        { id: '1', subject_title: 'chore(deps): bump foo' } as never,
      ]);
      const result = (await callHandler('github:check-merged-dependabot-prs')) as unknown[];
      expect(result).toHaveLength(1);
      expect(listMergedDependabotPRNotifications).toHaveBeenCalledWith(db, 'tok');
    });

    it('returns empty array when service throws', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      vi.mocked(listMergedDependabotPRNotifications).mockRejectedValueOnce(new Error('network error'));
      const result = await callHandler('github:check-merged-dependabot-prs');
      expect(result).toEqual([]);
    });
  });

  // ── github:check-deleted-branches ────────────────────────────────────────

  describe('github:check-deleted-branches', () => {
    it('returns empty array when not authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue(null);
      const result = await callHandler('github:check-deleted-branches');
      expect(result).toEqual([]);
      expect(listDeletedBranchNotifications).not.toHaveBeenCalled();
    });

    it('delegates to listDeletedBranchNotifications when authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      vi.mocked(listDeletedBranchNotifications).mockResolvedValueOnce([
        { id: '2', subject_title: 'delete-branch' } as never,
      ]);
      const result = (await callHandler('github:check-deleted-branches')) as unknown[];
      expect(result).toHaveLength(1);
    });

    it('returns empty array when service throws', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ accessToken: 'tok', login: 'user' } as AuthStub);
      vi.mocked(listDeletedBranchNotifications).mockRejectedValueOnce(new Error('error'));
      const result = await callHandler('github:check-deleted-branches');
      expect(result).toEqual([]);
    });
  });

  // ── github:log-auto-dismiss ────────────────────────────────────────────────

  describe('github:log-auto-dismiss', () => {
    it('does nothing for non-array entries', () => {
      callHandler('github:log-auto-dismiss', 'not-an-array');
      const rows = db.exec('SELECT COUNT(*) FROM auto_dismiss_log');
      expect(rows[0].values[0][0]).toBe(0);
    });

    it('does nothing for empty array', () => {
      callHandler('github:log-auto-dismiss', []);
      const rows = db.exec('SELECT COUNT(*) FROM auto_dismiss_log');
      expect(rows[0].values[0][0]).toBe(0);
    });

    it('inserts valid entries into auto_dismiss_log', () => {
      callHandler('github:log-auto-dismiss', [
        {
          notification_id: 'notif-1',
          reason: 'merged_dependabot_pr',
          repo_full_name: 'owner/repo',
          subject_title: 'chore(deps): bump lodash',
          subject_type: 'PullRequest',
        },
      ]);
      const rows = db.exec('SELECT notification_id, reason FROM auto_dismiss_log');
      expect(rows[0].values).toHaveLength(1);
      expect(rows[0].values[0][0]).toBe('notif-1');
      expect(rows[0].values[0][1]).toBe('merged_dependabot_pr');
    });

    it('skips entries with missing notification_id or reason', () => {
      callHandler('github:log-auto-dismiss', [
        { notification_id: null, reason: 'test' },
        { notification_id: 'notif-2', reason: null },
        { notification_id: 'notif-3', reason: 'valid_reason' },
      ]);
      const rows = db.exec('SELECT COUNT(*) FROM auto_dismiss_log');
      expect(rows[0].values[0][0]).toBe(1);
    });
  });

  // ── github:list-auto-dismiss-log ──────────────────────────────────────────

  describe('github:list-auto-dismiss-log', () => {
    it('returns empty array on a fresh DB', () => {
      const result = callHandler('github:list-auto-dismiss-log');
      expect(result).toEqual([]);
    });

    it('returns logged entries after they have been stored', () => {
      db.run(
        `INSERT INTO auto_dismiss_log (notification_id, dismissed_at, reason, repo_full_name, subject_title, subject_type)
         VALUES ('n1', datetime('now'), 'test_reason', 'owner/repo', 'Some PR', 'PullRequest')`,
      );
      const result = (callHandler('github:list-auto-dismiss-log')) as Record<string, unknown>[];
      expect(result).toHaveLength(1);
      expect(result[0].notification_id).toBe('n1');
      expect(result[0].reason).toBe('test_reason');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO auto_dismiss_log (notification_id, dismissed_at, reason)
           VALUES ('notif-${i}', datetime('now', '-${i} minutes'), 'reason')`,
        );
      }
      const result = (callHandler('github:list-auto-dismiss-log', 3)) as unknown[];
      expect(result).toHaveLength(3);
    });

    it('uses default limit of 200 for invalid limit param', () => {
      const result = callHandler('github:list-auto-dismiss-log', -1);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── github:auto-dismiss-stats ─────────────────────────────────────────────

  describe('github:auto-dismiss-stats', () => {
    it('returns weekly and monthly keys on a fresh DB', () => {
      const result = callHandler('github:auto-dismiss-stats') as Record<string, unknown>;
      expect(Array.isArray(result.weekly)).toBe(true);
      expect(Array.isArray(result.monthly)).toBe(true);
    });

    it('aggregates entries by week and month after log insertion', () => {
      db.run(
        `INSERT INTO auto_dismiss_log (notification_id, dismissed_at, reason)
         VALUES ('n1', datetime('now'), 'r1'), ('n2', datetime('now'), 'r2')`,
      );
      const result = callHandler('github:auto-dismiss-stats') as Record<string, unknown>;
      const weekly = result.weekly as { count: number }[];
      const total = weekly.reduce((sum, r) => sum + r.count, 0);
      expect(total).toBe(2);
    });
  });
});
