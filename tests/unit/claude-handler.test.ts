/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Claude plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the claude handlers against a real
 * in-memory DB, then invokes captured handlers directly. External OAuth /
 * rate-limit services are mocked so tests stay focused on handler dispatch
 * and the safeHandle failure-wrapping behavior.
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
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/claude', () => ({
  loadClaudeCodeCredentials: vi.fn(() => null),
  refreshClaudeToken: vi.fn(),
  checkClaudeRateLimit: vi.fn(),
  isTokenPotentiallyUsable: vi.fn(() => false),
  generatePkce: vi.fn(() => ({ verifier: 'v', challenge: 'c', state: 's' })),
  buildAuthorizeUrl: vi.fn(() => 'https://example.com/authorize'),
  parseAuthorizationCode: vi.fn(),
  exchangeCodeForToken: vi.fn(),
}));

import { registerHandlers } from '../../src/plugins/claude/handler';
import {
  loadClaudeCodeCredentials,
  checkClaudeRateLimit,
  isTokenPotentiallyUsable,
  parseAuthorizationCode,
  exchangeCodeForToken,
} from '../../src/services/claude';

const mockLoadClaudeCodeCredentials = vi.mocked(loadClaudeCodeCredentials);
const mockCheckClaudeRateLimit = vi.mocked(checkClaudeRateLimit);
const mockIsTokenPotentiallyUsable = vi.mocked(isTokenPotentiallyUsable);
const mockParseAuthorizationCode = vi.mocked(parseAuthorizationCode);
const mockExchangeCodeForToken = vi.mocked(exchangeCodeForToken);

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Claude plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-claude-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    mockLoadClaudeCodeCredentials.mockReturnValue(null);
    mockIsTokenPotentiallyUsable.mockReturnValue(false);

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── claude:disconnect ────────────────────────────────────────────────────

  describe('claude:disconnect', () => {
    it('returns ok:true', () => {
      const result = callHandler('claude:disconnect');
      expect(result).toEqual({ ok: true });
    });
  });

  // ── claude:status (kept try/catch — different failure shape) ────────────

  describe('claude:status', () => {
    it('reports not connected when no credentials are available', async () => {
      const result = await callHandler('claude:status') as Record<string, unknown>;
      expect(result.connected).toBe(false);
    });
  });

  // ── claude:complete-oauth — migrated to safeHandle, no prior try/catch ──
  // safeHandle now converts a thrown/rejected error into { ok: false, error }
  // instead of letting the IPC invoke call reject in the renderer.

  describe('claude:complete-oauth', () => {
    it('returns error when no sign-in is in progress', async () => {
      const result = await callHandler('claude:complete-oauth', 'some-code');
      expect(result).toEqual({ ok: false, error: 'No sign-in in progress — click "Sign in with Claude" first.' });
    });

    it('resolves { ok: false, error } via safeHandle when exchangeCodeForToken throws unexpectedly', async () => {
      // Put a sign-in in progress first.
      await callHandler('claude:begin-oauth');

      mockParseAuthorizationCode.mockReturnValue({ code: 'abc', state: 's' });
      mockExchangeCodeForToken.mockRejectedValue(new Error('network exploded'));

      const result = await callHandler('claude:complete-oauth', 'pasted-code');
      expect(result).toEqual({ ok: false, error: 'network exploded' });
    });
  });
});
