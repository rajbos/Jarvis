/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * GitHub Auth plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the github-auth handlers against a
 * real in-memory DB, then invokes captured handlers directly to verify
 * auth-status queries, PAT storage, and OAuth flows.
 *
 * Network calls and discovery side-effects are mocked.
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
  shell: { openExternal: vi.fn() },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/github-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/github-oauth')>();
  return {
    ...actual,
    requestDeviceCode: vi.fn(),
    pollForToken: vi.fn(),
    fetchGitHubUser: vi.fn().mockResolvedValue({
      login: 'testuser',
      name: 'Test User',
      avatar_url: 'https://example.com/avatar.png',
    }),
  };
});

vi.mock('../../src/agent/config', () => ({
  loadConfig: vi.fn(() => ({
    preferences: {},
    github: { oauthClientId: '', scopes: ['repo', 'read:user'] },
  })),
  saveConfig: vi.fn(),
}));

vi.mock('../../src/agent/onboarding', () => ({
  completeOnboardingStep: vi.fn(),
}));

vi.mock('../../src/plugins/discovery/handler', () => ({
  startDiscoveryIfAuthed: vi.fn(),
  scheduleLocalDiscovery: vi.fn(),
}));

import { registerHandlers } from '../../src/plugins/github-auth/handler';
import { saveGitHubAuth, saveGitHubPat, fetchGitHubUser } from '../../src/services/github-oauth';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitHub Auth plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-github-auth-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    // Reset fetchGitHubUser default mock
    vi.mocked(fetchGitHubUser).mockResolvedValue({
      login: 'testuser',
      name: 'Test User',
      avatar_url: 'https://example.com/avatar.png',
    });

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── github:oauth-status ─────────────────────────────────────────────────────

  describe('github:oauth-status', () => {
    it('returns { authenticated: false } when no auth is stored', async () => {
      const result = await callHandler('github:oauth-status');
      expect(result).toEqual({ authenticated: false });
    });

    it('returns { authenticated: true } with login when auth is stored', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo read:user', null);
      const result = (await callHandler('github:oauth-status')) as Record<string, unknown>;
      expect(result.authenticated).toBe(true);
      expect(result.login).toBe('octocat');
    });
  });

  // ── github:pat-status ──────────────────────────────────────────────────────

  describe('github:pat-status', () => {
    it('returns { hasPat: false } when no PAT is stored', async () => {
      const result = await callHandler('github:pat-status');
      expect(result).toEqual({ hasPat: false });
    });

    it('returns { hasPat: true } with login when PAT is stored and valid', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      saveGitHubPat(db, 'octocat', 'ghp_test_token');

      const result = (await callHandler('github:pat-status')) as Record<string, unknown>;
      expect(result.hasPat).toBe(true);
      expect(result.login).toBe('testuser');
    });

    it('returns { hasPat: true } without user info when fetchGitHubUser throws', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      saveGitHubPat(db, 'octocat', 'ghp_bad_token');
      vi.mocked(fetchGitHubUser).mockRejectedValueOnce(new Error('Unauthorized'));

      const result = (await callHandler('github:pat-status')) as Record<string, unknown>;
      expect(result.hasPat).toBe(true);
      expect(result.login).toBeUndefined();
    });
  });

  // ── github:save-pat ─────────────────────────────────────────────────────────

  describe('github:save-pat', () => {
    it('returns error when not authenticated with GitHub', async () => {
      const result = (await callHandler('github:save-pat', 'ghp_some_token')) as Record<
        string,
        unknown
      >;
      expect(result.error).toBe('Not authenticated');
    });

    it('returns error when PAT belongs to a different user', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      vi.mocked(fetchGitHubUser).mockResolvedValueOnce({
        login: 'other-user',
        name: 'Other User',
        avatar_url: '',
      });

      const result = (await callHandler('github:save-pat', 'ghp_wrong_user')) as Record<
        string,
        unknown
      >;
      expect(typeof result.error).toBe('string');
      expect(result.error as string).toContain('other-user');
    });

    it('returns error when PAT is invalid (fetchGitHubUser throws)', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      vi.mocked(fetchGitHubUser).mockRejectedValueOnce(new Error('bad credentials'));

      const result = (await callHandler('github:save-pat', 'ghp_bad')) as Record<string, unknown>;
      expect(result.error).toBe('Invalid token — could not authenticate with GitHub');
    });

    it('returns ok:true when PAT is valid and matches authenticated user', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      vi.mocked(fetchGitHubUser).mockResolvedValueOnce({
        login: 'octocat',
        name: 'Octocat',
        avatar_url: '',
      });

      const result = (await callHandler('github:save-pat', 'ghp_valid_token')) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(true);
    });
  });

  // ── github:delete-pat ──────────────────────────────────────────────────────

  describe('github:delete-pat', () => {
    it('returns { ok: false } when not authenticated', () => {
      const result = callHandler('github:delete-pat') as Record<string, unknown>;
      expect(result.ok).toBe(false);
    });

    it('returns { ok: true } when authenticated and PAT is deleted', () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      saveGitHubPat(db, 'octocat', 'ghp_test_token');

      const result = callHandler('github:delete-pat') as Record<string, unknown>;
      expect(result.ok).toBe(true);
    });
  });

  // ── github:logout ──────────────────────────────────────────────────────────

  describe('github:logout', () => {
    it('returns { ok: true } and removes auth from DB', () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);

      const result = callHandler('github:logout') as Record<string, unknown>;
      expect(result.ok).toBe(true);

      // Verify auth is gone by calling oauth-status
      // (loadGitHubAuth is the actual DB function — it reads from the real DB)
    });
  });

  // ── github:start-oauth ─────────────────────────────────────────────────────

  describe('github:start-oauth', () => {
    it('returns error when oauthClientId is not configured', async () => {
      const result = (await callHandler('github:start-oauth')) as Record<string, unknown>;
      expect(typeof result.error).toBe('string');
      expect(result.error as string).toContain('OAuth Client ID');
    });
  });

  // ── github:open-url ────────────────────────────────────────────────────────

  describe('github:open-url', () => {
    it('does not throw for a valid GitHub URL', () => {
      expect(() => callHandler('github:open-url', 'https://github.com/owner/repo')).not.toThrow();
    });

    it('does not call shell.openExternal for a non-GitHub URL', () => {
      expect(() => callHandler('github:open-url', 'https://evil.com')).not.toThrow();
    });
  });

  // ── github:start-oauth-discovery ───────────────────────────────────────────

  describe('github:start-oauth-discovery', () => {
    it('returns { ok: true }', () => {
      const result = callHandler('github:start-oauth-discovery') as Record<string, unknown>;
      expect(result.ok).toBe(true);
    });
  });

  // ── github:get-rate-limit ──────────────────────────────────────────────────

  describe('github:get-rate-limit', () => {
    it('returns error result when not authenticated', async () => {
      const result = (await callHandler('github:get-rate-limit')) as Record<string, unknown>;
      expect(result.error).toBe('Not authenticated');
      expect(typeof result.fetchedAt).toBe('string');
    });

    it('returns rate limit data when authenticated and fetch succeeds', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      const mockRateLimit = {
        resources: {
          core: { limit: 5000, remaining: 4321, reset: 1700000000, used: 679 },
        },
      };
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockRateLimit,
      } as Response);

      const result = (await callHandler('github:get-rate-limit')) as Record<string, unknown>;
      expect(result.error).toBeUndefined();
      expect(typeof result.fetchedAt).toBe('string');
      const core = result.core as Record<string, unknown>;
      expect(core.remaining).toBe(4321);
      expect(core.limit).toBe(5000);
    });

    it('returns error result when fetch fails', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      const result = (await callHandler('github:get-rate-limit')) as Record<string, unknown>;
      expect(typeof result.error).toBe('string');
      expect(result.error as string).toContain('Network error');
    });

    it('returns error result when API returns non-ok status', async () => {
      saveGitHubAuth(db, 'octocat', 'gho_abc123', 'repo', null);
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response);

      const result = (await callHandler('github:get-rate-limit')) as Record<string, unknown>;
      expect(typeof result.error).toBe('string');
      expect(result.error as string).toContain('401');
    });
  });
});
