/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * IPC handler input validation tests.
 *
 * Verifies that IPC handlers reject invalid input with appropriate error
 * responses rather than passing unchecked data to internal functions.
 *
 * ── Two established patterns for testing handlers ────────────────────────────
 *
 * 1. **Validation pattern** (this file):
 *    Capture handlers via the `handlers.set` mock, then call `callHandler()`
 *    with invalid inputs and assert on the guard-return value.  Useful when
 *    you only need to verify that a guard condition fires — the handler can be
 *    invoked synchronously and no DB state inspection is required.
 *    Example: `callHandler('agents:update', 'bad', 'prompt')` → `{ ok: false, error: 'Invalid agentId' }`
 *
 * 2. **Full-handler pattern** (groups.test.ts, agents-handler.test.ts, …):
 *    Import the specific plugin's `registerHandlers(db, getWindow)`, build an
 *    in-memory DB with `getSchema()`, call `registerHandlers`, then invoke
 *    captured handlers with both valid and invalid data.  Inspect DB state
 *    afterwards.  Suitable when you want to verify that the handler actually
 *    writes / reads from the DB, or when you need fine-grained control over
 *    which service mocks are active.
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

  // ── repos handlers ────────────────────────────────────────────────────────

  describe('github:list-repos-for-org', () => {
    it('accepts null orgLogin (personal repos)', async () => {
      const result = await callHandler('github:list-repos-for-org', null);
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns error for non-string, non-null orgLogin', async () => {
      const result = await callHandler('github:list-repos-for-org', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });

    it('returns error for empty string orgLogin', async () => {
      const result = await callHandler('github:list-repos-for-org', '');
      expect(result).toEqual({ ok: false, error: 'Invalid orgLogin' });
    });
  });

  // ── secrets handlers ──────────────────────────────────────────────────────

  describe('secrets:list-for-repo', () => {
    it('returns error for non-string repoFullName', () => {
      const result = callHandler('secrets:list-for-repo', 123);
      expect(result).toEqual({ ok: false, error: 'Invalid repoFullName' });
    });

    it('returns error for empty repoFullName', () => {
      const result = callHandler('secrets:list-for-repo', '');
      expect(result).toEqual({ ok: false, error: 'Invalid repoFullName' });
    });
  });

  describe('secrets:add-favorite', () => {
    it('returns error for invalid targetType', () => {
      const result = callHandler('secrets:add-favorite', 'user', 'my-org');
      expect(result).toEqual({ ok: false, error: 'Invalid targetType' });
    });

    it('returns error for empty targetName', () => {
      const result = callHandler('secrets:add-favorite', 'org', '');
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
    });

    it('returns error for non-string targetName', () => {
      const result = callHandler('secrets:add-favorite', 'repo', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
    });
  });

  describe('secrets:remove-favorite', () => {
    it('returns error for non-string targetName', () => {
      const result = callHandler('secrets:remove-favorite', 99);
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
    });

    it('returns error for empty targetName', () => {
      const result = callHandler('secrets:remove-favorite', '');
      expect(result).toEqual({ ok: false, error: 'Invalid targetName' });
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

  // ── agents handlers ───────────────────────────────────────────────────────

  describe('agents:update', () => {
    it('returns error for non-number agentId', () => {
      const result = callHandler('agents:update', 'abc', 'valid prompt');
      expect(result).toEqual({ ok: false, error: 'Invalid agentId' });
    });

    it('returns error for empty systemPrompt', () => {
      const result = callHandler('agents:update', 1, '');
      expect(result).toEqual({ ok: false, error: 'Invalid systemPrompt' });
    });

    it('returns error for whitespace-only systemPrompt', () => {
      const result = callHandler('agents:update', 1, '   ');
      expect(result).toEqual({ ok: false, error: 'Invalid systemPrompt' });
    });

    it('returns error for non-string systemPrompt', () => {
      const result = callHandler('agents:update', 1, null);
      expect(result).toEqual({ ok: false, error: 'Invalid systemPrompt' });
    });
  });

  describe('agents:run', () => {
    it('returns error for non-number agentId', async () => {
      const result = await callHandler('agents:run', 'bad', 'repo', 'owner/repo');
      expect(result).toEqual({ error: 'Invalid agentId' });
    });

    it('returns error for invalid scopeType', async () => {
      const result = await callHandler('agents:run', 1, 'invalid', 'owner/repo');
      expect(result).toEqual({ error: 'Invalid scopeType' });
    });

    it('returns error for empty scopeValue', async () => {
      const result = await callHandler('agents:run', 1, 'repo', '');
      expect(result).toEqual({ error: 'Invalid scopeValue' });
    });

    it('returns error for non-string workflowFilter', async () => {
      const result = await callHandler('agents:run', 1, 'repo', 'owner/repo', 42);
      expect(result).toEqual({ error: 'Invalid workflowFilter' });
    });
  });

  describe('agents:approve-finding', () => {
    it('returns { ok: false } for non-number findingId', () => {
      const result = callHandler('agents:approve-finding', 'bad');
      expect(result).toEqual({ ok: false });
    });

    it('returns { ok: false } for null findingId', () => {
      const result = callHandler('agents:approve-finding', null);
      expect(result).toEqual({ ok: false });
    });
  });

  describe('agents:reject-finding', () => {
    it('returns { ok: false } for non-number findingId', () => {
      const result = callHandler('agents:reject-finding', 'bad');
      expect(result).toEqual({ ok: false });
    });

    it('returns { ok: false } for undefined findingId', () => {
      const result = callHandler('agents:reject-finding', undefined);
      expect(result).toEqual({ ok: false });
    });
  });

  describe('agents:get-session', () => {
    it('returns null for non-number sessionId', () => {
      const result = callHandler('agents:get-session', 'bad');
      expect(result).toBeNull();
    });

    it('returns null for unknown session ID on a fresh DB', () => {
      const result = callHandler('agents:get-session', 9999);
      expect(result).toBeNull();
    });
  });

  describe('agents:execute-finding', () => {
    it('returns error for non-number findingId', async () => {
      const result = await callHandler('agents:execute-finding', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid findingId' });
    });
  });

  // ── github-auth handlers ──────────────────────────────────────────────────

  describe('github:save-pat', () => {
    it('returns error when not authenticated with GitHub', async () => {
      const result = (await callHandler('github:save-pat', 'ghp_token')) as Record<string, unknown>;
      expect(result.error).toBe('Not authenticated');
    });
  });

  describe('github:oauth-status', () => {
    it('returns { authenticated: false } on a fresh DB', async () => {
      const result = await callHandler('github:oauth-status');
      expect(result).toEqual({ authenticated: false });
    });
  });

  describe('github:delete-pat', () => {
    it('returns { ok: false } when not authenticated', () => {
      const result = callHandler('github:delete-pat') as Record<string, unknown>;
      expect(result.ok).toBe(false);
    });
  });

  describe('github:start-oauth', () => {
    it('returns an error when oauthClientId is not configured', async () => {
      const result = (await callHandler('github:start-oauth')) as Record<string, unknown>;
      expect(typeof result.error).toBe('string');
      expect((result.error as string).length).toBeGreaterThan(0);
    });
  });
});
