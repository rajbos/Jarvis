/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * OneDrive plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the onedrive handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify:
 * - Input validation guards
 * - Root add / remove / list
 * - Folder discovery and rescan
 * - OneNote cache reads
 * - shell:open-url URL scheme validation
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
  shell: { openExternal: vi.fn().mockResolvedValue('') },
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

vi.mock('../../src/services/onedrive', () => ({
  listOnedriveRoots: vi.fn().mockReturnValue([]),
  addOnedriveRoot: vi.fn().mockImplementation((_db: unknown, path: string, label: string) => ({
    id: 1,
    path,
    label,
  })),
  removeOnedriveRoot: vi.fn(),
  discoverCustomerFolderForGroup: vi.fn().mockReturnValue([]),
  getCustomerFolderInfo: vi.fn().mockReturnValue([]),
  scanFilesForFolder: vi.fn().mockReturnValue(5),
  listFilesForFolder: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/services/onenote-reader', () => ({
  readOneNoteSection: vi.fn().mockReturnValue({ pages: [] }),
}));

vi.mock('../../src/services/onedrive-onenote-cache', () => ({
  cacheOneNoteFilesForGroup: vi.fn().mockResolvedValue({ cached: 0 }),
  getCachedPages: vi.fn().mockReturnValue([]),
  getOneNoteCacheForGroup: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/services/url-shortcut', () => ({
  readUrlShortcut: vi.fn().mockReturnValue({ url: 'https://example.com', title: 'Example' }),
}));

vi.mock('../../src/services/groups', () => ({
  getGroup: vi.fn().mockReturnValue(null),
}));

import { registerHandlers } from '../../src/plugins/onedrive/handler';
import {
  listOnedriveRoots,
  addOnedriveRoot,
  removeOnedriveRoot,
  discoverCustomerFolderForGroup,
  getCustomerFolderInfo,
  scanFilesForFolder,
  listFilesForFolder,
} from '../../src/services/onedrive';
import { getGroup } from '../../src/services/groups';
import { getCachedPages, getOneNoteCacheForGroup } from '../../src/services/onedrive-onenote-cache';
import { shell } from 'electron';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OneDrive plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-onedrive-handler';
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

  // ── onedrive:list-roots ───────────────────────────────────────────────────

  describe('onedrive:list-roots', () => {
    it('returns empty array on a fresh DB', () => {
      const result = callHandler('onedrive:list-roots');
      expect(listOnedriveRoots).toHaveBeenCalledWith(db);
      expect(result).toEqual([]);
    });
  });

  // ── onedrive:add-root ─────────────────────────────────────────────────────

  describe('onedrive:add-root', () => {
    it('returns error for empty label', async () => {
      const result = (await callHandler('onedrive:add-root', '', '/some/path')) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Label is required' });
    });

    it('returns error for whitespace-only label', async () => {
      const result = (await callHandler('onedrive:add-root', '   ', '/some/path')) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Label is required' });
    });

    it('returns canceled when dialog is canceled and no path provided', async () => {
      const result = (await callHandler('onedrive:add-root', 'My Root')) as Record<string, unknown>;
      expect(result.canceled).toBe(true);
    });

    it('adds root and returns ok:true when path is provided directly', async () => {
      const result = (await callHandler('onedrive:add-root', 'Work', '/onedrive/work')) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(addOnedriveRoot).toHaveBeenCalledWith(db, '/onedrive/work', 'Work');
    });

    it('returns error when addOnedriveRoot throws', async () => {
      vi.mocked(addOnedriveRoot).mockImplementationOnce(() => {
        throw new Error('duplicate path');
      });
      const result = (await callHandler('onedrive:add-root', 'Work', '/onedrive/work')) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });

  // ── onedrive:remove-root ──────────────────────────────────────────────────

  describe('onedrive:remove-root', () => {
    it('returns error for non-number rootId', () => {
      const result = callHandler('onedrive:remove-root', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid rootId' });
    });

    it('removes root and returns ok:true for valid rootId', () => {
      const result = callHandler('onedrive:remove-root', 1);
      expect(result).toEqual({ ok: true });
      expect(removeOnedriveRoot).toHaveBeenCalledWith(db, 1);
    });

    it('returns error when service throws', () => {
      vi.mocked(removeOnedriveRoot).mockImplementationOnce(() => {
        throw new Error('not found');
      });
      const result = callHandler('onedrive:remove-root', 99) as Record<string, unknown>;
      expect(result.ok).toBe(false);
    });
  });

  // ── onedrive:discover-for-group ───────────────────────────────────────────

  describe('onedrive:discover-for-group', () => {
    it('returns error for non-number groupId', () => {
      const result = callHandler('onedrive:discover-for-group', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid groupId' });
    });

    it('returns error when group is not found', () => {
      vi.mocked(getGroup).mockReturnValueOnce(null);
      const result = callHandler('onedrive:discover-for-group', 999) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Group not found' });
    });

    it('returns ok:true with folders when group exists', () => {
      vi.mocked(getGroup).mockReturnValueOnce({ id: 1, name: 'Acme', created_at: '', updated_at: '', ruddr_project_name: null, ruddr_project_paths: null });
      vi.mocked(discoverCustomerFolderForGroup).mockReturnValueOnce([
        { id: 10, status: 'found' } as never,
      ]);
      const result = callHandler('onedrive:discover-for-group', 1) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(discoverCustomerFolderForGroup).toHaveBeenCalledWith(db, 1, 'Acme');
      // Should attempt to scan files for found folder
      expect(scanFilesForFolder).toHaveBeenCalledWith(db, 10);
    });
  });

  // ── onedrive:get-folder-info ──────────────────────────────────────────────

  describe('onedrive:get-folder-info', () => {
    it('returns empty array for non-number groupId', () => {
      const result = callHandler('onedrive:get-folder-info', 'bad');
      expect(result).toEqual([]);
    });

    it('delegates to getCustomerFolderInfo for valid groupId', () => {
      callHandler('onedrive:get-folder-info', 1);
      expect(getCustomerFolderInfo).toHaveBeenCalledWith(db, 1);
    });
  });

  // ── onedrive:rescan-files ─────────────────────────────────────────────────

  describe('onedrive:rescan-files', () => {
    it('returns error for non-number folderId', () => {
      const result = callHandler('onedrive:rescan-files', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid folderId' });
    });

    it('scans and returns ok:true with fileCount', () => {
      const result = callHandler('onedrive:rescan-files', 1) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.fileCount).toBe(5);
      expect(scanFilesForFolder).toHaveBeenCalledWith(db, 1);
    });

    it('returns error when service throws', () => {
      vi.mocked(scanFilesForFolder).mockImplementationOnce(() => {
        throw new Error('folder inaccessible');
      });
      const result = callHandler('onedrive:rescan-files', 1) as Record<string, unknown>;
      expect(result.ok).toBe(false);
    });
  });

  // ── onedrive:list-files-for-folder ────────────────────────────────────────

  describe('onedrive:list-files-for-folder', () => {
    it('returns empty array for non-number folderId', () => {
      const result = callHandler('onedrive:list-files-for-folder', 'bad');
      expect(result).toEqual([]);
    });

    it('delegates to listFilesForFolder for valid folderId', () => {
      callHandler('onedrive:list-files-for-folder', 1);
      expect(listFilesForFolder).toHaveBeenCalledWith(db, 1);
    });
  });

  // ── onedrive:read-onenote-file ────────────────────────────────────────────

  describe('onedrive:read-onenote-file', () => {
    it('returns error for empty filePath', () => {
      const result = callHandler('onedrive:read-onenote-file', '') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('filePath is required');
    });

    it('returns error for non-.one file', () => {
      const result = callHandler('onedrive:read-onenote-file', '/path/to/file.docx') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Only .one files are supported');
    });

    it('returns ok:true for a valid .one file path', () => {
      const result = callHandler('onedrive:read-onenote-file', '/path/to/notes.one') as Record<string, unknown>;
      expect(result.ok).toBe(true);
    });
  });

  // ── onedrive:read-url-shortcut ────────────────────────────────────────────

  describe('onedrive:read-url-shortcut', () => {
    it('returns error for empty filePath', () => {
      const result = callHandler('onedrive:read-url-shortcut', '') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('filePath is required');
    });

    it('returns error for non-.url file', () => {
      const result = callHandler('onedrive:read-url-shortcut', '/path/link.lnk') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Only .url files are supported');
    });

    it('returns ok:true for a valid .url file path', () => {
      const result = callHandler('onedrive:read-url-shortcut', '/path/link.url') as Record<string, unknown>;
      expect(result.ok).toBe(true);
    });
  });

  // ── onedrive:get-onenote-cache ────────────────────────────────────────────

  describe('onedrive:get-onenote-cache', () => {
    it('returns empty pages for non-number folderId', () => {
      const result = callHandler('onedrive:get-onenote-cache', 'bad', 'path') as Record<string, unknown>;
      expect(result).toEqual({ pages: [] });
    });

    it('returns empty pages for non-string relativePath', () => {
      const result = callHandler('onedrive:get-onenote-cache', 1, 42) as Record<string, unknown>;
      expect(result).toEqual({ pages: [] });
    });

    it('delegates to getCachedPages for valid inputs', () => {
      callHandler('onedrive:get-onenote-cache', 1, 'OneNote/Section.one');
      expect(getCachedPages).toHaveBeenCalledWith(db, 1, 'OneNote/Section.one');
    });
  });

  // ── onedrive:get-onenote-cache-for-group ──────────────────────────────────

  describe('onedrive:get-onenote-cache-for-group', () => {
    it('returns empty pages for non-number groupId', () => {
      const result = callHandler('onedrive:get-onenote-cache-for-group', 'bad') as Record<string, unknown>;
      expect(result).toEqual({ pages: [] });
    });

    it('delegates to getOneNoteCacheForGroup for valid groupId', () => {
      callHandler('onedrive:get-onenote-cache-for-group', 1);
      expect(getOneNoteCacheForGroup).toHaveBeenCalledWith(db, 1);
    });
  });

  // ── shell:open-url ────────────────────────────────────────────────────────

  describe('shell:open-url', () => {
    it('returns error for non-string url', () => {
      const result = callHandler('shell:open-url', 42) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'url is required' });
    });

    it('returns error for an unsupported URL scheme', () => {
      const result = callHandler('shell:open-url', 'ftp://example.com') as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Unsupported URL scheme' });
    });

    it('opens https URLs', () => {
      const result = callHandler('shell:open-url', 'https://example.com') as Record<string, unknown>;
      expect(result).toEqual({ ok: true });
      expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
    });

    it('opens http URLs', () => {
      const result = callHandler('shell:open-url', 'http://localhost:3000') as Record<string, unknown>;
      expect(result).toEqual({ ok: true });
    });

    it('opens onenote: URLs', () => {
      const result = callHandler('shell:open-url', 'onenote://path/to/section') as Record<string, unknown>;
      expect(result).toEqual({ ok: true });
      expect(shell.openExternal).toHaveBeenCalledWith('onenote://path/to/section');
    });
  });
});
