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
  createGitHubIssue: vi.fn().mockResolvedValue({
    url: 'https://github.com/owner/repo/issues/1',
    number: 1,
    node_id: 'I_kwDOtest123',
  }),
}));

vi.mock('../../src/services/github-oauth', () => ({
  loadGitHubAuth: vi.fn(() => null),
}));

vi.mock('../../src/services/github-copilot', () => ({
  checkCopilotAssignable: vi.fn(),
  assignCopilotToIssue: vi.fn(),
}));

vi.mock('../../src/plugins/agents/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/plugins/agents/runner')>();
  return {
    ...actual,
    runAgentSession: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../src/services/claude', () => ({
  checkClaudeRateLimit: vi.fn(),
}));

vi.mock('../../src/plugins/claude/handler', () => ({
  resolveAccessToken: vi.fn(),
}));

vi.mock('../../src/services/claude-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/claude-agent')>();
  return {
    ...actual,
    detectClaudeCli: vi.fn(),
  };
});

import { registerHandlers } from '../../src/plugins/agents/handler';
import { runAgentSession } from '../../src/plugins/agents/runner';
import { checkClaudeRateLimit } from '../../src/services/claude';
import { resolveAccessToken } from '../../src/plugins/claude/handler';
import { detectClaudeCli } from '../../src/services/claude-agent';
import { createGitHubIssue } from '../../src/services/github-workflows';
import { loadGitHubAuth } from '../../src/services/github-oauth';
import { checkCopilotAssignable, assignCopilotToIssue } from '../../src/services/github-copilot';

const mockRunAgentSession = vi.mocked(runAgentSession);
const mockCheckClaudeRateLimit = vi.mocked(checkClaudeRateLimit);
const mockResolveAccessToken = vi.mocked(resolveAccessToken);
const mockDetectClaudeCli = vi.mocked(detectClaudeCli);

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

/** Link org/repo to a local clone at the given path so resolveLocalRepoPath finds it. */
function linkLocalRepo(db: SqlJsDatabase, repoFullName: string, localPath: string): void {
  db.run(`INSERT INTO github_repos (full_name, name) VALUES (?, ?)`, [repoFullName, repoFullName.split('/')[1]]);
  const repoId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
  db.run(`INSERT INTO local_repos (local_path, github_repo_id) VALUES (?, ?)`, [localPath, repoId]);
  const localRepoId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
  db.run(
    `INSERT INTO local_repo_remotes (local_repo_id, name, url, github_repo_id) VALUES (?, 'origin', ?, ?)`,
    [localRepoId, `https://github.com/${repoFullName}.git`, repoId],
  );
}

/** Insert an already-approved agent_findings row (with its parent session) and return its id. */
function insertApprovedFinding(
  db: SqlJsDatabase,
  actionType: string,
  actionData: Record<string, unknown> | null,
  repoFullName = 'owner/repo',
): number {
  db.run(
    `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
     VALUES ('Test Agent', 'Desc', 'Prompt', '[]')`,
  );
  const agentId = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;

  db.run(
    `INSERT INTO agent_sessions (agent_id, scope_type, scope_value, status)
     VALUES (?, 'repo', ?, 'completed')`,
    [agentId, repoFullName],
  );
  const sessionId = (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;

  db.run(
    `INSERT INTO agent_findings
      (session_id, finding_type, subject, reason, action_type, action_data, approved, approved_at)
     VALUES (?, 'action_required', 'Test finding', 'Test reason', ?, ?, 1, datetime('now'))`,
    [sessionId, actionType, actionData ? JSON.stringify(actionData) : null],
  );
  return (db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]) as number;
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

    // Escalation preflight defaults to "everything ready" — individual tests
    // override one dimension at a time to exercise each gate.
    mockDetectClaudeCli.mockResolvedValue({ available: true, version: '2.1.263' });
    mockResolveAccessToken.mockResolvedValue({ token: 'test-token', source: 'stored' });
    mockCheckClaudeRateLimit.mockResolvedValue({
      status: 200, limited: false, resetAt: null, retryAfterSec: null, fiveHour: null, sevenDay: null,
    });

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
    // vi.clearAllMocks() (in beforeEach) clears call history but not
    // mockReturnValue/mockResolvedValue overrides — reset those explicitly so
    // a value set in one test can't leak into the next.
    vi.mocked(loadGitHubAuth).mockReturnValue(null);
    vi.mocked(checkCopilotAssignable).mockReset();
    vi.mocked(assignCopilotToIssue).mockReset();
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
      expect(result).toEqual({ ok: false, error: 'Invalid agentId' });
    });

    it('returns error for invalid scopeType', async () => {
      const result = await callHandler('agents:run', 1, 'invalid', 'owner/repo');
      expect(result).toEqual({ ok: false, error: 'Invalid scopeType' });
    });

    it('returns error for empty scopeValue', async () => {
      const result = await callHandler('agents:run', 1, 'repo', '');
      expect(result).toEqual({ ok: false, error: 'Invalid scopeValue' });
    });

    it('returns error for non-string workflowFilter', async () => {
      const result = await callHandler('agents:run', 1, 'repo', 'owner/repo', 42);
      expect(result).toEqual({ ok: false, error: 'Invalid workflowFilter' });
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

    describe('assign_copilot action', () => {
      const actionData = {
        issue_title: 'Deploy workflow keeps failing',
        issue_body: 'The deploy step fails with "module not found".',
        workflow_name: 'Deploy',
        failing_step: 'Install dependencies',
        run_urls: ['https://github.com/owner/repo/actions/runs/1'],
      };

      it('fails when not authenticated with GitHub', async () => {
        vi.mocked(loadGitHubAuth).mockReturnValue(null);
        const findingId = insertApprovedFinding(db, 'assign_copilot', actionData);

        const result = await callHandler('agents:execute-finding', findingId) as { ok: boolean; error?: string };
        expect(result).toEqual({ ok: false, error: 'Not authenticated with GitHub' });
        expect(checkCopilotAssignable).not.toHaveBeenCalled();
      });

      it('records execution_error when Copilot is not enabled / no seat', async () => {
        vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'me', accessToken: 'tok', scopes: 'repo', avatarUrl: null });
        vi.mocked(checkCopilotAssignable).mockResolvedValue({ available: false, reason: 'not_enabled_or_no_seat' });
        const findingId = insertApprovedFinding(db, 'assign_copilot', actionData);

        const result = await callHandler('agents:execute-finding', findingId) as { ok: boolean; error?: string };
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Copilot coding agent is not assignable/);
        expect(createGitHubIssue).not.toHaveBeenCalled();

        const row = db.exec('SELECT execution_error, executed_at FROM agent_findings WHERE id = ?', [findingId]);
        expect(row[0].values[0][0]).toMatch(/Copilot coding agent is not assignable/);
        expect(row[0].values[0][1]).toBeNull();
      });

      it('records execution_error for insufficient repo access', async () => {
        vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'me', accessToken: 'tok', scopes: 'repo', avatarUrl: null });
        vi.mocked(checkCopilotAssignable).mockResolvedValue({ available: false, reason: 'repo_not_found_or_no_access' });
        const findingId = insertApprovedFinding(db, 'assign_copilot', actionData);

        const result = await callHandler('agents:execute-finding', findingId) as { ok: boolean; error?: string };
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/cannot access owner\/repo/);
      });

      it('creates the issue and assigns Copilot on success', async () => {
        vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'me', accessToken: 'tok', scopes: 'repo', avatarUrl: null });
        vi.mocked(checkCopilotAssignable).mockResolvedValue({ available: true, botId: 'BOT_1' });
        vi.mocked(assignCopilotToIssue).mockResolvedValue(undefined);
        const findingId = insertApprovedFinding(db, 'assign_copilot', actionData);

        const result = await callHandler('agents:execute-finding', findingId) as { ok: boolean; error?: string };
        expect(result).toEqual({ ok: true });

        expect(createGitHubIssue).toHaveBeenCalledWith(
          'tok',
          'owner/repo',
          'Deploy workflow keeps failing',
          expect.stringContaining('module not found'),
          [],
        );
        // The composed body includes the workflow/step and run links regardless of the LLM's issue_body.
        const composedBody = vi.mocked(createGitHubIssue).mock.calls[0][3];
        expect(composedBody).toContain('Deploy');
        expect(composedBody).toContain('Install dependencies');
        expect(composedBody).toContain('https://github.com/owner/repo/actions/runs/1');

        expect(assignCopilotToIssue).toHaveBeenCalledWith('tok', 'owner/repo', 'I_kwDOtest123');

        const row = db.exec('SELECT executed_at, execution_error FROM agent_findings WHERE id = ?', [findingId]);
        expect(row[0].values[0][0]).not.toBeNull();
        expect(row[0].values[0][1]).toBeNull();
      });

      it('records a clear execution_error (mentioning the created issue) when assignment fails after issue creation', async () => {
        vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'me', accessToken: 'tok', scopes: 'repo', avatarUrl: null });
        vi.mocked(checkCopilotAssignable).mockResolvedValue({ available: true, botId: 'BOT_1' });
        vi.mocked(assignCopilotToIssue).mockRejectedValue(new Error('secondary rate limit'));
        const findingId = insertApprovedFinding(db, 'assign_copilot', actionData);

        const result = await callHandler('agents:execute-finding', findingId) as { ok: boolean; error?: string };
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Issue created \(https:\/\/github\.com\/owner\/repo\/issues\/1\)/);
        expect(result.error).toMatch(/secondary rate limit/);
      });
    });
  });

  // ── agents:check-copilot-availability ───────────────────────────────────────

  describe('agents:check-copilot-availability', () => {
    it('returns unavailable for an invalid repo name', async () => {
      const result = await callHandler('agents:check-copilot-availability', 'norepo') as { available: boolean };
      expect(result.available).toBe(false);
    });

    it('returns not_authenticated when no GitHub auth is stored', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue(null);
      const result = await callHandler('agents:check-copilot-availability', 'owner/repo');
      expect(result).toEqual({ available: false, reason: 'not_authenticated' });
      expect(checkCopilotAssignable).not.toHaveBeenCalled();
    });

    it('delegates to checkCopilotAssignable when authenticated', async () => {
      vi.mocked(loadGitHubAuth).mockReturnValue({ login: 'me', accessToken: 'tok', scopes: 'repo', avatarUrl: null });
      vi.mocked(checkCopilotAssignable).mockResolvedValue({ available: true, botId: 'BOT_1' });

      const result = await callHandler('agents:check-copilot-availability', 'owner/repo');
      expect(result).toEqual({ available: true, botId: 'BOT_1' });
      expect(checkCopilotAssignable).toHaveBeenCalledWith('tok', 'owner/repo');
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

  // ── agents:escalation-readiness ─────────────────────────────────────────────

  describe('agents:escalation-readiness', () => {
    it('returns not-ready for an invalid repo name', async () => {
      const result = await callHandler('agents:escalation-readiness', '');
      expect(result).toEqual({ ok: false, reason: 'Invalid repository' });
    });

    it('returns not-ready when the repo has no local clone', async () => {
      const result = await callHandler('agents:escalation-readiness', 'org/repo') as { ok: boolean; reason: string };
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not cloned locally');
    });

    it('returns not-ready when the Claude CLI is unavailable', async () => {
      linkLocalRepo(db, 'org/repo', '/home/user/repo');
      mockDetectClaudeCli.mockResolvedValue({ available: false, error: 'ENOENT' });

      const result = await callHandler('agents:escalation-readiness', 'org/repo') as { ok: boolean; reason: string };
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Claude CLI not found');
    });

    it('returns not-ready when not connected to Claude', async () => {
      linkLocalRepo(db, 'org/repo', '/home/user/repo');
      mockResolveAccessToken.mockResolvedValue(null);

      const result = await callHandler('agents:escalation-readiness', 'org/repo') as { ok: boolean; reason: string };
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Not connected to Claude');
    });

    it('returns not-ready with a reset time when rate limited', async () => {
      linkLocalRepo(db, 'org/repo', '/home/user/repo');
      mockCheckClaudeRateLimit.mockResolvedValue({
        status: 429, limited: true, resetAt: 1234567890, retryAfterSec: 60, fiveHour: null, sevenDay: null,
      });

      const result = await callHandler('agents:escalation-readiness', 'org/repo') as { ok: boolean; reason: string; resetAt: number };
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('rate limit');
      expect(result.resetAt).toBe(1234567890);
    });

    it('returns ready when the clone exists, the CLI is installed, and the account is usable', async () => {
      linkLocalRepo(db, 'org/repo', '/home/user/repo');
      const result = await callHandler('agents:escalation-readiness', 'org/repo');
      expect(result).toEqual({ ok: true });
    });
  });

  // ── agents:escalate ──────────────────────────────────────────────────────────

  describe('agents:escalate', () => {
    function seedParentSession(): number {
      db.run(
        `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
         VALUES ('Test Agent', 'Desc', 'You are a test agent.', '[]')`,
      );
      const agentId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
      db.run(
        `INSERT INTO agent_sessions (agent_id, scope_type, scope_value, status, provider)
         VALUES (?, 'repo', 'org/repo', 'completed', 'ollama')`,
        [agentId],
      );
      return db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
    }

    it('returns error for a non-number sessionId', async () => {
      const result = await callHandler('agents:escalate', 'bad');
      expect(result).toEqual({ ok: false, error: 'Invalid sessionId' });
    });

    it('returns error when the source session does not exist', async () => {
      const result = await callHandler('agents:escalate', 9999);
      expect(result).toEqual({ ok: false, error: 'Source session not found' });
    });

    it('returns error for a non-repo-scoped source session', async () => {
      db.run(
        `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
         VALUES ('Test Agent', 'Desc', 'You are a test agent.', '[]')`,
      );
      const agentId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
      db.run(`INSERT INTO agent_sessions (agent_id, scope_type, scope_value) VALUES (?, 'org', 'my-org')`, [agentId]);
      const sessionId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;

      const result = await callHandler('agents:escalate', sessionId);
      expect(result).toEqual({ ok: false, error: 'Escalation is only available for repo-scoped sessions' });
    });

    it('returns the readiness reason when escalation is not ready (no local clone)', async () => {
      const sessionId = seedParentSession();
      const result = await callHandler('agents:escalate', sessionId) as { ok: boolean; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not cloned locally');
    });

    it('creates a linked claude-agent-sdk session and starts the runner on success', async () => {
      linkLocalRepo(db, 'org/repo', '/home/user/repo');
      const sourceSessionId = seedParentSession();

      const result = await callHandler('agents:escalate', sourceSessionId) as { ok: boolean; sessionId: number };
      expect(result.ok).toBe(true);
      expect(typeof result.sessionId).toBe('number');
      expect(result.sessionId).not.toBe(sourceSessionId);

      const row = db.exec(
        'SELECT provider, model, parent_session_id, scope_value FROM agent_sessions WHERE id = ?',
        [result.sessionId],
      )[0].values[0];
      expect(row).toEqual(['claude-agent-sdk', 'claude-opus-5', sourceSessionId, 'org/repo']);

      expect(mockRunAgentSession).toHaveBeenCalledTimes(1);
      const call = mockRunAgentSession.mock.calls[0];
      expect(call[3]).toBe('repo'); // scopeType
      expect(call[4]).toBe('org/repo'); // scopeValue
      expect(call[8]).toMatchObject({ id: 'claude-agent-sdk' }); // provider
      expect(call[9]).toEqual({ cwd: '/home/user/repo' }); // providerOptions
    });
  });
});
