/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Unit tests for the Claude Agent SDK escalation service.
 *
 * Covers the pure DB lookups (resolveLocalRepoPath, resolveEscalationRunInfo),
 * the stream-json parsing helpers, CLI-availability detection (mocked
 * child_process.spawn — no real CLI is invoked), and the end-to-end
 * runClaudeAgentQuery flow against a fake spawned process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import {
  detectClaudeCli,
  resetClaudeCliAvailabilityCache,
  resolveLocalRepoPath,
  resolveEscalationRunInfo,
  extractTextDelta,
  parseResultLine,
  runClaudeAgentQuery,
  DEFAULT_CLAUDE_AGENT_MODEL,
} from '../../src/services/claude-agent';

const mockSpawn = vi.mocked(spawn);

// ── Fake child_process.ChildProcess ─────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClaudeCliAvailabilityCache();
});

// ── detectClaudeCli ───────────────────────────────────────────────────────────

describe('detectClaudeCli', () => {
  it('reports available when `claude --version` exits 0', async () => {
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('2.1.263 (Claude Code)\n'));
        child.emit('close', 0);
      }, 0);
      return child as never;
    });

    const result = await detectClaudeCli(true);
    expect(result.available).toBe(true);
    expect(result.version).toContain('2.1.263');
  });

  it('reports unavailable when spawn errors (CLI not on PATH)', async () => {
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      setTimeout(() => {
        child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
      }, 0);
      return child as never;
    });

    const result = await detectClaudeCli(true);
    expect(result.available).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('reports unavailable when the process exits non-zero', async () => {
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      setTimeout(() => child.emit('close', 1), 0);
      return child as never;
    });

    const result = await detectClaudeCli(true);
    expect(result.available).toBe(false);
    expect(result.error).toContain('1');
  });

  it('caches the result across calls unless force is passed', async () => {
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      setTimeout(() => child.emit('close', 0), 0);
      return child as never;
    });

    await detectClaudeCli(true);
    await detectClaudeCli();
    await detectClaudeCli();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await detectClaudeCli(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

// ── resolveLocalRepoPath ──────────────────────────────────────────────────────

describe('resolveLocalRepoPath', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('returns null when the repo is not linked to any local clone', () => {
    expect(resolveLocalRepoPath(db, 'org/repo')).toBeNull();
  });

  it('returns the local clone path when linked', () => {
    db.run(`INSERT INTO github_repos (full_name, name) VALUES ('org/repo', 'repo')`);
    const repoId = (db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number);
    db.run(`INSERT INTO local_repos (local_path, github_repo_id) VALUES ('/home/user/repo', ?)`, [repoId]);
    const localRepoId = (db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number);
    db.run(
      `INSERT INTO local_repo_remotes (local_repo_id, name, url, github_repo_id) VALUES (?, 'origin', 'https://github.com/org/repo.git', ?)`,
      [localRepoId, repoId],
    );

    expect(resolveLocalRepoPath(db, 'org/repo')).toBe('/home/user/repo');
  });
});

// ── resolveEscalationRunInfo ──────────────────────────────────────────────────

describe('resolveEscalationRunInfo', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  function insertRun(id: string, conclusion: string, headSha: string, startedAt: string, workflowName = 'CI') {
    db.run(
      `INSERT INTO github_workflow_runs (id, repo_full_name, workflow_name, head_sha, conclusion, run_number, run_started_at, html_url)
       VALUES (?, 'org/repo', ?, ?, ?, ?, ?, 'https://github.com/org/repo/actions/runs/' || ?)`,
      [id, workflowName, headSha, conclusion, Number(id), startedAt, id],
    );
  }

  it('returns empty info when there is no cached run history', () => {
    const info = resolveEscalationRunInfo(db, 'org/repo');
    expect(info.firstFailureHeadSha).toBeNull();
    expect(info.lastSuccessHeadSha).toBeNull();
  });

  it('returns empty info when the most recent run is not failing', () => {
    insertRun('1', 'success', 'sha1', '2024-01-01T00:00:00Z');
    const info = resolveEscalationRunInfo(db, 'org/repo');
    expect(info.firstFailureHeadSha).toBeNull();
    expect(info.workflowName).toBe('CI');
  });

  it('finds the start of a failing streak and the last known-good commit before it', () => {
    insertRun('1', 'success', 'sha-good', '2024-01-01T00:00:00Z');
    insertRun('2', 'failure', 'sha-bad-1', '2024-01-02T00:00:00Z');
    insertRun('3', 'failure', 'sha-bad-2', '2024-01-03T00:00:00Z');

    const info = resolveEscalationRunInfo(db, 'org/repo');
    expect(info.firstFailureHeadSha).toBe('sha-bad-1');
    expect(info.firstFailureRunNumber).toBe(2);
    expect(info.lastSuccessHeadSha).toBe('sha-good');
    expect(info.workflowName).toBe('CI');
  });

  it('handles a failing streak with no known-good run in cached history', () => {
    insertRun('1', 'failure', 'sha-bad-1', '2024-01-01T00:00:00Z');
    insertRun('2', 'failure', 'sha-bad-2', '2024-01-02T00:00:00Z');

    const info = resolveEscalationRunInfo(db, 'org/repo');
    expect(info.firstFailureHeadSha).toBe('sha-bad-1');
    expect(info.lastSuccessHeadSha).toBeNull();
  });

  it('filters by workflowFilter when provided', () => {
    insertRun('1', 'success', 'ci-good', '2024-01-01T00:00:00Z', 'CI');
    insertRun('2', 'failure', 'ci-bad', '2024-01-02T00:00:00Z', 'CI');
    insertRun('3', 'failure', 'deploy-bad', '2024-01-03T00:00:00Z', 'Deploy');

    const info = resolveEscalationRunInfo(db, 'org/repo', 'CI');
    expect(info.firstFailureHeadSha).toBe('ci-bad');
    expect(info.workflowName).toBe('CI');
  });
});

// ── stream-json parsing helpers ───────────────────────────────────────────────

describe('extractTextDelta', () => {
  it('extracts text from a content_block_delta / text_delta event', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    });
    expect(extractTextDelta(line)).toBe('hello');
  });

  it('returns null for non-text-delta events', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } });
    expect(extractTextDelta(line)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractTextDelta('not json{')).toBeNull();
  });

  it('returns null for non-stream_event lines', () => {
    expect(extractTextDelta(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull();
  });
});

describe('parseResultLine', () => {
  it('parses a result-type line', () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: 'done' });
    expect(parseResultLine(line)).toEqual({ type: 'result', is_error: false, result: 'done' });
  });

  it('returns null for non-result lines', () => {
    expect(parseResultLine(JSON.stringify({ type: 'stream_event' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseResultLine('not json{')).toBeNull();
  });
});

// ── runClaudeAgentQuery ────────────────────────────────────────────────────────

describe('runClaudeAgentQuery', () => {
  function versionCheckChild(): FakeChild {
    const child = makeFakeChild();
    setTimeout(() => child.emit('close', 0), 0);
    return child;
  }

  it('throws clearly when the CLI is not available', async () => {
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild();
      setTimeout(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })), 0);
      return child as never;
    });

    await expect(
      runClaudeAgentQuery('system', 'user message', '/repo', () => {}),
    ).rejects.toThrow(/Claude CLI not found/);
  });

  it('streams tokens and resolves structured findings from the result line', async () => {
    let call = 0;
    mockSpawn.mockImplementation(() => {
      call++;
      if (call === 1) return versionCheckChild() as never; // --version probe

      const child = makeFakeChild();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(
          JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Investigating…' } } }) + '\n',
        ));
        const result = {
          type: 'result',
          is_error: false,
          result: 'Investigating…',
          total_cost_usd: 0.01,
          structured_output: {
            summary: 'Root cause found',
            findings: [{ finding_type: 'action_required', subject: 'ci.yml', reason: 'bad step' }],
          },
        };
        child.stdout.emit('data', Buffer.from(JSON.stringify(result) + '\n'));
        child.emit('close', 0);
      }, 0);
      return child as never;
    });

    const tokens: string[] = [];
    const result = await runClaudeAgentQuery('system prompt', 'user message', '/repo', (t) => tokens.push(t));

    expect(tokens).toEqual(['Investigating…']);
    expect(result.isError).toBe(false);
    expect(result.summary).toBe('Root cause found');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].subject).toBe('ci.yml');
    expect(result.costUsd).toBe(0.01);

    // The actual query call (not the --version probe) is invoked with a
    // read-only, restricted tool set and the repo as cwd.
    const queryCall = mockSpawn.mock.calls[1];
    expect(queryCall[1]).toContain('--restricted');
    expect(queryCall[1]).toContain(DEFAULT_CLAUDE_AGENT_MODEL);
    expect(queryCall[2]).toMatchObject({ cwd: '/repo' });
  });

  it('rejects when the CLI exits without ever emitting a result line', async () => {
    let call = 0;
    mockSpawn.mockImplementation(() => {
      call++;
      if (call === 1) return versionCheckChild() as never;
      const child = makeFakeChild();
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('fatal error'));
        child.emit('close', 1);
      }, 0);
      return child as never;
    });

    await expect(
      runClaudeAgentQuery('system', 'user', '/repo', () => {}),
    ).rejects.toThrow(/without a result/);
  });

  it('surfaces is_error results without throwing', async () => {
    let call = 0;
    mockSpawn.mockImplementation(() => {
      call++;
      if (call === 1) return versionCheckChild() as never;
      const child = makeFakeChild();
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: true, result: 'refused' }) + '\n'));
        child.emit('close', 0);
      }, 0);
      return child as never;
    });

    const result = await runClaudeAgentQuery('system', 'user', '/repo', () => {});
    expect(result.isError).toBe(true);
    expect(result.errorMessage).toBe('refused');
  });
});
