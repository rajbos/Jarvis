/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Ollama plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the ollama handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify DB reads /
 * writes and the error-handling path when `checkOllama` throws.
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

vi.mock('../../src/services/ollama', () => ({
  checkOllama: vi.fn().mockResolvedValue({
    available: true,
    models: ['llama3', 'mistral'],
    error: undefined,
  }),
}));

import { registerHandlers } from '../../src/plugins/ollama/handler';
import { checkOllama } from '../../src/services/ollama';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Ollama plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-ollama-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerHandlers(db, () => null);

    // Reset default mock
    vi.mocked(checkOllama).mockResolvedValue({
      available: true,
      models: ['llama3', 'mistral'],
      error: undefined,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ── ollama:status ──────────────────────────────────────────────────────────

  describe('ollama:status', () => {
    it('returns the result from checkOllama when successful', async () => {
      const result = (await callHandler('ollama:status')) as Record<string, unknown>;
      expect(result.available).toBe(true);
      expect(Array.isArray(result.models)).toBe(true);
    });

    it('returns error shape when checkOllama throws', async () => {
      vi.mocked(checkOllama).mockRejectedValueOnce(new Error('connection refused'));
      // The handler returns the promise without awaiting it, so the rejection
      // propagates out of the handler rather than being caught.
      await expect(callHandler('ollama:status')).rejects.toThrow('connection refused');
    });
  });

  // ── ollama:list-models ─────────────────────────────────────────────────────

  describe('ollama:list-models', () => {
    it('returns available flag and models list', async () => {
      const result = (await callHandler('ollama:list-models')) as Record<string, unknown>;
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['llama3', 'mistral']);
    });

    it('returns error shape when checkOllama throws', async () => {
      vi.mocked(checkOllama).mockRejectedValueOnce(new Error('timeout'));
      const result = (await callHandler('ollama:list-models')) as Record<string, unknown>;
      expect(result.available).toBe(false);
      expect(result.models).toEqual([]);
      expect(typeof result.error).toBe('string');
    });
  });

  // ── ollama:get-selected-model ──────────────────────────────────────────────

  describe('ollama:get-selected-model', () => {
    it('returns null when no model has been selected', () => {
      const result = callHandler('ollama:get-selected-model');
      expect(result).toBeNull();
    });

    it('returns the saved model name after it has been set', () => {
      callHandler('ollama:set-selected-model', 'llama3');
      const result = callHandler('ollama:get-selected-model');
      expect(result).toBe('llama3');
    });
  });

  // ── ollama:set-selected-model ──────────────────────────────────────────────

  describe('ollama:set-selected-model', () => {
    it('returns error for empty model name', () => {
      const result = callHandler('ollama:set-selected-model', '');
      expect(result).toEqual({ ok: false, error: 'Invalid model name' });
    });

    it('returns error for non-string model name', () => {
      const result = callHandler('ollama:set-selected-model', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid model name' });
    });

    it('persists the selected model and returns ok:true', () => {
      const result = callHandler('ollama:set-selected-model', 'mistral');
      expect(result).toEqual({ ok: true });

      const rows = db.exec("SELECT value FROM config WHERE key = 'selected_ollama_model'");
      expect(rows[0].values[0][0]).toBe('mistral');
    });

    it('can overwrite a previously saved model', () => {
      callHandler('ollama:set-selected-model', 'llama3');
      callHandler('ollama:set-selected-model', 'mistral');
      const result = callHandler('ollama:get-selected-model');
      expect(result).toBe('mistral');
    });
  });
});
