/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Local-repos plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the local-repos handlers against a
 * real in-memory DB, then invokes captured handlers directly to verify:
 * - Input validation guards
 * - Folder add/remove/list via the service layer
 * - link-repo DB writes
 * - scan-status reporting
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

// ── Track registered handlers ─────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

const spawnMock = vi.hoisted(() =>
  vi.fn(() => ({
    once: vi.fn().mockReturnThis(),
    unref: vi.fn(),
  })),
);

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: { openPath: vi.fn().mockResolvedValue('') },
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
  },
  // Use a class (not an arrow function) so `new BrowserWindow()` works
  BrowserWindow: class MockBrowserWindow { show = vi.fn() },
  app: { isPackaged: false },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/local-discovery', () => ({
  getScanFolders: vi.fn().mockReturnValue([]),
  addScanFolder: vi.fn(),
  removeScanFolder: vi.fn(),
  listLocalRepos: vi.fn().mockReturnValue([]),
  listLocalReposForFolder: vi.fn().mockReturnValue([]),
  linkLocalRepo: vi.fn(),
  runLocalDiscovery: vi.fn().mockResolvedValue({ reposFound: 0, elapsed: 0 }),
}));

import { registerHandlers } from '../../src/plugins/local-repos/handler';
import {
  getScanFolders,
  addScanFolder,
  removeScanFolder,
  listLocalRepos,
  listLocalReposForFolder,
  linkLocalRepo,
} from '../../src/services/local-discovery';
import { shell } from 'electron';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Local-repos plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-local-repos-handler';
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

  // ── local:get-folders ──────────────────────────────────────────────────────

  describe('local:get-folders', () => {
    it('returns empty array on a fresh DB', () => {
      const result = callHandler('local:get-folders');
      expect(getScanFolders).toHaveBeenCalledWith(db);
      expect(result).toEqual([]);
    });

    it('returns folders from service', () => {
      vi.mocked(getScanFolders).mockReturnValueOnce([
        { id: 1, path: '/home/user/repos', added_at: '' },
      ]);
      const result = callHandler('local:get-folders') as unknown[];
      expect(result).toHaveLength(1);
    });

    it('returns empty array when service throws', () => {
      vi.mocked(getScanFolders).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('local:get-folders');
      expect(result).toEqual([]);
    });
  });

  // ── local:add-folder ──────────────────────────────────────────────────────

  describe('local:add-folder', () => {
    it('adds folder when path is provided directly', async () => {
      const result = (await callHandler('local:add-folder', '/my/repos')) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.path).toBe('/my/repos');
      expect(addScanFolder).toHaveBeenCalledWith(db, '/my/repos');
    });

    it('returns canceled when dialog is canceled and no path provided', async () => {
      const result = (await callHandler('local:add-folder')) as Record<string, unknown>;
      expect(result.canceled).toBe(true);
    });

    it('returns error when addScanFolder throws', async () => {
      vi.mocked(addScanFolder).mockImplementationOnce(() => {
        throw new Error('duplicate path');
      });
      const result = (await callHandler('local:add-folder', '/my/repos')) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });

  // ── local:remove-folder ───────────────────────────────────────────────────

  describe('local:remove-folder', () => {
    it('returns error for empty folderPath', () => {
      const result = callHandler('local:remove-folder', '');
      expect(result).toEqual({ ok: false, error: 'Invalid folderPath' });
    });

    it('returns error for non-string folderPath', () => {
      const result = callHandler('local:remove-folder', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid folderPath' });
    });

    it('removes folder and returns ok:true for valid path', () => {
      const result = callHandler('local:remove-folder', '/my/repos');
      expect(result).toEqual({ ok: true });
      expect(removeScanFolder).toHaveBeenCalledWith(db, '/my/repos');
    });

    it('returns error when service throws', () => {
      vi.mocked(removeScanFolder).mockImplementationOnce(() => {
        throw new Error('not found');
      });
      const result = callHandler('local:remove-folder', '/my/repos') as Record<string, unknown>;
      expect(result.ok).toBe(false);
    });
  });

  // ── local:get-scan-status ─────────────────────────────────────────────────

  describe('local:get-scan-status', () => {
    it('returns running=false and null progress initially', () => {
      const result = callHandler('local:get-scan-status') as Record<string, unknown>;
      expect(result.running).toBe(false);
      expect(result.progress).toBeNull();
    });
  });

  // ── local:start-scan ──────────────────────────────────────────────────────

  describe('local:start-scan', () => {
    it('returns started:true', () => {
      const result = callHandler('local:start-scan') as Record<string, unknown>;
      expect(result.started).toBe(true);
    });
  });

  // ── local:list-repos ──────────────────────────────────────────────────────

  describe('local:list-repos', () => {
    it('returns empty array on a fresh DB', () => {
      const result = callHandler('local:list-repos');
      expect(listLocalRepos).toHaveBeenCalledWith(db);
      expect(result).toEqual([]);
    });

    it('returns empty array when service throws', () => {
      vi.mocked(listLocalRepos).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('local:list-repos');
      expect(result).toEqual([]);
    });
  });

  // ── local:list-repos-for-folder ───────────────────────────────────────────

  describe('local:list-repos-for-folder', () => {
    it('returns empty array for empty folderPath', () => {
      const result = callHandler('local:list-repos-for-folder', '');
      expect(result).toEqual([]);
    });

    it('returns empty array for non-string folderPath', () => {
      const result = callHandler('local:list-repos-for-folder', null);
      expect(result).toEqual([]);
    });

    it('delegates to service for valid folderPath', () => {
      callHandler('local:list-repos-for-folder', '/my/repos');
      expect(listLocalReposForFolder).toHaveBeenCalledWith(db, '/my/repos');
    });

    it('returns empty array when service throws', () => {
      vi.mocked(listLocalReposForFolder).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('local:list-repos-for-folder', '/my/repos');
      expect(result).toEqual([]);
    });
  });

  // ── local:link-repo ───────────────────────────────────────────────────────

  describe('local:link-repo', () => {
    it('returns error for non-number localRepoId', () => {
      const result = callHandler('local:link-repo', 'bad', 1);
      expect(result).toEqual({ ok: false, error: 'Invalid localRepoId' });
    });

    it('returns error for non-number non-null githubRepoId', () => {
      const result = callHandler('local:link-repo', 1, 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid githubRepoId' });
    });

    it('links with a GitHub repo ID', () => {
      const result = callHandler('local:link-repo', 1, 2);
      expect(result).toEqual({ ok: true });
      expect(linkLocalRepo).toHaveBeenCalledWith(db, 1, 2);
    });

    it('unlinks by passing null githubRepoId', () => {
      const result = callHandler('local:link-repo', 1, null);
      expect(result).toEqual({ ok: true });
      expect(linkLocalRepo).toHaveBeenCalledWith(db, 1, null);
    });

    it('returns error when service throws', () => {
      vi.mocked(linkLocalRepo).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('local:link-repo', 1, 2) as Record<string, unknown>;
      expect(result.ok).toBe(false);
    });
  });

  // ── local:open-folder ─────────────────────────────────────────────────────

  describe('local:open-folder', () => {
    it('does nothing for empty folderPath', () => {
      callHandler('local:open-folder', '');
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it('does nothing for non-string folderPath', () => {
      callHandler('local:open-folder', null);
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it('calls shell.openPath for a valid path', () => {
      callHandler('local:open-folder', '/my/repos');
      expect(shell.openPath).toHaveBeenCalledWith('/my/repos');
    });
  });
});
