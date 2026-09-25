// ── Local AI agent session discovery ──────────────────────────────────────────
// Finds AI coding sessions that are *currently running* on this machine.
//
// The on-disk stores read here are the same ones the ai-engineering-fluency
// project (github.com/rajbos/ai-engineering-fluency, MIT) reads for its usage
// analytics. Its npm package is CLI-only and reports aggregate stats without
// per-session liveness, so Jarvis reads the stores directly for now; swap this
// module for its output once it exposes a per-session listing.
//
//   GitHub Copilot CLI / Copilot app:
//     ~/.copilot/session-state/<id>/
//       inuse.<pid>.lock   present while a process holds the session open
//       workspace.yaml     id, cwd, name, client_name, mc_task_id, timestamps
//       events.jsonl       append-only event log (tail read for activity)
//   Claude Code:
//     ~/.claude/sessions/<pid>.json          { pid, sessionId, cwd, startedAt, updatedAt }
//     ~/.claude/projects/<enc-cwd>/<id>.jsonl transcript (tail read for activity)

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ActiveAgentSession, AgentActivity } from '../plugins/types';

export interface LocalSessionDiscoveryOptions {
  homeDir?: string;
  isPidAlive?: (pid: number) => boolean;
  /** Start times (epoch ms) of running processes; null when the lookup is unavailable. */
  getProcessStartTimes?: (pids: number[]) => Promise<Map<number, number> | null>;
  now?: () => number;
  /** Session-state dirs untouched for longer than this are not inspected. */
  recentWindowMs?: number;
}

const DEFAULT_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;
/** Tail windows tried in turn — single events (e.g. permission prompts with a full diff) can be hundreds of KB. */
const TAIL_WINDOWS = [TAIL_BYTES, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
/** A turn that ended this recently is treated as "between turns" (autopilot), not idle. */
const TURN_GAP_GRACE_MS = 20_000;
/** A Claude transcript untouched this long is considered idle. */
const CLAUDE_IDLE_AFTER_MS = 2 * 60 * 1000;
/** Tolerance between a process starting and it writing its lock file. */
const PID_START_SLACK_MS = 5_000;

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Start time (epoch ms) of each running process in `pids`. Processes that have
 * exited or can't be inspected (another user / elevated) are absent from the
 * map. Resolves null when the lookup itself is unavailable.
 */
export function getProcessStartTimes(pids: number[]): Promise<Map<number, number> | null> {
  const ids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (ids.length === 0) return Promise.resolve(new Map());
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch {} }`,
    ]]
    : ['ps', ['-o', 'pid=,lstart=', '-p', ids.join(',')]];

  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      // A non-zero exit just means some pids weren't found; spawn failures and timeouts mean "unavailable".
      const failure = err as { code?: unknown; killed?: boolean } | null;
      if (failure && (typeof failure.code !== 'number' || failure.killed)) {
        resolve(null);
        return;
      }
      const starts = new Map<number, number>();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
        if (!m) continue;
        const startedAt = /^\d+$/.test(m[2]) ? Number(m[2]) : Date.parse(m[2]);
        if (Number.isFinite(startedAt)) starts.set(Number(m[1]), startedAt);
      }
      resolve(starts);
    });
  });
}

interface LockCandidate {
  pid: number;
  /** mtime of the lock / pid file the process wrote. */
  writtenAtMs: number | null;
}

/**
 * Lock files outlive crashed sessions and Windows reuses pids quickly, so a
 * live pid alone doesn't prove the session is running: the process must also
 * have started before it wrote the lock.
 */
async function lockOwnerVerifier(
  candidates: LockCandidate[],
  options: LocalSessionDiscoveryOptions,
): Promise<(candidate: LockCandidate) => boolean> {
  if (candidates.length === 0) return () => false;
  let starts: Map<number, number> | null;
  try {
    starts = await (options.getProcessStartTimes ?? getProcessStartTimes)(candidates.map((c) => c.pid));
  } catch {
    starts = null;
  }
  if (!starts) return () => true; // can't verify — trust the liveness check
  const known = starts;
  return (candidate) => {
    const startedAt = known.get(candidate.pid);
    if (startedAt === undefined) return false;
    return candidate.writtenAtMs === null || startedAt <= candidate.writtenAtMs + PID_START_SLACK_MS;
  };
}

function mtimeOf(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/** Read the last `maxBytes` of a file without loading it all (events logs can be tens of MB). */
export function readTail(filePath: string, maxBytes = TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(maxBytes, size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    let text = buf.toString('utf-8');
    // Drop the (probably partial) first line when we didn't start at offset 0.
    if (length < size) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch {
      // partial or corrupt line — skip
    }
  }
  return out;
}

/**
 * Parse the tail of a JSONL log, widening the window until `isConclusive`
 * accepts the entries or the whole file has been read.
 */
export function readTailEntries(
  filePath: string,
  isConclusive: (entries: Array<Record<string, unknown>>) => boolean,
  windows: number[] = TAIL_WINDOWS,
): Array<Record<string, unknown>> {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return [];
  }
  let entries: Array<Record<string, unknown>> = [];
  for (const window of windows) {
    const text = readTail(filePath, window);
    if (text === null) break;
    entries = parseJsonLines(text);
    if (window >= size || isConclusive(entries)) break;
  }
  return entries;
}

/** Parse the flat `key: value` workspace.yaml written by the Copilot CLI. */
export function parseWorkspaceYaml(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      const quote = value[0];
      value = value.slice(1, -1);
      value = quote === '"'
        ? value.replace(/\\(["\\])/g, '$1')
        : value.replace(/''/g, "'");
    }
    out[m[1]] = value;
  }
  return out;
}

function clientLabel(clientName: string | undefined): string {
  switch (clientName) {
    case 'github/autopilot': return 'Copilot app';
    case 'github/cli': return 'Copilot CLI';
    default: return clientName ? `Copilot (${clientName})` : 'Copilot CLI';
  }
}

function eventTime(ev: Record<string, unknown>): number | null {
  const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Derive what a Copilot CLI session is doing from the tail of its events log.
 * Exported for tests.
 */
export function deriveCopilotActivity(events: Array<Record<string, unknown>>, now: number): AgentActivity {
  if (events.length === 0) return 'unknown';

  // Outstanding permission prompts / ask_user calls mean the agent is blocked on the user.
  const openPermissions = new Set<string>();
  const openAskUser = new Set<string>();
  for (const ev of events) {
    const data = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case 'permission.requested':
        if (typeof data.requestId === 'string') openPermissions.add(data.requestId);
        break;
      case 'permission.completed':
        if (typeof data.requestId === 'string') openPermissions.delete(data.requestId);
        break;
      case 'tool.execution_start':
        if (data.toolName === 'ask_user' && typeof data.toolCallId === 'string') openAskUser.add(data.toolCallId);
        break;
      case 'tool.execution_complete':
        if (typeof data.toolCallId === 'string') openAskUser.delete(data.toolCallId);
        break;
      default:
        break;
    }
  }
  if (openPermissions.size > 0 || openAskUser.size > 0) return 'waiting_for_user';

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const type = typeof ev.type === 'string' ? ev.type : '';
    if (type === 'session.task_complete' || type === 'session.shutdown') return 'idle';
    if (type === 'session.start' || type === 'session.resume') return 'idle';
    if (type.startsWith('session.compaction')) return 'working';
    if (type === 'assistant.turn_end') {
      const at = eventTime(ev);
      return at !== null && now - at < TURN_GAP_GRACE_MS ? 'working' : 'idle';
    }
    if (
      type === 'assistant.turn_start' ||
      type === 'user.message' ||
      type.startsWith('tool.') ||
      type.startsWith('model.') ||
      type.startsWith('assistant.') ||
      type.startsWith('permission.')
    ) {
      return 'working';
    }
    // hook.*, session.usage_checkpoint, session.binary_asset, … carry no state
  }
  return 'unknown';
}

function toIso(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(typeof value === 'number' ? value : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface CopilotLocalDiscovery {
  /** Sessions with a live process holding them open. */
  sessions: ActiveAgentSession[];
  /**
   * Cloud task ids of *every* recent local session (running or not). Local
   * Copilot app sessions are mirrored to the agent tasks API, so these ids
   * must be excluded when listing genuine cloud sessions.
   */
  mirroredTaskIds: Set<string>;
}

export async function discoverCopilotLocalSessions(options: LocalSessionDiscoveryOptions = {}): Promise<CopilotLocalDiscovery> {
  const home = options.homeDir ?? os.homedir();
  const alive = options.isPidAlive ?? isPidAlive;
  const now = options.now?.() ?? Date.now();
  const cutoff = now - (options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);
  const root = path.join(home, '.copilot', 'session-state');

  const sessions: ActiveAgentSession[] = [];
  const mirroredTaskIds = new Set<string>();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { sessions, mirroredTaskIds };
  }

  const held: Array<{ dirName: string; dir: string; files: string[]; ws: Record<string, string>; locks: LockCandidate[] }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files: string[];
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) continue;
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }

    const yamlText = files.includes('workspace.yaml') ? readFileText(path.join(dir, 'workspace.yaml')) : null;
    const ws = yamlText ? parseWorkspaceYaml(yamlText) : {};
    if (ws.mc_task_id) mirroredTaskIds.add(ws.mc_task_id);

    const locks = files
      .map((f) => ({ file: f, pid: f.match(/^inuse\.(\d+)\.lock$/)?.[1] }))
      .filter((l): l is { file: string; pid: string } => l.pid !== undefined)
      .map((l) => ({ pid: Number(l.pid), writtenAtMs: mtimeOf(path.join(dir, l.file)) }))
      .filter((l) => alive(l.pid));
    if (locks.length > 0) held.push({ dirName: entry.name, dir, files, ws, locks });
  }

  const ownsLock = await lockOwnerVerifier(held.flatMap((h) => h.locks), options);

  for (const { dirName, dir, files, ws, locks } of held) {
    const pid = locks.find(ownsLock)?.pid;
    if (pid === undefined) continue;

    const events = files.includes('events.jsonl')
      ? readTailEntries(path.join(dir, 'events.jsonl'), (evs) => deriveCopilotActivity(evs, now) !== 'unknown')
      : [];
    const sessionId = ws.id || dirName;

    sessions.push({
      key: `local:copilot:${sessionId}`,
      provider: 'copilot',
      origin: 'local',
      client: clientLabel(ws.client_name),
      sessionId,
      title: ws.name || null,
      cwd: ws.cwd || null,
      repoFullName: null,
      branch: null,
      activity: deriveCopilotActivity(events, now),
      startedAt: toIso(ws.created_at),
      updatedAt: toIso(ws.updated_at),
      cloudTaskId: ws.mc_task_id || null,
      pid,
    });
  }

  return { sessions, mirroredTaskIds };
}

function readFileText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Claude Code stores transcripts under the cwd with every non-alphanumeric char replaced by '-'. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Exported for tests. */
export function deriveClaudeActivity(
  entries: Array<Record<string, unknown>>,
  lastModifiedMs: number | null,
  now: number,
): AgentActivity {
  const last = [...entries].reverse().find((e) => e.type === 'assistant' || e.type === 'user');
  if (!last) return 'unknown';
  if (lastModifiedMs !== null && now - lastModifiedMs > CLAUDE_IDLE_AFTER_MS) return 'idle';
  if (last.type === 'assistant') {
    const message = (last.message ?? {}) as Record<string, unknown>;
    if (message.stop_reason === 'end_turn') return 'idle';
  }
  return 'working';
}

export async function discoverClaudeLocalSessions(options: LocalSessionDiscoveryOptions = {}): Promise<ActiveAgentSession[]> {
  const home = options.homeDir ?? os.homedir();
  const alive = options.isPidAlive ?? isPidAlive;
  const now = options.now?.() ?? Date.now();
  const sessionsDir = path.join(home, '.claude', 'sessions');

  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const candidates: Array<{ meta: Record<string, unknown>; lock: LockCandidate }> = [];
  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    const raw = readFileText(filePath);
    if (!raw) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pid = typeof meta.pid === 'number' ? meta.pid : Number(path.basename(file, '.json'));
    if (!alive(pid)) continue;
    candidates.push({ meta, lock: { pid, writtenAtMs: mtimeOf(filePath) } });
  }

  const ownsLock = await lockOwnerVerifier(candidates.map((c) => c.lock), options);

  const sessions: ActiveAgentSession[] = [];
  for (const { meta, lock } of candidates) {
    if (!ownsLock(lock)) continue;
    const pid = lock.pid;
    const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : String(pid);
    const cwd = typeof meta.cwd === 'string' ? meta.cwd : null;

    let activity: AgentActivity = 'unknown';
    let title: string | null = null;
    if (cwd) {
      const transcript = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
      const mtime = mtimeOf(transcript);
      if (mtime !== null) {
        const entries = readTailEntries(transcript, (es) => es.some((e) => e.type === 'assistant' || e.type === 'user'));
        activity = deriveClaudeActivity(entries, mtime, now);
        const summary = [...entries].reverse().find((e) => e.type === 'summary' && typeof e.summary === 'string');
        title = summary ? String(summary.summary) : null;
      }
    }

    sessions.push({
      key: `local:claude:${sessionId}`,
      provider: 'claude',
      origin: 'local',
      client: 'Claude Code',
      sessionId,
      title,
      cwd,
      repoFullName: null,
      branch: null,
      activity,
      startedAt: toIso(meta.startedAt as string | number | undefined),
      updatedAt: toIso(meta.updatedAt as string | number | undefined),
      cloudTaskId: null,
      pid,
    });
  }
  return sessions;
}
