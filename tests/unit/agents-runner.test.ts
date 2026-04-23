/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  listAgentDefinitions,
  getAgentDefinition,
  createAgentSession,
  updateAgentSession,
  storeAgentFinding,
  getAgentSession,
  extractJsonResult,
  runAgentSession,
} from '../../src/plugins/agents/runner';
import { streamChat } from '../../src/services/ollama';

vi.mock('../../src/services/ollama', () => ({
  streamChat: vi.fn(),
}));

vi.mock('../../src/services/github-workflows', () => ({
  getWorkflowSummaryForRepo: vi.fn(() => ({ total_runs: 0, recent_runs: [], jobs_by_run: {} })),
}));

const mockStreamChat = vi.mocked(streamChat);

// ── Shared fixture ────────────────────────────────────────────────────────────

let db: SqlJsDatabase;
let agentId: number;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(getSchema());
  db.run(
    `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
     VALUES ('Test Agent', 'A test agent', 'You are a test agent.', '[]')`,
  );
  const idResult = db.exec('SELECT last_insert_rowid() AS id');
  agentId = idResult[0].values[0][0] as number;
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

function agentDef() {
  return getAgentDefinition(db, agentId)!;
}

function makeMockWindow() {
  return { webContents: { send: vi.fn() } };
}

// ── extractJsonResult ─────────────────────────────────────────────────────────

describe('extractJsonResult', () => {
  it('returns null when there is no code block', () => {
    expect(extractJsonResult('No JSON here at all.')).toBeNull();
  });

  it('returns null when the code block contains malformed JSON', () => {
    expect(extractJsonResult('```json\n{ bad json }\n```')).toBeNull();
  });

  it('returns the parsed object for a valid json block', () => {
    const text = '```json\n{"summary":"ok","findings":[]}\n```';
    expect(extractJsonResult(text)).toEqual({ summary: 'ok', findings: [] });
  });

  it('returns only the first match when multiple blocks are present', () => {
    const text = [
      '```json\n{"summary":"first"}\n```',
      'some prose',
      '```json\n{"summary":"second"}\n```',
    ].join('\n');
    expect(extractJsonResult(text)).toEqual({ summary: 'first' });
  });
});

// ── listAgentDefinitions ──────────────────────────────────────────────────────

describe('listAgentDefinitions', () => {
  it('returns an empty array when no definitions exist', () => {
    db.run('DELETE FROM agent_definitions');
    expect(listAgentDefinitions(db)).toEqual([]);
  });

  it('returns all inserted definitions', () => {
    db.run(
      `INSERT INTO agent_definitions (name, description, system_prompt, tools_allowed)
       VALUES ('Second Agent', 'desc2', 'sys2', '[]')`,
    );
    const defs = listAgentDefinitions(db);
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toContain('Test Agent');
    expect(defs.map((d) => d.name)).toContain('Second Agent');
  });
});

// ── getAgentDefinition ────────────────────────────────────────────────────────

describe('getAgentDefinition', () => {
  it('returns null for an unknown id', () => {
    expect(getAgentDefinition(db, 9999)).toBeNull();
  });

  it('returns the definition for a known id', () => {
    const def = getAgentDefinition(db, agentId);
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Test Agent');
    expect(def!.system_prompt).toBe('You are a test agent.');
  });
});

// ── DB helpers ────────────────────────────────────────────────────────────────

describe('createAgentSession', () => {
  it('inserts a row and returns a positive integer ID', () => {
    const id = createAgentSession(db, agentId, 'repo', 'org/repo');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('creates a session with status "running"', () => {
    const id = createAgentSession(db, agentId, 'repo', 'org/repo');
    const result = db.exec(`SELECT status FROM agent_sessions WHERE id = ${id}`);
    expect(result[0].values[0][0]).toBe('running');
  });
});

describe('updateAgentSession', () => {
  it('updates status, summary, raw_result, and completed_at', () => {
    const id = createAgentSession(db, agentId, 'repo', 'org/repo');
    updateAgentSession(db, id, 'completed', 'All good.', '{"raw":1}');

    const result = db.exec(`SELECT status, summary, raw_result, completed_at FROM agent_sessions WHERE id = ${id}`);
    const [status, summary, rawResult, completedAt] = result[0].values[0];
    expect(status).toBe('completed');
    expect(summary).toBe('All good.');
    expect(rawResult).toBe('{"raw":1}');
    expect(completedAt).toBeTruthy();
  });
});

describe('storeAgentFinding', () => {
  it('inserts a finding and returns a positive integer ID', () => {
    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
    const findingId = storeAgentFinding(db, sessionId, {
      finding_type: 'investigate',
      subject: 'some-workflow',
      reason: 'kept failing',
    });
    expect(typeof findingId).toBe('number');
    expect(findingId).toBeGreaterThan(0);
  });
});

describe('getAgentSession', () => {
  it('returns null for an unknown session ID', () => {
    expect(getAgentSession(db, 9999)).toBeNull();
  });

  it('returns the session with its findings array', () => {
    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
    updateAgentSession(db, sessionId, 'completed', 'Summary text', null);
    storeAgentFinding(db, sessionId, { finding_type: 'action_required', subject: 'repo/x', reason: 'stale' });

    const session = getAgentSession(db, sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('completed');
    expect(session!.agent_name).toBe('Test Agent');
    expect(session!.findings).toHaveLength(1);
    expect(session!.findings[0].subject).toBe('repo/x');
  });
});

// ── runAgentSession ───────────────────────────────────────────────────────────

describe('runAgentSession', () => {
  const VALID_JSON_RESPONSE =
    '```json\n{"summary":"agent summary","findings":[{"finding_type":"investigate","subject":"org/repo","reason":"flaky"}]}\n```';

  it('happy path: two streamChat calls, findings persisted, session completed', async () => {
    mockStreamChat
      .mockImplementationOnce(async (_m, _msgs, onToken) => {
        onToken(VALID_JSON_RESPONSE);
      })
      .mockImplementationOnce(async (_m, _msgs, onToken) => {
        onToken(VALID_JSON_RESPONSE);
      });

    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
    const mockWin = makeMockWindow();

    await runAgentSession(db, sessionId, agentDef(), 'repo', 'org/repo', 'test-model', () => mockWin as never);

    expect(mockStreamChat).toHaveBeenCalledTimes(2);

    // Phase 1 messages: system + user
    const [, phase1Messages] = mockStreamChat.mock.calls[0];
    expect(phase1Messages[0].role).toBe('system');
    expect(phase1Messages[1].role).toBe('user');

    // Phase 2 messages include the assistant turn (phase-1 response)
    const [, phase2Messages] = mockStreamChat.mock.calls[1];
    expect(phase2Messages[2].role).toBe('assistant');

    const session = getAgentSession(db, sessionId);
    expect(session!.status).toBe('completed');
    expect(session!.findings).toHaveLength(1);
    expect(session!.findings[0].subject).toBe('org/repo');

    expect(mockWin.webContents.send).toHaveBeenCalledWith('agent:analysis-complete', { sessionId });
    expect(mockWin.webContents.send).toHaveBeenCalledWith('agent:session-complete', { sessionId });
  });

  it('malformed JSON: session completed with no findings stored', async () => {
    const phaseResponse = 'Analysis text only, no JSON block.';
    mockStreamChat
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken(phaseResponse); })
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken('still no json block here'); });

    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
    const mockWin = makeMockWindow();

    await runAgentSession(db, sessionId, agentDef(), 'repo', 'org/repo', 'test-model', () => mockWin as never);

    const session = getAgentSession(db, sessionId);
    expect(session!.status).toBe('completed');
    expect(session!.findings).toHaveLength(0);
    // summary falls back to first 300 chars of phase-1 analysis
    expect(session!.summary).toBe(phaseResponse.slice(0, 300));
  });

  it('phase 2 timeout: session completed using phase-1 fallback', async () => {
    vi.useFakeTimers();
    try {
      mockStreamChat
        .mockImplementationOnce(async (_m, _msgs, onToken) => {
          onToken(VALID_JSON_RESPONSE);
        })
        .mockImplementationOnce(async (_m, _msgs, _onToken, signal) => {
          return new Promise<void>((_resolve, reject) => {
            signal!.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        });

      const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
      const mockWin = makeMockWindow();

      const runPromise = runAgentSession(
        db, sessionId, agentDef(), 'repo', 'org/repo', 'test-model', () => mockWin as never,
      );

      // Advance past the 60-second phase-2 timeout
      await vi.advanceTimersByTimeAsync(61_000);
      await runPromise;

      expect(mockWin.webContents.send).toHaveBeenCalledWith(
        'agent:phase2-error',
        expect.objectContaining({ sessionId }),
      );
      const session = getAgentSession(db, sessionId);
      expect(session!.status).toBe('completed');
      // Phase-1 contained valid JSON, so findings should be stored via fallback
      expect(session!.findings).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('top-level error: session marked failed, window notified via session-error', async () => {
    mockStreamChat.mockRejectedValueOnce(new Error('Ollama connection refused'));

    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
    const mockWin = makeMockWindow();

    await runAgentSession(db, sessionId, agentDef(), 'repo', 'org/repo', 'test-model', () => mockWin as never);

    const session = getAgentSession(db, sessionId);
    expect(session!.status).toBe('failed');
    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'agent:session-error',
      { sessionId, message: 'Ollama connection refused' },
    );
    expect(mockWin.webContents.send).not.toHaveBeenCalledWith(
      'agent:session-complete',
      expect.anything(),
    );
  });

  it('null window: no crash, session still completes normally', async () => {
    mockStreamChat
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken(VALID_JSON_RESPONSE); })
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken(VALID_JSON_RESPONSE); });

    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');

    await expect(
      runAgentSession(db, sessionId, agentDef(), 'repo', 'org/repo', 'test-model', () => null),
    ).resolves.toBeUndefined();

    const session = getAgentSession(db, sessionId);
    expect(session!.status).toBe('completed');
  });

  it('non-repo scope: session completes without notification/workflow context', async () => {
    mockStreamChat
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken(VALID_JSON_RESPONSE); })
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken(VALID_JSON_RESPONSE); });

    const sessionId = createAgentSession(db, agentId, 'org', 'my-org');
    const mockWin = makeMockWindow();

    await runAgentSession(db, sessionId, agentDef(), 'org', 'my-org', 'test-model', () => mockWin as never);

    const session = getAgentSession(db, sessionId);
    expect(session!.status).toBe('completed');

    // Context sent to renderer should contain the N/A placeholders
    const debugContextCall = mockWin.webContents.send.mock.calls.find(
      ([event]) => event === 'agent:debug-context',
    );
    expect(debugContextCall).toBeDefined();
    const payload = debugContextCall![1] as { userMessage: string };
    expect(payload.userMessage).toContain('N/A for non-repo scope');
  });

  it('fallback to phase-1: phase-2 returns no JSON but phase-1 has a valid block', async () => {
    mockStreamChat
      .mockImplementationOnce(async (_m, _msgs, onToken) => {
        onToken(VALID_JSON_RESPONSE); // phase 1 has the JSON
      })
      .mockImplementationOnce(async (_m, _msgs, onToken) => {
        onToken('Sorry, I cannot produce JSON right now.'); // phase 2 has none
      });

    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
    const mockWin = makeMockWindow();

    await runAgentSession(db, sessionId, agentDef(), 'repo', 'org/repo', 'test-model', () => mockWin as never);

    const session = getAgentSession(db, sessionId);
    expect(session!.status).toBe('completed');
    // Findings were extracted from phase-1 fallback
    expect(session!.findings).toHaveLength(1);
    expect(session!.summary).toBe('agent summary');
  });

  it('context assembly: seeds notifications and asserts debug-context includes them', async () => {
    // Seed a notification for the target repo
    db.run(
      `INSERT INTO github_notifications
         (id, repo_full_name, repo_owner, subject_type, subject_title, reason, unread, updated_at)
       VALUES ('notif-1', 'org/repo', 'org', 'PullRequest', 'Fix the bug', 'mention', 1, '2024-01-01T00:00:00Z')`,
    );

    mockStreamChat
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken(VALID_JSON_RESPONSE); })
      .mockImplementationOnce(async (_m, _msgs, onToken) => { onToken(VALID_JSON_RESPONSE); });

    const sessionId = createAgentSession(db, agentId, 'repo', 'org/repo');
    const mockWin = makeMockWindow();

    await runAgentSession(db, sessionId, agentDef(), 'repo', 'org/repo', 'test-model', () => mockWin as never);

    const debugContextCall = mockWin.webContents.send.mock.calls.find(
      ([event]) => event === 'agent:debug-context',
    );
    expect(debugContextCall).toBeDefined();
    const payload = debugContextCall![1] as { sessionId: number; systemPrompt: string; userMessage: string };
    expect(payload.systemPrompt).toBe('You are a test agent.');
    expect(payload.userMessage).toContain('Fix the bug');
    expect(payload.userMessage).toContain('org/repo');
  });
});
