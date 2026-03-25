/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * IPC handler input validation tests.
 *
 * Verifies that IPC handlers reject invalid input with appropriate error
 * responses rather than passing unchecked data to internal functions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

// ── Track registered handlers so we can invoke them directly ──────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/ollama', () => ({
  checkOllama: vi.fn(() => ({ available: false, models: [] })),
  streamChat: vi.fn(),
  chatWithTools: vi.fn(),
  ToolsNotSupportedError: class extends Error {},
}));

vi.mock('../../src/agent/config', () => ({
  loadConfig: vi.fn(() => ({ preferences: {}, github: { oauthClientId: '', scopes: '' } })),
  saveConfig: vi.fn(),
}));

import { registerIpcHandlers } from '../../src/main/ipc-handlers';
import { shell } from 'electron';

// Helper to call a handler with a fake IPC event
function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = {
    sender: { id: 1, send: vi.fn(), isDestroyed: () => false },
  };
  return handler(fakeEvent, ...args);
}

describe('IPC handler input validation', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-validation';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerIpcHandlers(db, () => null);
  });

  // ── local-repos handlers ──────────────────────────────────────────────────

  describe('local:open-folder', () => {
    it('does nothing when folderPath is not a string', () => {
      callHandler('local:open-folder', 123);
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it('does nothing when folderPath is empty', () => {
      callHandler('local:open-folder', '');
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it('calls shell.openPath for a valid path', () => {
      callHandler('local:open-folder', '/home/user/projects');
      expect(shell.openPath).toHaveBeenCalledWith('/home/user/projects');
    });
  });

  describe('local:remove-folder', () => {
    it('returns error for non-string folderPath', () => {
      const result = callHandler('local:remove-folder', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid folderPath' });
    });

    it('returns error for empty folderPath', () => {
      const result = callHandler('local:remove-folder', '');
      expect(result).toEqual({ ok: false, error: 'Invalid folderPath' });
    });
  });

  describe('local:list-repos-for-folder', () => {
    it('returns empty array for non-string folderPath', () => {
      const result = callHandler('local:list-repos-for-folder', 42);
      expect(result).toEqual([]);
    });

    it('returns empty array for empty folderPath', () => {
      const result = callHandler('local:list-repos-for-folder', '');
      expect(result).toEqual([]);
    });
  });

  describe('local:link-repo', () => {
    it('returns error for non-number localRepoId', () => {
      const result = callHandler('local:link-repo', 'abc', null);
      expect(result).toEqual({ ok: false, error: 'Invalid localRepoId' });
    });

    it('returns error for invalid githubRepoId', () => {
      const result = callHandler('local:link-repo', 1, 'abc');
      expect(result).toEqual({ ok: false, error: 'Invalid githubRepoId' });
    });
  });

  // ── orgs handler ──────────────────────────────────────────────────────────

  describe('github:set-org-enabled', () => {
    it('returns error for non-string orgLogin', () => {
      const result = callHandler('github:set-org-enabled', 42, true);
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });

    it('returns error for empty orgLogin', () => {
      const result = callHandler('github:set-org-enabled', '', true);
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });

    it('returns error for non-boolean enabled', () => {
      const result = callHandler('github:set-org-enabled', 'myorg', 'yes');
      expect(result).toEqual({ ok: false, error: 'Invalid enabled value' });
    });
  });

  // ── ollama handler ────────────────────────────────────────────────────────

  describe('ollama:set-selected-model', () => {
    it('returns error for non-string modelName', () => {
      const result = callHandler('ollama:set-selected-model', 123);
      expect(result).toEqual({ ok: false, error: 'Invalid model name' });
    });

    it('returns error for empty modelName', () => {
      const result = callHandler('ollama:set-selected-model', '');
      expect(result).toEqual({ ok: false, error: 'Invalid model name' });
    });
  });

  // ── chat handler ──────────────────────────────────────────────────────────

  describe('chat:send', () => {
    it('returns error when messages is not an array', () => {
      const result = callHandler('chat:send', 'hello');
      expect(result).toEqual({ ok: false, error: 'Invalid messages' });
    });

    it('returns error when messages is empty', () => {
      const result = callHandler('chat:send', []);
      expect(result).toEqual({ ok: false, error: 'Invalid messages' });
    });

    it('returns error when a message entry is not an object', () => {
      const result = callHandler('chat:send', ['not an object']);
      expect(result).toEqual({ ok: false, error: 'Invalid message entry' });
    });

    it('returns error when message fields are not strings', () => {
      const result = callHandler('chat:send', [{ role: 123, content: 'hi' }]);
      expect(result).toEqual({ ok: false, error: 'Invalid message fields' });
    });
  });

  // ── config handler ────────────────────────────────────────────────────────

  describe('app:set-preferences', () => {
    it('returns error when prefs is not an object', () => {
      const result = callHandler('app:set-preferences', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid preferences' });
    });

    it('returns error when prefs is null', () => {
      const result = callHandler('app:set-preferences', null);
      expect(result).toEqual({ ok: false, error: 'Invalid preferences' });
    });

    it('returns error when prefs is an array', () => {
      const result = callHandler('app:set-preferences', [1, 2]);
      expect(result).toEqual({ ok: false, error: 'Invalid preferences' });
    });
  });
});
