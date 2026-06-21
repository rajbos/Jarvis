/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Chat plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the chat handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify:
 * - Input validation for messages array
 * - Error when no Ollama model is selected
 * - Abort of in-flight streaming
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

// ── Track registered handlers ─────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

const mockSend = vi.fn();
const mockIsDestroyed = vi.fn(() => false);

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/ollama', () => ({
  streamChat: vi.fn().mockResolvedValue(undefined),
  chatWithTools: vi.fn().mockResolvedValue({ content: 'Hello!', tool_calls: [] }),
  ToolsNotSupportedError: class ToolsNotSupportedError extends Error {},
}));

vi.mock('../../src/plugins/chat/db-helpers', () => ({
  buildSystemContext: vi.fn(() => 'System context'),
  searchReposForChat: vi.fn(() => '[]'),
  searchSecretsForChat: vi.fn(() => '[]'),
  searchOneNoteForChat: vi.fn(() => '[]'),
  searchProjectBudgetForChat: vi.fn(() => '[]'),
}));

import { registerHandlers } from '../../src/plugins/chat/handler';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = {
    sender: {
      id: 1,
      send: mockSend,
      isDestroyed: mockIsDestroyed,
    },
  };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Chat plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-chat-handler';
    vi.clearAllMocks();
    handlers.clear();
    mockIsDestroyed.mockReturnValue(false);

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── chat:send — input validation ───────────────────────────────────────────

  describe('chat:send — input validation', () => {
    it('returns error for non-array messages', () => {
      const result = callHandler('chat:send', 'not an array');
      expect(result).toEqual({ ok: false, error: 'Invalid messages' });
    });

    it('returns error for empty messages array', () => {
      const result = callHandler('chat:send', []);
      expect(result).toEqual({ ok: false, error: 'Invalid messages' });
    });

    it('returns error for null message entry', () => {
      const result = callHandler('chat:send', [null]);
      expect(result).toEqual({ ok: false, error: 'Invalid message entry' });
    });

    it('returns error when message lacks role', () => {
      const result = callHandler('chat:send', [{ content: 'hello' }]);
      expect(result).toEqual({ ok: false, error: 'Invalid message fields' });
    });

    it('returns error when message lacks content', () => {
      const result = callHandler('chat:send', [{ role: 'user' }]);
      expect(result).toEqual({ ok: false, error: 'Invalid message fields' });
    });

    it('returns error when role is not a string', () => {
      const result = callHandler('chat:send', [{ role: 42, content: 'hello' }]);
      expect(result).toEqual({ ok: false, error: 'Invalid message fields' });
    });
  });

  // ── chat:send — model selection ────────────────────────────────────────────

  describe('chat:send — model selection', () => {
    it('sends chat:error event when no model is selected', () => {
      const validMessages = [{ role: 'user', content: 'Hello' }];
      callHandler('chat:send', validMessages);
      expect(mockSend).toHaveBeenCalledWith(
        'chat:error',
        expect.stringContaining('No Ollama model'),
      );
    });

    it('returns ok:false when no model is selected', () => {
      const result = callHandler('chat:send', [{ role: 'user', content: 'Hello' }]);
      expect(result).toEqual({ ok: false });
    });

    it('returns ok:true when a model is selected', () => {
      db.run(`INSERT OR REPLACE INTO config (key, value) VALUES ('selected_ollama_model', 'llama3')`);
      const result = callHandler('chat:send', [{ role: 'user', content: 'Hello' }]);
      expect(result).toEqual({ ok: true });
    });
  });

  // ── chat:abort ─────────────────────────────────────────────────────────────

  describe('chat:abort', () => {
    it('returns ok:true when no in-flight chat exists', () => {
      const result = callHandler('chat:abort');
      expect(result).toEqual({ ok: true });
    });

    it('returns ok:true after aborting an in-flight chat', () => {
      // Start a chat first (model required to start)
      db.run(`INSERT OR REPLACE INTO config (key, value) VALUES ('selected_ollama_model', 'llama3')`);
      callHandler('chat:send', [{ role: 'user', content: 'Hello' }]);

      // Abort it
      const result = callHandler('chat:abort');
      expect(result).toEqual({ ok: true });
    });
  });
});
