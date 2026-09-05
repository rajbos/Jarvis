/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Repos plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the repos handlers against a real
 * in-memory DB seeded with github_orgs/github_repos rows, then invokes
 * captured handlers directly to verify:
 * - Search input validation and matching
 * - Org-scoped repo listing (including "no org" repos)
 * - Starred repo listing
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

import { registerHandlers } from '../../src/plugins/repos/handler';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Repos plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-repos-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    db.run(`INSERT INTO github_orgs (login, name, discovery_enabled) VALUES ('acme', 'Acme Inc', 1)`);
    db.run(`INSERT INTO github_orgs (login, name, discovery_enabled) VALUES ('disabled-org', 'Disabled Org', 0)`);

    db.run(
      `INSERT INTO github_repos (org_id, full_name, name, description, language, private, fork, archived, starred, last_pushed_at)
       VALUES (1, 'acme/widgets', 'widgets', 'Widget factory', 'TypeScript', 0, 0, 0, 0, '2026-01-01')`,
    );
    db.run(
      `INSERT INTO github_repos (org_id, full_name, name, description, language, private, fork, archived, starred, last_pushed_at)
       VALUES (2, 'disabled-org/hidden', 'hidden', 'Should not surface in search', 'Go', 0, 0, 0, 0, '2026-01-01')`,
    );
    db.run(
      `INSERT INTO github_repos (org_id, full_name, name, description, language, private, fork, archived, starred, last_pushed_at)
       VALUES (NULL, 'someone/starred-repo', 'starred-repo', 'A starred repo', 'JavaScript', 0, 0, 0, 1, '2026-02-01')`,
    );

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── github:search-repos ───────────────────────────────────────────────────

  describe('github:search-repos', () => {
    it('returns empty array for a non-string query', () => {
      const result = callHandler('github:search-repos', 42);
      expect(result).toEqual([]);
    });

    it('returns empty array for a too-short query', () => {
      const result = callHandler('github:search-repos', 'a');
      expect(result).toEqual([]);
    });

    it('finds repos matching name', () => {
      const result = callHandler('github:search-repos', 'widgets') as Array<{ full_name: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].full_name).toBe('acme/widgets');
    });

    it('excludes repos belonging to orgs with discovery disabled', () => {
      const result = callHandler('github:search-repos', 'hidden') as Array<{ full_name: string }>;
      expect(result).toEqual([]);
    });

    it('returns empty array when the query throws (invalid SQL surface)', () => {
      const badDb = { prepare: () => { throw new Error('boom'); } } as unknown as SqlJsDatabase;
      handlers.clear();
      registerHandlers(badDb, () => null);
      const result = callHandler('github:search-repos', 'widgets');
      expect(result).toEqual([]);
    });
  });

  // ── github:list-repos-for-org ─────────────────────────────────────────────

  describe('github:list-repos-for-org', () => {
    it('returns an error for an invalid orgLogin type', () => {
      const result = callHandler('github:list-repos-for-org', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });

    it('returns an error for an empty orgLogin', () => {
      const result = callHandler('github:list-repos-for-org', '');
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });

    it('lists repos for a given org', () => {
      const result = callHandler('github:list-repos-for-org', 'acme') as Array<{ full_name: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].full_name).toBe('acme/widgets');
    });

    it('lists repos with no org when orgLogin is null', () => {
      const result = callHandler('github:list-repos-for-org', null) as Array<{ full_name: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].full_name).toBe('someone/starred-repo');
    });

    it('returns empty array when the query throws', () => {
      const badDb = { prepare: () => { throw new Error('boom'); } } as unknown as SqlJsDatabase;
      handlers.clear();
      registerHandlers(badDb, () => null);
      const result = callHandler('github:list-repos-for-org', 'acme');
      expect(result).toEqual([]);
    });
  });

  // ── github:list-starred ───────────────────────────────────────────────────

  describe('github:list-starred', () => {
    it('returns only starred repos', () => {
      const result = callHandler('github:list-starred') as Array<{ full_name: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].full_name).toBe('someone/starred-repo');
    });

    it('returns empty array when the query throws', () => {
      const badDb = { prepare: () => { throw new Error('boom'); } } as unknown as SqlJsDatabase;
      handlers.clear();
      registerHandlers(badDb, () => null);
      const result = callHandler('github:list-starred');
      expect(result).toEqual([]);
    });
  });
});
