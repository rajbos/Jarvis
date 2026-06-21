/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Browser-companion plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the browser-companion handlers against
 * a real in-memory DB, then invokes captured handlers directly to verify:
 * - Bridge status reporting
 * - Token get / regenerate
 * - Skill CRUD (create, update, delete, list)
 * - Run history listing
 * - browser:run-skill input validation and bridge-not-connected guard
 * - Direct browser command helpers
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

vi.mock('../../src/plugins/browser-companion/server', () => ({
  startBridgeServer: vi.fn(),
  getBridgeStatus: vi.fn().mockReturnValue({ running: true, port: 35789, connectedClients: 0 }),
  getBridgeToken: vi.fn().mockReturnValue('test-token-abc'),
  regenerateBridgeToken: vi.fn().mockReturnValue('new-token-xyz'),
  sendCommand: vi.fn().mockResolvedValue({ ok: true, data: null }),
}));

import { registerHandlers } from '../../src/plugins/browser-companion/handler';
import {
  startBridgeServer,
  getBridgeStatus,
  getBridgeToken,
  regenerateBridgeToken,
  sendCommand,
} from '../../src/plugins/browser-companion/server';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Browser-companion plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-browser-companion-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    vi.mocked(getBridgeStatus).mockReturnValue({ running: true, port: 35789, connectedClients: 0 });
    vi.mocked(getBridgeToken).mockReturnValue('test-token-abc');
    vi.mocked(regenerateBridgeToken).mockReturnValue('new-token-xyz');
    vi.mocked(sendCommand).mockResolvedValue({ ok: true, data: null });

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── startBridgeServer is called on registration ───────────────────────────

  it('starts the bridge server when handlers are registered', () => {
    expect(startBridgeServer).toHaveBeenCalled();
  });

  // ── browser:status ────────────────────────────────────────────────────────

  describe('browser:status', () => {
    it('returns the current bridge status', () => {
      const result = callHandler('browser:status') as Record<string, unknown>;
      expect(result.running).toBe(true);
      expect(result.port).toBe(35789);
      expect(result.connectedClients).toBe(0);
    });

    it('reflects a connected-client state', () => {
      vi.mocked(getBridgeStatus).mockReturnValueOnce({ running: true, port: 35789, connectedClients: 2 });
      const result = callHandler('browser:status') as Record<string, unknown>;
      expect(result.connectedClients).toBe(2);
    });
  });

  // ── browser:get-token ─────────────────────────────────────────────────────

  describe('browser:get-token', () => {
    it('returns the current bridge token', () => {
      const result = callHandler('browser:get-token') as Record<string, unknown>;
      expect(result).toEqual({ token: 'test-token-abc' });
    });
  });

  // ── browser:regenerate-token ──────────────────────────────────────────────

  describe('browser:regenerate-token', () => {
    it('returns the newly generated token', () => {
      const result = callHandler('browser:regenerate-token') as Record<string, unknown>;
      expect(result).toEqual({ token: 'new-token-xyz' });
    });

    it('calls regenerateBridgeToken to produce a new token', () => {
      callHandler('browser:regenerate-token');
      expect(regenerateBridgeToken).toHaveBeenCalled();
    });
  });

  // ── browser:list-skills ───────────────────────────────────────────────────

  describe('browser:list-skills', () => {
    it('returns empty array on a fresh DB', () => {
      const result = callHandler('browser:list-skills') as unknown[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('returns seeded skills', () => {
      db.run(
        `INSERT INTO browser_skills (name, description, start_url, instructions, extract_selector)
         VALUES ('My Skill', 'Desc', 'https://example.com', 'Do stuff', '.result')`,
      );
      const result = callHandler('browser:list-skills') as Record<string, unknown>[];
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('My Skill');
      expect(result[0].start_url).toBe('https://example.com');
    });
  });

  // ── browser:create-skill ──────────────────────────────────────────────────

  describe('browser:create-skill', () => {
    it('returns error for empty name', () => {
      const result = callHandler('browser:create-skill', '', 'desc', 'https://url.com', 'instructions', '');
      expect(result).toEqual({ ok: false, error: 'Invalid name' });
    });

    it('returns error for empty startUrl', () => {
      const result = callHandler('browser:create-skill', 'My Skill', 'desc', '', 'instructions', '');
      expect(result).toEqual({ ok: false, error: 'Invalid startUrl' });
    });

    it('returns error for empty instructions', () => {
      const result = callHandler('browser:create-skill', 'My Skill', 'desc', 'https://url.com', '', '');
      expect(result).toEqual({ ok: false, error: 'Invalid instructions' });
    });

    it('creates a skill and returns ok:true with id', () => {
      const result = callHandler(
        'browser:create-skill',
        'New Skill',
        'A description',
        'https://example.com',
        'Click the button',
        '.result',
      ) as Record<string, unknown>;

      expect(result.ok).toBe(true);
      expect(typeof result.id).toBe('number');

      const rows = db.exec('SELECT name, start_url FROM browser_skills WHERE id = ?', [result.id]);
      expect(rows[0].values[0][0]).toBe('New Skill');
      expect(rows[0].values[0][1]).toBe('https://example.com');
    });
  });

  // ── browser:update-skill ──────────────────────────────────────────────────

  describe('browser:update-skill', () => {
    it('returns error for non-number id', () => {
      const result = callHandler('browser:update-skill', 'bad', 'Name', 'desc', 'https://url.com', 'Do it', '');
      expect(result).toEqual({ ok: false, error: 'Invalid id' });
    });

    it('returns error for empty name', () => {
      const result = callHandler('browser:update-skill', 1, '', 'desc', 'https://url.com', 'Do it', '');
      expect(result).toEqual({ ok: false, error: 'Invalid name' });
    });

    it('updates an existing skill', () => {
      db.run(
        `INSERT INTO browser_skills (id, name, description, start_url, instructions, extract_selector)
         VALUES (1, 'Old Name', '', 'https://old.com', 'Old instructions', '')`,
      );

      const result = callHandler(
        'browser:update-skill',
        1,
        'New Name',
        'New desc',
        'https://new.com',
        'New instructions',
        '.new-selector',
      ) as Record<string, unknown>;

      expect(result).toEqual({ ok: true });

      const rows = db.exec('SELECT name, start_url FROM browser_skills WHERE id = 1');
      expect(rows[0].values[0][0]).toBe('New Name');
      expect(rows[0].values[0][1]).toBe('https://new.com');
    });
  });

  // ── browser:delete-skill ──────────────────────────────────────────────────

  describe('browser:delete-skill', () => {
    it('returns error for non-number id', () => {
      const result = callHandler('browser:delete-skill', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid id' });
    });

    it('deletes a skill by id', () => {
      db.run(
        `INSERT INTO browser_skills (id, name, start_url, instructions)
         VALUES (1, 'Skill', 'https://url.com', 'Click')`,
      );

      const result = callHandler('browser:delete-skill', 1);
      expect(result).toEqual({ ok: true });

      const rows = db.exec('SELECT COUNT(*) FROM browser_skills');
      expect(rows[0].values[0][0]).toBe(0);
    });
  });

  // ── browser:list-runs ─────────────────────────────────────────────────────

  describe('browser:list-runs', () => {
    it('returns empty array on a fresh DB', () => {
      const result = callHandler('browser:list-runs') as unknown[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('returns empty array for non-number skillId', () => {
      const result = callHandler('browser:list-runs', 'bad') as unknown[];
      expect(result).toEqual([]);
    });
  });

  // ── browser:run-skill ─────────────────────────────────────────────────────

  describe('browser:run-skill', () => {
    it('returns error for non-number skillId', async () => {
      const result = (await callHandler('browser:run-skill', 'bad')) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Invalid skillId' });
    });

    it('returns error for non-boolean testMode', async () => {
      const result = (await callHandler('browser:run-skill', 1, 'yes')) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Invalid testMode' });
    });

    it('returns error when skill is not found', async () => {
      const result = (await callHandler('browser:run-skill', 9999)) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Skill not found' });
    });

    it('returns error when no browser extension is connected', async () => {
      db.run(
        `INSERT INTO browser_skills (id, name, start_url, instructions)
         VALUES (1, 'Test Skill', 'https://example.com', 'Click button')`,
      );
      vi.mocked(getBridgeStatus).mockReturnValueOnce({ running: false, port: 35789, connectedClients: 0 });

      const result = (await callHandler('browser:run-skill', 1)) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('No browser extension');
    });

    it('runs skill in test mode and returns ok:true without creating a run record', async () => {
      db.run(
        `INSERT INTO browser_skills (id, name, start_url, instructions)
         VALUES (1, 'Test Skill', 'https://example.com', 'Click button')`,
      );
      vi.mocked(getBridgeStatus).mockReturnValue({ running: true, port: 35789, connectedClients: 1 });
      vi.mocked(sendCommand)
        .mockResolvedValueOnce({ ok: true, data: { url: 'https://example.com' } })  // navigate
        .mockResolvedValueOnce({ ok: true, data: 'done' });                          // evaluate

      const result = (await callHandler('browser:run-skill', 1, true)) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.testMode).toBe(true);
      // No run record should be created in test mode
      const runCount = db.exec('SELECT COUNT(*) FROM browser_skill_runs');
      expect(runCount[0].values[0][0]).toBe(0);
    });

    it('creates a run record when not in test mode', async () => {
      db.run(
        `INSERT INTO browser_skills (id, name, start_url, instructions)
         VALUES (1, 'Real Skill', 'https://example.com', 'Click button')`,
      );
      vi.mocked(getBridgeStatus).mockReturnValue({ running: true, port: 35789, connectedClients: 1 });
      vi.mocked(sendCommand)
        .mockResolvedValueOnce({ ok: true, data: {} })    // navigate
        .mockResolvedValueOnce({ ok: true, data: null }); // evaluate

      const result = (await callHandler('browser:run-skill', 1, false)) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      const runCount = db.exec("SELECT COUNT(*) FROM browser_skill_runs WHERE status = 'completed'");
      expect(runCount[0].values[0][0]).toBe(1);
    });
  });

  // ── browser:navigate ──────────────────────────────────────────────────────

  describe('browser:navigate', () => {
    it('returns error for empty url', async () => {
      const result = (await callHandler('browser:navigate', '')) as Record<string, unknown>;
      expect(result).toEqual({ ok: false, error: 'Invalid url' });
    });

    it('delegates to sendCommand for valid url', async () => {
      const result = (await callHandler('browser:navigate', 'https://example.com')) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(sendCommand).toHaveBeenCalledWith({
        type: 'navigate',
        payload: { url: 'https://example.com' },
      });
    });
  });
});
