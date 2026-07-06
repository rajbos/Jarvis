/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Orgs plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the orgs handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify:
 * - Org listing delegation + error path
 * - Enable/disable discovery input validation and DB writes
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
  app: { isPackaged: false },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/github-discovery', () => ({
  listOrgs: vi.fn().mockReturnValue({ orgs: [], directRepoCount: 0, starredRepoCount: 0 }),
  setOrgDiscoveryEnabled: vi.fn(),
}));

import { registerHandlers } from '../../src/plugins/orgs/handler';
import { listOrgs, setOrgDiscoveryEnabled } from '../../src/services/github-discovery';
import { saveDatabase } from '../../src/storage/database';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Orgs plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-orgs-handler';
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

  // ── github:list-orgs ──────────────────────────────────────────────────────

  describe('github:list-orgs', () => {
    it('delegates to listOrgs', () => {
      const result = callHandler('github:list-orgs');
      expect(listOrgs).toHaveBeenCalledWith(db);
      expect(result).toEqual({ orgs: [], directRepoCount: 0, starredRepoCount: 0 });
    });

    it('returns an empty array when the service throws', () => {
      vi.mocked(listOrgs).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('github:list-orgs');
      expect(result).toEqual([]);
    });
  });

  // ── github:set-org-enabled ────────────────────────────────────────────────

  describe('github:set-org-enabled', () => {
    it('returns an error for a non-string orgLogin', () => {
      const result = callHandler('github:set-org-enabled', 42, true);
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });

    it('returns an error for an empty orgLogin', () => {
      const result = callHandler('github:set-org-enabled', '', true);
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });

    it('returns an error for a non-boolean enabled value', () => {
      const result = callHandler('github:set-org-enabled', 'my-org', 'yes');
      expect(result).toEqual({ ok: false, error: 'Invalid enabled value' });
    });

    it('sets discovery enabled and saves the database', () => {
      const result = callHandler('github:set-org-enabled', 'my-org', false);
      expect(result).toEqual({ ok: true });
      expect(setOrgDiscoveryEnabled).toHaveBeenCalledWith(db, 'my-org', false);
      expect(saveDatabase).toHaveBeenCalled();
    });

    it('returns an error object when the service throws', () => {
      vi.mocked(setOrgDiscoveryEnabled).mockImplementationOnce(() => {
        throw new Error('not found');
      });
      const result = callHandler('github:set-org-enabled', 'my-org', true) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });
});
