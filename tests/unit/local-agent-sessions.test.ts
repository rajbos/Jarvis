import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deriveClaudeActivity,
  deriveCopilotActivity,
  discoverClaudeLocalSessions,
  discoverCopilotLocalSessions,
  encodeClaudeProjectDir,
  parseWorkspaceYaml,
  readTail,
  readTailEntries,
} from '../../src/services/local-agent-sessions';

const NOW = Date.parse('2026-03-01T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ev = (type: string, msAgo: number, data: Record<string, unknown> = {}) => ({ type, data, timestamp: iso(msAgo) });
/** Every pid started long before it wrote its lock file. */
const startedLongAgo = async (pids: number[]) => new Map(pids.map((p) => [p, 0]));

describe('parseWorkspaceYaml', () => {
  it('parses flat key/value pairs, unquoting single and double quoted values', () => {
    const parsed = parseWorkspaceYaml([
      'id: 1234',
      'cwd: C:\\Users\\me\\repo',
      'name: "Fix \\"quoted\\" bug"',
      "summary: 'it''s fine'",
      'client_name: github/autopilot',
      '  nested: ignored',
    ].join('\r\n'));
    expect(parsed).toEqual({
      id: '1234',
      cwd: 'C:\\Users\\me\\repo',
      name: 'Fix "quoted" bug',
      summary: "it's fine",
      client_name: 'github/autopilot',
    });
  });
});

describe('deriveCopilotActivity', () => {
  it('returns unknown without events', () => {
    expect(deriveCopilotActivity([], NOW)).toBe('unknown');
  });

  it('is waiting_for_user while a permission request is open', () => {
    expect(deriveCopilotActivity([
      ev('tool.execution_start', 5000, { toolName: 'powershell', toolCallId: 't1' }),
      ev('permission.requested', 4000, { requestId: 'p1' }),
    ], NOW)).toBe('waiting_for_user');
  });

  it('is working again once the permission request completed', () => {
    expect(deriveCopilotActivity([
      ev('permission.requested', 4000, { requestId: 'p1' }),
      ev('permission.completed', 3000, { requestId: 'p1' }),
      ev('tool.execution_start', 2000, { toolName: 'powershell', toolCallId: 't1' }),
    ], NOW)).toBe('working');
  });

  it('is waiting_for_user while an ask_user tool call is open', () => {
    expect(deriveCopilotActivity([
      ev('tool.execution_start', 1000, { toolName: 'ask_user', toolCallId: 'a1' }),
    ], NOW)).toBe('waiting_for_user');
  });

  it('treats a recent turn end as an autopilot gap (working) and an old one as idle', () => {
    expect(deriveCopilotActivity([ev('assistant.turn_end', 5_000)], NOW)).toBe('working');
    expect(deriveCopilotActivity([ev('assistant.turn_end', 60_000)], NOW)).toBe('idle');
  });

  it('is idle after task completion, start or resume, ignoring trailing hook events', () => {
    expect(deriveCopilotActivity([ev('tool.execution_complete', 9000), ev('session.task_complete', 8000), ev('hook.end', 7000)], NOW)).toBe('idle');
    expect(deriveCopilotActivity([ev('session.resume', 1000)], NOW)).toBe('idle');
  });

  it('is working during compaction and tool/model activity', () => {
    expect(deriveCopilotActivity([ev('session.compaction_start', 1000)], NOW)).toBe('working');
    expect(deriveCopilotActivity([ev('assistant.message', 1000)], NOW)).toBe('working');
    expect(deriveCopilotActivity([ev('user.message', 1000)], NOW)).toBe('working');
  });
});

describe('deriveClaudeActivity', () => {
  it('is idle when the last assistant message ended its turn', () => {
    expect(deriveClaudeActivity([{ type: 'assistant', message: { stop_reason: 'end_turn' } }], NOW, NOW)).toBe('idle');
  });

  it('is working while the assistant is mid tool-use', () => {
    expect(deriveClaudeActivity([{ type: 'assistant', message: { stop_reason: 'tool_use' } }], NOW - 1000, NOW)).toBe('working');
    expect(deriveClaudeActivity([{ type: 'user', message: {} }], NOW - 1000, NOW)).toBe('working');
  });

  it('is idle when the transcript has not changed for a while', () => {
    expect(deriveClaudeActivity([{ type: 'assistant', message: { stop_reason: 'tool_use' } }], NOW - 10 * 60_000, NOW)).toBe('idle');
  });

  it('is unknown without user/assistant entries', () => {
    expect(deriveClaudeActivity([{ type: 'summary', summary: 'x' }], NOW, NOW)).toBe('unknown');
  });
});

describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeClaudeProjectDir('C:\\Users\\me\\my_repo.git')).toBe('C--Users-me-my-repo-git');
  });
});

describe('filesystem discovery', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agent-sessions-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeCopilotSession(id: string, opts: { pid?: number; yaml?: string; events?: unknown[] }) {
    const dir = path.join(home, '.copilot', 'session-state', id);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.pid !== undefined) fs.writeFileSync(path.join(dir, `inuse.${opts.pid}.lock`), '');
    if (opts.yaml) fs.writeFileSync(path.join(dir, 'workspace.yaml'), opts.yaml);
    if (opts.events) fs.writeFileSync(path.join(dir, 'events.jsonl'), opts.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return dir;
  }

  it('lists only Copilot sessions held by a live process and collects mirrored task ids', async () => {
    writeCopilotSession('live', {
      pid: 111,
      yaml: [
        'id: live',
        'cwd: C:\\src\\repo',
        'name: Build the thing',
        'client_name: github/autopilot',
        'mc_task_id: task-live',
        'created_at: 2026-03-01T10:00:00Z',
        'updated_at: 2026-03-01T11:59:00Z',
      ].join('\n'),
      events: [ev('assistant.turn_start', 3000), ev('tool.execution_start', 2000, { toolName: 'view', toolCallId: 'x' })],
    });
    writeCopilotSession('dead', { pid: 222, yaml: 'id: dead\nmc_task_id: task-dead\n' });
    writeCopilotSession('nolock', { yaml: 'id: nolock\nclient_name: github/cli\n' });

    const result = await discoverCopilotLocalSessions({ homeDir: home, isPidAlive: (pid) => pid === 111, getProcessStartTimes: startedLongAgo, now: () => NOW });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: 'local:copilot:live',
      provider: 'copilot',
      origin: 'local',
      client: 'Copilot app',
      title: 'Build the thing',
      cwd: 'C:\\src\\repo',
      activity: 'working',
      cloudTaskId: 'task-live',
      pid: 111,
      startedAt: '2026-03-01T10:00:00.000Z',
    });
    expect([...result.mirroredTaskIds].sort()).toEqual(['task-dead', 'task-live']);
  });

  it('skips session dirs older than the recent window', async () => {
    const dir = writeCopilotSession('old', { pid: 111, yaml: 'id: old\nmc_task_id: task-old\n' });
    const old = new Date(NOW - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    const result = await discoverCopilotLocalSessions({ homeDir: home, isPidAlive: () => true, getProcessStartTimes: startedLongAgo, now: () => NOW });
    expect(result.sessions).toHaveLength(0);
    expect(result.mirroredTaskIds.size).toBe(0);
  });

  it('rejects locks whose pid now belongs to a process started after the lock was written (pid reuse)', async () => {
    const lockedAt = new Date(NOW - 60 * 60 * 1000);
    const stale = writeCopilotSession('stale', { pid: 111, yaml: 'id: stale\n' });
    fs.utimesSync(path.join(stale, 'inuse.111.lock'), lockedAt, lockedAt);
    const live = writeCopilotSession('live', { pid: 222, yaml: 'id: live\n' });
    fs.utimesSync(path.join(live, 'inuse.222.lock'), lockedAt, lockedAt);
    writeCopilotSession('hidden', { pid: 333, yaml: 'id: hidden\n' });

    const requested: number[][] = [];
    const result = await discoverCopilotLocalSessions({
      homeDir: home,
      isPidAlive: () => true,
      now: () => NOW,
      getProcessStartTimes: async (pids) => {
        requested.push([...pids].sort());
        // 111 was reused by a process started long after the lock; 333 can't be inspected.
        return new Map([[111, lockedAt.getTime() + 30 * 60 * 1000], [222, lockedAt.getTime() - 4000]]);
      },
    });

    expect(requested).toEqual([[111, 222, 333]]);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['live']);
  });

  it('trusts the liveness check when process start times are unavailable', async () => {
    writeCopilotSession('a', { pid: 111, yaml: 'id: a\n' });
    const viaNull = await discoverCopilotLocalSessions({ homeDir: home, isPidAlive: () => true, now: () => NOW, getProcessStartTimes: async () => null });
    const viaThrow = await discoverCopilotLocalSessions({
      homeDir: home, isPidAlive: () => true, now: () => NOW,
      getProcessStartTimes: async () => { throw new Error('powershell missing'); },
    });
    expect(viaNull.sessions).toHaveLength(1);
    expect(viaThrow.sessions).toHaveLength(1);
  });

  it('sees a pending permission prompt whose event is larger than the initial tail window', async () => {
    writeCopilotSession('big', {
      pid: 111,
      yaml: 'id: big\n',
      events: [
        ev('tool.execution_start', 3000, { toolName: 'edit', toolCallId: 't1' }),
        ev('permission.requested', 2000, { requestId: 'p1', diff: 'x'.repeat(200 * 1024) }),
      ],
    });
    const result = await discoverCopilotLocalSessions({ homeDir: home, isPidAlive: () => true, getProcessStartTimes: startedLongAgo, now: () => NOW });
    expect(result.sessions[0]?.activity).toBe('waiting_for_user');
  });

  it('returns nothing when the Copilot session-state folder does not exist', async () => {
    expect((await discoverCopilotLocalSessions({ homeDir: home })).sessions).toEqual([]);
    expect(await discoverClaudeLocalSessions({ homeDir: home })).toEqual([]);
  });

  it('lists live Claude Code sessions with activity and title from the transcript', async () => {
    const cwd = 'C:\\src\\claude-repo';
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '333.json'), JSON.stringify({
      pid: 333, sessionId: 'sess-1', cwd, startedAt: NOW - 60_000, updatedAt: NOW - 1000,
    }));
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '444.json'), JSON.stringify({ pid: 444, sessionId: 'sess-dead', cwd }));
    const projectDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'sess-1.jsonl'), [
      JSON.stringify({ type: 'summary', summary: 'Refactor the parser' }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } }),
    ].join('\n'));

    const sessions = await discoverClaudeLocalSessions({ homeDir: home, isPidAlive: (pid) => pid === 333, getProcessStartTimes: startedLongAgo, now: () => Date.now() });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      key: 'local:claude:sess-1',
      provider: 'claude',
      client: 'Claude Code',
      title: 'Refactor the parser',
      cwd,
      activity: 'working',
      pid: 333,
    });
  });

  it('rejects a Claude pid file whose pid was reused by a newer process', async () => {
    const sessionsDir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, '555.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 555, sessionId: 'crashed', cwd: null }));
    const writtenAt = new Date(NOW - 2 * 60 * 60 * 1000);
    fs.utimesSync(file, writtenAt, writtenAt);

    const sessions = await discoverClaudeLocalSessions({
      homeDir: home,
      isPidAlive: () => true,
      getProcessStartTimes: async () => new Map([[555, NOW]]),
      now: () => NOW,
    });
    expect(sessions).toEqual([]);
  });
});

describe('readTail', () => {
  it('widens the tail window until the entries are conclusive', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tail-'));
    try {
      const file = path.join(dir, 'events.jsonl');
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'first' }),
        JSON.stringify({ type: 'big', pad: 'x'.repeat(3000) }),
      ].join('\n') + '\n');
      const windows: number[] = [];
      const entries = readTailEntries(file, (es) => {
        windows.push(es.length);
        return es.some((e) => e.type === 'first');
      }, [100, 1000, 10_000]);
      expect(entries.map((e) => e.type)).toEqual(['first', 'big']);
      // The 100- and 1000-byte windows only see part of the big line; the last one reads the whole file.
      expect(windows).toEqual([0, 0]);
      expect(readTailEntries(path.join(dir, 'missing.jsonl'), () => true)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns only complete lines from the end of a large file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tail-'));
    try {
      const file = path.join(dir, 'events.jsonl');
      const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(20) }));
      fs.writeFileSync(file, lines.join('\n') + '\n');
      const tail = readTail(file, 500)!;
      const parsed = tail.trim().split('\n').map((l) => JSON.parse(l) as { i: number });
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[parsed.length - 1].i).toBe(199);
      expect(readTail(path.join(dir, 'missing.jsonl'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
