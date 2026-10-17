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
//       events.jsonl       append-only event log (tail read for activity; read
//                          incrementally for the PR link — these reach 100+ MB)
//   Claude Code:
//     ~/.claude/sessions/<pid>.json          { pid, sessionId, cwd, startedAt, updatedAt }
//     ~/.claude/projects/<enc-cwd>/<id>.jsonl transcript (tail read for activity)

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ActiveAgentSession, AgentActivity } from '../plugins/types';
import { logger } from './logger';

export interface LocalSessionDiscoveryOptions {
  homeDir?: string;
  isPidAlive?: (pid: number) => boolean;
  /** Start times (epoch ms) of running processes; null when the lookup is unavailable. */
  getProcessStartTimes?: (pids: number[]) => Promise<Map<number, number> | null>;
  now?: () => number;
  /** Session-state dirs untouched for longer than this are not inspected. */
  recentWindowMs?: number;
  /** Session-state dirs touched within this window are read for their mirrored cloud task id. */
  mirrorWindowMs?: number;
}

const DEFAULT_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_MIRROR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
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

async function mtimeOfAsync(filePath: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
   * Cloud task id → client label (e.g. "Copilot app") of *every* recent local
   * session, running or not. Local Copilot app sessions are mirrored to the
   * agent tasks API, so these tasks must not be presented as cloud-agent work.
   */
  mirroredTasks: Map<string, string>;
}

export async function discoverCopilotLocalSessions(options: LocalSessionDiscoveryOptions = {}): Promise<CopilotLocalDiscovery> {
  const home = options.homeDir ?? os.homedir();
  const alive = options.isPidAlive ?? isPidAlive;
  const now = options.now?.() ?? Date.now();
  const cutoff = now - (options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);
  const mirrorCutoff = Math.min(cutoff, now - (options.mirrorWindowMs ?? DEFAULT_MIRROR_WINDOW_MS));
  const root = path.join(home, '.copilot', 'session-state');

  const sessions: ActiveAgentSession[] = [];
  const mirroredTasks = new Map<string, string>();

  const t0 = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { sessions, mirroredTasks };
  }

  // Thousands of session dirs accumulate here. Every lookup is async (off the
  // main thread), and a dir already known to be older than the mirror window is
  // re-checked only every few minutes — resuming it touches the dir again.
  const seen = new Set<string>();
  let statted = 0;
  const held: Array<{ dirName: string; dir: string; files: string[]; ws: Record<string, string>; locks: LockCandidate[] }> = [];
  await forEachLimit(entries.filter((e) => e.isDirectory()), FS_CONCURRENCY, async (entry) => {
    const dir = path.join(root, entry.name);
    seen.add(dir);
    const cached = sessionDirCache.get(dir);
    if (cached && cached.mtimeMs < mirrorCutoff && now - cached.checkedAt < STALE_DIR_RECHECK_MS) return;
    let files: string[];
    let mtimeMs: number;
    try {
      statted++;
      mtimeMs = (await fs.promises.stat(dir)).mtimeMs;
      if (mtimeMs < mirrorCutoff) {
        sessionDirCache.set(dir, { mtimeMs, checkedAt: now, ws: null });
        return;
      }
      files = await fs.promises.readdir(dir);
    } catch {
      sessionDirCache.delete(dir);
      return;
    }

    const ws = files.includes('workspace.yaml') ? await readWorkspace(path.join(dir, 'workspace.yaml'), cached?.ws ?? null) : null;
    sessionDirCache.set(dir, { mtimeMs, checkedAt: now, ws });
    const fields = ws?.fields ?? {};
    if (fields.mc_task_id) mirroredTasks.set(fields.mc_task_id, clientLabel(fields.client_name));
    if (mtimeMs < cutoff) return;

    const locks: LockCandidate[] = [];
    for (const file of files) {
      const pid = Number(file.match(/^inuse\.(\d+)\.lock$/)?.[1]);
      if (!pid || !alive(pid)) continue;
      locks.push({ pid, writtenAtMs: await mtimeOfAsync(path.join(dir, file)) });
    }
    if (locks.length > 0) held.push({ dirName: entry.name, dir, files, ws: fields, locks });
  });
  for (const dir of sessionDirCache.keys()) if (!seen.has(dir)) sessionDirCache.delete(dir);
  held.sort((a, b) => a.dirName.localeCompare(b.dirName));
  const tDirs = Date.now();

  const ownsLock = await lockOwnerVerifier(held.flatMap((h) => h.locks), options);
  const tLocks = Date.now();

  let tailMs = 0;
  let prMs = 0;
  const liveFiles = new Set<string>();
  for (const { dirName, dir, files, ws, locks } of held) {
    const pid = locks.find(ownsLock)?.pid;
    if (pid === undefined) continue;

    const eventsPath = files.includes('events.jsonl') ? path.join(dir, 'events.jsonl') : null;
    let t = Date.now();
    const events = eventsPath
      ? readTailEntries(eventsPath, (evs) => deriveCopilotActivity(evs, now) !== 'unknown')
      : [];
    tailMs += Date.now() - t;
    t = Date.now();
    if (eventsPath) liveFiles.add(eventsPath);
    const linkedPr = eventsPath ? await copilotPrScanner.find(eventsPath) : null;
    prMs += Date.now() - t;
    const sessionId = ws.id || dirName;
    const eventsMtime = eventsPath ? await mtimeOfAsync(eventsPath) : null;
    const wsUpdated = toIso(ws.updated_at);
    const updatedAt = eventsMtime !== null && eventsMtime > (Date.parse(wsUpdated ?? '') || 0)
      ? new Date(eventsMtime).toISOString()
      : wsUpdated;

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
      updatedAt,
      cloudTaskId: ws.mc_task_id || null,
      pid,
      linkedPr,
      sessionFile: eventsPath,
    });
  }
  copilotPrScanner.retain(liveFiles);

  logger.debug(
    `[ActiveSessions] Copilot discovery: ${entries.length} dir(s), ${statted} stat'd, ${held.length} locked, ${sessions.length} live — `
    + `dirs ${tDirs - t0}ms, lock check ${tLocks - tDirs}ms, event tails ${tailMs}ms, PR scan ${prMs}ms, total ${Date.now() - t0}ms`,
  );
  return { sessions, mirroredTasks };
}

/** Parallel fs calls while walking the session-state dirs. */
const FS_CONCURRENCY = 32;
/** How long a session dir older than the mirror window is trusted to stay old before it is stat'd again. */
const STALE_DIR_RECHECK_MS = 10 * 60 * 1000;

interface CachedWorkspace {
  mtimeMs: number;
  fields: Record<string, string>;
}

/** Last stat of each session dir, so old dirs are not stat'd every sweep. */
const sessionDirCache = new Map<string, { mtimeMs: number; checkedAt: number; ws: CachedWorkspace | null }>();

async function readWorkspace(yamlPath: string, cached: CachedWorkspace | null): Promise<CachedWorkspace | null> {
  try {
    const { mtimeMs } = await fs.promises.stat(yamlPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    return { mtimeMs, fields: parseWorkspaceYaml(await fs.promises.readFile(yamlPath, 'utf-8')) };
  } catch {
    return null;
  }
}

type LinkedPr = ActiveAgentSession['linkedPr'];

/** Folds JSONL lines, one at a time, into the latest PR link they report. */
interface PrLinkReader {
  readLine(line: string): void;
  readonly pr: LinkedPr;
}

/**
 * Latest PR a Copilot session created: the output of a successful `gh pr create`
 * shell call is the new PR's URL on its own line. Other PR URLs in the log
 * (reviews, comments on someone else's PR) are deliberately ignored.
 */
function copilotPrLinkReader(): PrLinkReader {
  const createCalls = new Set<string>();
  let found: LinkedPr = null;
  return {
    get pr() { return found; },
    readLine(line) {
      const isStart = line.includes('gh pr create');
      const isComplete = !isStart && line.includes('/pull/') && createCalls.size > 0;
      if (!isStart && !isComplete) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const data = (ev.data ?? {}) as Record<string, unknown>;
      const id = data.toolCallId;
      if (typeof id !== 'string') return;
      if (ev.type === 'tool.execution_start') {
        const command = (data.arguments as Record<string, unknown> | undefined)?.command;
        if (typeof command === 'string' && /\bgh\s+pr\s+create\b/.test(command)) createCalls.add(id);
      } else if (ev.type === 'tool.execution_complete' && createCalls.has(id) && data.success !== false) {
        createCalls.delete(id);
        const content = (data.result as Record<string, unknown> | undefined)?.content;
        const m = typeof content === 'string'
          ? content.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\s*$/m)
          : null;
        if (m) found = { repoFullName: m[1], number: Number(m[2]) };
      }
    },
  };
}

/** Latest PR a Claude Code session reported via a `pr-link` transcript entry. */
function claudePrLinkReader(): PrLinkReader {
  let found: LinkedPr = null;
  return {
    get pr() { return found; },
    readLine(line) {
      if (!line.includes('"pr-link"')) return;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e.type === 'pr-link' && typeof e.prNumber === 'number' && typeof e.prRepository === 'string') {
          found = { repoFullName: e.prRepository, number: e.prNumber };
        }
      } catch {
        // partial line — skip
      }
    },
  };
}

function readAllLines(reader: PrLinkReader, text: string): LinkedPr {
  for (const line of text.split('\n')) reader.readLine(line);
  return reader.pr;
}

/** Exported for tests. */
export function findCopilotPrLinkInText(text: string): LinkedPr {
  return readAllLines(copilotPrLinkReader(), text);
}

/** Exported for tests. */
export function findPrLinkInText(text: string): LinkedPr {
  return readAllLines(claudePrLinkReader(), text);
}

const SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * Finds the latest PR link in append-only JSONL logs that can grow to 100+ MB
 * while a session runs. Each file is read once, in chunks with async reads, and
 * on later calls only the bytes appended since — so a sweep never re-reads or
 * re-parses a whole log on the main thread. Exported for tests.
 */
export class IncrementalPrLinkScanner {
  private readonly files = new Map<string, { offset: number; size: number; mtimeMs: number; reader: PrLinkReader }>();

  constructor(private readonly createReader: () => PrLinkReader) {}

  async find(filePath: string): Promise<LinkedPr> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, 'r');
      const { size, mtimeMs } = await handle.stat();
      let state = this.files.get(filePath);
      if (state && state.size === size && state.mtimeMs === mtimeMs) return state.reader.pr;
      // Smaller than what was read already: the file was replaced — start over.
      if (!state || size < state.offset) state = { offset: 0, size: 0, mtimeMs: 0, reader: this.createReader() };
      this.files.set(filePath, state);

      let carry = Buffer.alloc(0);
      let position = state.offset;
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const buf = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const lastNewline = buf.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          carry = buf;
          continue;
        }
        // Only whole lines are consumed; a line still being written is re-read next time.
        for (const line of buf.subarray(0, lastNewline).toString('utf-8').split('\n')) state.reader.readLine(line);
        state.offset += lastNewline + 1;
        carry = buf.subarray(lastNewline + 1);
      }
      state.size = size;
      state.mtimeMs = mtimeMs;
      return state.reader.pr;
    } catch {
      this.files.delete(filePath);
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Forget files that are no longer of interest (their session ended). */
  retain(filePaths: ReadonlySet<string>): void {
    for (const filePath of this.files.keys()) if (!filePaths.has(filePath)) this.files.delete(filePath);
  }
}

const copilotPrScanner = new IncrementalPrLinkScanner(copilotPrLinkReader);
const claudePrScanner = new IncrementalPrLinkScanner(claudePrLinkReader);

/** Exposed for tests. */
export function resetLocalSessionCaches(): void {
  sessionDirCache.clear();
  copilotPrScanner.retain(new Set());
  claudePrScanner.retain(new Set());
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

/**
 * Transcript entries that carry a session title, best first: the user's/desktop
 * app's rename (`custom-title`), the agent name the app assigns, Claude Code's
 * generated `ai-title`, and the legacy `summary` entry.
 */
const CLAUDE_TITLE_ENTRIES: Array<[type: string, field: string]> = [
  ['custom-title', 'customTitle'],
  ['agent-name', 'agentName'],
  ['ai-title', 'aiTitle'],
  ['summary', 'summary'],
];

function isClaudeTitleEntry(e: Record<string, unknown>): boolean {
  return CLAUDE_TITLE_ENTRIES.some(([type, field]) => e.type === type && typeof e[field] === 'string' && e[field] !== '');
}

/**
 * Pull a human-readable title out of a Claude Code transcript: the latest title
 * entry if one exists, otherwise the first real user prompt (truncated).
 * Exported for tests.
 */
export function extractClaudeTitle(entries: Array<Record<string, unknown>>): string | null {
  for (const [type, field] of CLAUDE_TITLE_ENTRIES) {
    const hit = [...entries].reverse().find((e) => e.type === type && typeof e[field] === 'string' && e[field] !== '');
    if (hit) return String(hit[field]).trim();
  }

  for (const e of entries) {
    if (e.type !== 'user') continue;
    const message = (e.message ?? {}) as Record<string, unknown>;
    const content = message.content;
    const texts: string[] = [];
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const c of content) {
        const block = (c ?? {}) as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    }
    for (const raw of texts) {
      // Drop injected <system-reminder> blocks, which often lead the first prompt.
      const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().replace(/\s+/g, ' ');
      // Skip command/tool-result scaffolding ("<command-...>"), pasted-attachment
      // placeholders ("[Image: ...]", "[Request interrupted...]") and messages
      // relayed from another session — none of them is a title.
      if (!text || text.startsWith('<') || /^\[[^\]]*\]/.test(text) || text.startsWith('Another Claude session sent a message')) continue;
      return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    }
  }
  return null;
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
  const t0 = Date.now();

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

  const tFiles = Date.now();
  const ownsLock = await lockOwnerVerifier(candidates.map((c) => c.lock), options);
  const tLocks = Date.now();

  let tailMs = 0;
  let prMs = 0;
  const liveTranscripts = new Set<string>();
  const sessions: ActiveAgentSession[] = [];
  for (const { meta, lock } of candidates) {
    if (!ownsLock(lock)) continue;
    const pid = lock.pid;
    const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : String(pid);
    const cwd = typeof meta.cwd === 'string' ? meta.cwd : null;

    let activity: AgentActivity = 'unknown';
    let title: string | null = null;
    let linkedPr: ActiveAgentSession['linkedPr'] = null;
    let lastActiveMs: number | null = null;
    let sessionFile: string | null = null;
    if (cwd) {
      const transcript = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
      const mtime = mtimeOf(transcript);
      if (mtime !== null) {
        // A title entry isn't necessarily near the tail — widen the read until
        // one turns up, not just until there's enough to tell activity, or
        // titles fall back to the first prompt.
        let t = Date.now();
        const entries = readTailEntries(
          transcript,
          (es) => es.some((e) => e.type === 'assistant' || e.type === 'user') && es.some(isClaudeTitleEntry),
        );
        tailMs += Date.now() - t;
        activity = deriveClaudeActivity(entries, mtime, now);
        title = extractClaudeTitle(entries);
        lastActiveMs = mtime;
        // pr-link entries can sit anywhere in the transcript; the scanner reads
        // each transcript once and then only what was appended.
        t = Date.now();
        linkedPr = await claudePrScanner.find(transcript);
        prMs += Date.now() - t;
        liveTranscripts.add(transcript);
        sessionFile = transcript;
      }
    }
    // sessions/<pid>.json is only rewritten on some state changes; the transcript mtime is the real last write.
    const metaUpdated = toIso(meta.updatedAt as string | number | undefined);
    const updatedAt = lastActiveMs !== null && lastActiveMs > (Date.parse(metaUpdated ?? '') || 0)
      ? new Date(lastActiveMs).toISOString()
      : metaUpdated;

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
      updatedAt,
      cloudTaskId: null,
      pid,
      linkedPr,
      sessionFile,
    });
  }
  claudePrScanner.retain(liveTranscripts);

  logger.debug(
    `[ActiveSessions] Claude discovery: ${files.length} pid file(s), ${candidates.length} alive, ${sessions.length} live — `
    + `pid files ${tFiles - t0}ms, lock check ${tLocks - tFiles}ms, transcript tails ${tailMs}ms, PR scan ${prMs}ms, total ${Date.now() - t0}ms`,
  );
  return sessions;
}
