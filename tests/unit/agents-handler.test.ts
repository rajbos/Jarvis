/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Agents plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the agents handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify dispatch
 * logic, input validation, and DB state.
 *
 * External services (github-workflows, ./runner's network calls) are mocked
 * so tests stay focused on handler logic.
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
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
  },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/github-workflows', () => ({
  fetchAndStoreWorkflowData: vi.fn().mockResolvedValue({ runsStored: 0 }),
  getWorkflowSummaryForRepo: vi.fn(() => ({ total_runs: 0, recent_runs: [], jobs_by_run: {} })),
  createGitHubIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/github-oauth', () => ({
  loadGitHubAuth: vi.fn(() => null),
}));

vi.mock('../../src/plugins/agents/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/plugins/agents/runner')>();
  return {
    ...actual,
    runAgentSession: vi.fn().mockResolvedValue(undefined),
  };
});

import { registerHandlers } from '../../src/plugins/agents/handler';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Agents plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-agents-handler';
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── agents:list ─────────────────────────────────────────────────────────────

  describe('agents:list', () => {
    it('returns an empty array on a fresh DB', () => {
      const result = callHandler('agents:list');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('returns seeded agent definitions', () => {
      db.run(
        `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
         VALUES ('Test Agent', 'Desc', 'You are a test.', '[]')`,
      );
      const result = callHandler('agents:list') as unknown[];
      expect(result).toHaveLength(1);
      expect((result[0] as Record<string, unknown>).name).toBe('Test Agent');
    });
  });

  // ── agents:update ───────────────────────────────────────────────────────────

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

    it('updates system_prompt for a valid agent', () => {
      db.run(
        `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
         VALUES ('My Agent', 'Desc', 'Old prompt', '[]')`,
      );
      const idResult = db.exec('SELECT last_insert_rowid() AS id');
      const agentId = idResult[0].values[0][0] as number;

      const result = callHandler('agents:update', agentId, 'New prompt');
      expect(result).toEqual({ ok: true });

      const check = db.exec(
        'SELECT system_prompt FROM agent_definitions WHERE id = ?',
        [agentId],
      );
      expect(check[0].values[0][0]).toBe('New prompt');
    });
  });

  // ── agents:run ──────────────────────────────────────────────────────────────

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

    it('returns error when no Ollama model is selected', async () => {
      db.run(
        `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
         VALUES ('Agent', 'Desc', 'Prompt', '[]')`,
      );
      const idResult = db.exec('SELECT last_insert_rowid() AS id');
      const agentId = idResult[0].values[0][0] as number;

      const result = await callHandler('agents:run', agentId, 'repo', 'owner/repo');
      expect((result as Record<string, unknown>).error).toContain('No Ollama model');
    });
  });

  // ── agents:get-session ──────────────────────────────────────────────────────

  describe('agents:get-session', () => {
    it('returns null for non-number sessionId', () => {
      const result = callHandler('agents:get-session', 'bad');
      expect(result).toBeNull();
    });

    it('returns null for unknown session ID', () => {
      const result = callHandler('agents:get-session', 9999);
      expect(result).toBeNull();
    });
  });

  // ── agents:approve-finding ──────────────────────────────────────────────────

  describe('agents:approve-finding', () => {
    it('returns { ok: false } for non-number findingId', () => {
      const result = callHandler('agents:approve-finding', 'bad');
      expect(result).toEqual({ ok: false });
    });

    it('returns { ok: false } for null findingId', () => {
      const result = callHandler('agents:approve-finding', null);
      expect(result).toEqual({ ok: false });
    });

    it('returns { ok: true } for a valid findingId (even if no row exists)', () => {
      const result = callHandler('agents:approve-finding', 9999);
      expect(result).toEqual({ ok: true });
    });
  });

  // ── agents:reject-finding ───────────────────────────────────────────────────

  describe('agents:reject-finding', () => {
    it('returns { ok: false } for non-number findingId', () => {
      const result = callHandler('agents:reject-finding', 'bad');
      expect(result).toEqual({ ok: false });
    });

    it('returns { ok: false } for undefined findingId', () => {
      const result = callHandler('agents:reject-finding', undefined);
      expect(result).toEqual({ ok: false });
    });

    it('returns { ok: true } for a valid findingId (even if no row exists)', () => {
      const result = callHandler('agents:reject-finding', 9999);
      expect(result).toEqual({ ok: true });
    });
  });

  // ── agents:execute-finding ──────────────────────────────────────────────────

  describe('agents:execute-finding', () => {
    it('returns error for non-number findingId', async () => {
      const result = await callHandler('agents:execute-finding', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid findingId' });
    });

    it('returns error when finding is not found in DB', async () => {
      const result = await callHandler('agents:execute-finding', 9999);
      expect(result).toEqual({ ok: false, error: 'Finding not found' });
    });
  });

  // ── github:fetch-workflow-runs ───────────────────────────────────────────────

  describe('github:fetch-workflow-runs', () => {
    it('returns error for invalid repo name (no slash)', async () => {
      const result = await callHandler('github:fetch-workflow-runs', 'nodashrepo');
      expect(result).toEqual({ ok: false, error: 'Invalid repo name' });
    });

    it('returns error for non-string repo name', async () => {
      const result = await callHandler('github:fetch-workflow-runs', 123);
      expect(result).toEqual({ ok: false, error: 'Invalid repo name' });
    });

    it('returns error when not authenticated', async () => {
      const result = await callHandler('github:fetch-workflow-runs', 'owner/repo');
      expect(result).toEqual({ ok: false, error: 'Not authenticated with GitHub' });
    });
  });

  // ── github:get-workflow-summary ──────────────────────────────────────────────

  describe('github:get-workflow-summary', () => {
    it('returns empty summary for empty repoFullName', () => {
      const result = callHandler('github:get-workflow-summary', '') as Record<string, unknown>;
      expect(result.total_runs).toBe(0);
      expect(result.recent_runs).toEqual([]);
    });

    it('returns empty summary for non-string repoFullName', () => {
      const result = callHandler('github:get-workflow-summary', null) as Record<string, unknown>;
      expect(result.total_runs).toBe(0);
      expect(result.recent_runs).toEqual([]);
    });
  });

  // ── github:get-cached-workflow-info ─────────────────────────────────────────

  describe('github:get-cached-workflow-info', () => {
    it('returns empty info for empty repoFullName', () => {
      const result = callHandler('github:get-cached-workflow-info', '') as Record<string, unknown>;
      expect(result.fetchedAt).toBeNull();
      expect(result.runCount).toBe(0);
    });

    it('returns empty info for non-string repoFullName', () => {
      const result = callHandler('github:get-cached-workflow-info', 42) as Record<string, unknown>;
      expect(result.fetchedAt).toBeNull();
      expect(result.runCount).toBe(0);
    });

    it('returns zero count on a fresh DB', () => {
      const result = callHandler(
        'github:get-cached-workflow-info',
        'owner/repo',
      ) as Record<string, unknown>;
      expect(result.runCount).toBe(0);
    });
  });
});
