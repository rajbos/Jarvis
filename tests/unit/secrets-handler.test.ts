/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Secrets plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the secrets handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify input
 * guards, DB reads, and favorites CRUD.
 *
 * Network calls (scanUserRepoSecrets) are mocked to keep tests fast and offline.
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
  loadGitHubPat: vi.fn(() => null),
}));

vi.mock('../../src/services/github-secrets', () => ({
  scanUserRepoSecrets: vi.fn().mockResolvedValue({ scanned: 0, found: 0 }),
  listSecretsForRepo: vi.fn().mockReturnValue([]),
  searchSecrets: vi.fn().mockReturnValue([]),
  listSecretFavorites: vi.fn().mockReturnValue([]),
  addSecretFavorite: vi.fn(),
  removeSecretFavorite: vi.fn(),
}));

import { registerHandlers } from '../../src/plugins/secrets/handler';
import { loadGitHubAuth } from '../../src/services/github-oauth';
import {
  listSecretsForRepo,
  searchSecrets,
  listSecretFavorites,
  addSecretFavorite,
  removeSecretFavorite,
} from '../../src/services/github-secrets';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Secrets plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-secrets-handler';
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

  // ── secrets:scan ───────────────────────────────────────────────────────────

  describe('secrets:scan', () => {
    it('returns error when not authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue(null);
      const result = (await callHandler('secrets:scan')) as Record<string, unknown>;
      expect(result.error).toBe('Not authenticated with GitHub');
    });
  });

  // ── secrets:list-for-repo ──────────────────────────────────────────────────

  describe('secrets:list-for-repo', () => {
    it('returns error for empty repoFullName', () => {
      const result = callHandler('secrets:list-for-repo', '');
      expect(result).toEqual({ ok: false, error: 'Invalid repoFullName' });
    });

    it('returns error for non-string repoFullName', () => {
      const result = callHandler('secrets:list-for-repo', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid repoFullName' });
    });

    it('delegates to listSecretsForRepo for valid input', () => {
      vi.mocked(listSecretsForRepo).mockReturnValue([
        { secret_name: 'MY_TOKEN' } as Parameters<typeof listSecretsForRepo>[1] extends never ? never : ReturnType<typeof listSecretsForRepo>[0],
      ]);
      callHandler('secrets:list-for-repo', 'owner/repo');
      expect(listSecretsForRepo).toHaveBeenCalledWith(db, 'owner/repo');
    });

    it('returns empty array when service throws', () => {
      vi.mocked(listSecretsForRepo).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('secrets:list-for-repo', 'owner/repo');
      expect(result).toEqual([]);
    });
  });

  // ── secrets:list-all ──────────────────────────────────────────────────────

  describe('secrets:list-all', () => {
    it('delegates to searchSecrets with empty pattern', () => {
      callHandler('secrets:list-all');
      expect(searchSecrets).toHaveBeenCalledWith(db, '');
    });

    it('returns empty array when service throws', () => {
      vi.mocked(searchSecrets).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('secrets:list-all');
      expect(result).toEqual([]);
    });
  });

  // ── secrets:list-favorites ─────────────────────────────────────────────────

  describe('secrets:list-favorites', () => {
    it('delegates to listSecretFavorites', () => {
      callHandler('secrets:list-favorites');
      expect(listSecretFavorites).toHaveBeenCalledWith(db);
    });

    it('returns empty array when service throws', () => {
      vi.mocked(listSecretFavorites).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('secrets:list-favorites');
      expect(result).toEqual([]);
    });
  });

  // ── secrets:add-favorite ──────────────────────────────────────────────────

  describe('secrets:add-favorite', () => {
    it('returns error for invalid targetType', () => {
      const result = callHandler('secrets:add-favorite', 'team', 'my-org');
      expect(result).toEqual({ ok: false, error: 'Invalid targetType' });
    });

    it('returns error for empty targetName', () => {
      const result = callHandler('secrets:add-favorite', 'org', '');
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
    });

    it('returns error for non-string targetName', () => {
      const result = callHandler('secrets:add-favorite', 'repo', null);
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
    });

    it('calls addSecretFavorite for valid org target', () => {
      const result = callHandler('secrets:add-favorite', 'org', 'my-org');
      expect(result).toEqual({ ok: true });
      expect(addSecretFavorite).toHaveBeenCalledWith(db, 'org', 'my-org');
    });

    it('calls addSecretFavorite for valid repo target', () => {
      const result = callHandler('secrets:add-favorite', 'repo', 'owner/repo');
      expect(result).toEqual({ ok: true });
      expect(addSecretFavorite).toHaveBeenCalledWith(db, 'repo', 'owner/repo');
    });

    it('returns error when service throws', () => {
      vi.mocked(addSecretFavorite).mockImplementationOnce(() => {
        throw new Error('constraint violation');
      });
      const result = callHandler('secrets:add-favorite', 'org', 'my-org') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });

  // ── secrets:remove-favorite ───────────────────────────────────────────────

  describe('secrets:remove-favorite', () => {
    it('returns error for empty targetName', () => {
      const result = callHandler('secrets:remove-favorite', '');
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
    });

    it('returns error for non-string targetName', () => {
      const result = callHandler('secrets:remove-favorite', undefined);
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
    });

    it('calls removeSecretFavorite for valid targetName', () => {
      const result = callHandler('secrets:remove-favorite', 'my-org');
      expect(result).toEqual({ ok: true });
      expect(removeSecretFavorite).toHaveBeenCalledWith(db, 'my-org');
    });

    it('returns error when service throws', () => {
      vi.mocked(removeSecretFavorite).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('secrets:remove-favorite', 'my-org') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });
});
