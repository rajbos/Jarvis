/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Discovery plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the discovery handlers against a real
 * in-memory DB, then invokes captured handlers directly (plus the exported
 * `startDiscoveryIfAuthed` helper) to verify:
 * - Discovery status reporting (idle vs. in-progress)
 * - PAT-only discovery start + "no PAT configured" guard
 * - startDiscoveryIfAuthed branch coverage (no auth, already running, stale
 *   refresh, fresh data with missing starred repos, forced full discovery)
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
  return {
    ...actual,
    saveDatabase: vi.fn(),
    getConfigValue: vi.fn().mockReturnValue(null),
    setConfigValue: vi.fn(),
  };
});

vi.mock('../../src/services/github-oauth', () => ({
  loadGitHubAuth: vi.fn().mockReturnValue(null),
  loadGitHubPat: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/services/github-discovery', () => ({
  runDiscovery: vi.fn().mockResolvedValue({}),
  runLightweightRefresh: vi.fn().mockResolvedValue(undefined),
  runPatDiscovery: vi.fn().mockResolvedValue(undefined),
  fetchStarredRepos: vi.fn().mockResolvedValue(undefined),
  getLastOrgIndexedAt: vi.fn().mockReturnValue(null),
  listOrgs: vi.fn().mockReturnValue({ orgs: [], directRepoCount: 0, starredRepoCount: 0 }),
}));

import { registerHandlers, startDiscoveryIfAuthed } from '../../src/plugins/discovery/handler';
import {
  runDiscovery,
  runLightweightRefresh,
  runPatDiscovery,
  fetchStarredRepos,
  getLastOrgIndexedAt,
  listOrgs,
} from '../../src/services/github-discovery';
import { loadGitHubAuth, loadGitHubPat } from '../../src/services/github-oauth';
import { setActiveDiscovery, setLastDiscoveryProgress } from '../../src/plugins/discovery/state';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

function fakeWindow() {
  return { webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Discovery plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-discovery-handler';
    vi.clearAllMocks();
    handlers.clear();
    setActiveDiscovery(null);
    setLastDiscoveryProgress(null);

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── github:discovery-status ───────────────────────────────────────────────

  describe('github:discovery-status', () => {
    it('falls back to listOrgs when no progress has been recorded yet', () => {
      vi.mocked(listOrgs).mockReturnValueOnce({ orgs: [], directRepoCount: 0, starredRepoCount: 0 });
      const result = callHandler('github:discovery-status') as Record<string, unknown>;
      expect(result).toEqual({ running: false, progress: null, rateLimit: null });
    });

    it('reports a done progress when repos already exist and no live progress is tracked', () => {
      vi.mocked(listOrgs).mockReturnValueOnce({
        orgs: [{ login: 'acme', name: 'Acme', repoCount: 3 } as never],
        directRepoCount: 1,
        starredRepoCount: 0,
      });
      const result = callHandler('github:discovery-status') as Record<string, unknown>;
      expect(result).toEqual({
        running: false,
        progress: { phase: 'done', orgsFound: 1, reposFound: 4 },
        rateLimit: null,
      });
    });

    it('reports recorded progress when a discovery run is in flight', () => {
      setLastDiscoveryProgress({ phase: 'repos', orgsFound: 2, reposFound: 5 });
      const result = callHandler('github:discovery-status') as Record<string, unknown>;
      expect(result).toEqual({
        running: false,
        progress: { phase: 'repos', orgsFound: 2, reposFound: 5 },
        rateLimit: null,
      });
    });
  });

  // ── github:start-discovery ────────────────────────────────────────────────

  describe('github:start-discovery', () => {
    it('returns started:true even when no auth is configured', () => {
      const result = callHandler('github:start-discovery');
      expect(result).toEqual({ started: true });
    });
  });

  // ── github:start-pat-discovery ────────────────────────────────────────────

  describe('github:start-pat-discovery', () => {
    it('returns an error when no PAT is configured', () => {
      vi.mocked(loadGitHubPat).mockReturnValueOnce(null);
      const result = callHandler('github:start-pat-discovery');
      expect(result).toEqual({ error: 'No PAT configured' });
    });

    it('starts PAT discovery when a PAT is configured', () => {
      vi.mocked(loadGitHubPat).mockReturnValue('fake-pat');
      vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'octocat', accessToken: 'x', scopes: '', avatarUrl: null });
      const result = callHandler('github:start-pat-discovery');
      expect(result).toEqual({ started: true });
      expect(runPatDiscovery).toHaveBeenCalledWith(db, 'fake-pat', undefined, undefined, expect.any(Function), 'octocat');
    });
  });

  // ── startDiscoveryIfAuthed ─────────────────────────────────────────────────

  describe('startDiscoveryIfAuthed', () => {
    it('does nothing when there is no auth', () => {
      vi.mocked(loadGitHubAuth).mockReturnValueOnce(null);
      startDiscoveryIfAuthed(db, () => fakeWindow());
      expect(runDiscovery).not.toHaveBeenCalled();
      expect(runLightweightRefresh).not.toHaveBeenCalled();
    });

    it('skips when a discovery is already active and not aborted', () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'octocat', accessToken: 'x', scopes: '', avatarUrl: null });
      setActiveDiscovery({ callsSinceLastPause: 0, aborted: false, lastRateLimit: null });
      startDiscoveryIfAuthed(db, () => fakeWindow());
      expect(runDiscovery).not.toHaveBeenCalled();
    });

    it('runs a lightweight refresh when existing org data is stale', () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'octocat', accessToken: 'x', scopes: '', avatarUrl: null });
      vi.mocked(listOrgs).mockReturnValue({
        orgs: [{ login: 'acme', name: 'Acme', repoCount: 3 } as never],
        directRepoCount: 0,
        starredRepoCount: 1,
      });
      vi.mocked(getLastOrgIndexedAt).mockReturnValue('2000-01-01 00:00:00');

      startDiscoveryIfAuthed(db, () => fakeWindow());

      expect(runLightweightRefresh).toHaveBeenCalled();
      expect(runDiscovery).not.toHaveBeenCalled();
    });

    it('fetches starred repos when data is fresh but none are indexed yet', () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'octocat', accessToken: 'x', scopes: '', avatarUrl: null });
      vi.mocked(listOrgs).mockReturnValue({
        orgs: [{ login: 'acme', name: 'Acme', repoCount: 3 } as never],
        directRepoCount: 0,
        starredRepoCount: 0,
      });
      vi.mocked(getLastOrgIndexedAt).mockReturnValue(new Date().toISOString().replace('T', ' ').slice(0, 19));

      startDiscoveryIfAuthed(db, () => fakeWindow());

      expect(fetchStarredRepos).toHaveBeenCalled();
      expect(runLightweightRefresh).not.toHaveBeenCalled();
      expect(runDiscovery).not.toHaveBeenCalled();
    });

    it('runs full discovery when forced with no existing orgs', () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'octocat', accessToken: 'x', scopes: '', avatarUrl: null });
      vi.mocked(listOrgs).mockReturnValue({ orgs: [], directRepoCount: 0, starredRepoCount: 0 });

      startDiscoveryIfAuthed(db, () => fakeWindow(), true);

      expect(runDiscovery).toHaveBeenCalled();
    });
  });
});
