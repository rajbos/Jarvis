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
import fs, { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { ActiveAgentSession, AgentActivity } from '../plugins/types';
import { PhaseTimer } from './phase-timer';

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
  /** Collects per-phase timings for the sweep's debug log. */
  timer?: PhaseTimer;
}

const DEFAULT_RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_MIRROR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;
/** Session-state dirs stat'ed / read at once. */
const SCAN_CONCURRENCY = 32;
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

async function mtimeOf(filePath: string): Promise<number | null> {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function readFileText(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Map `items` through `fn` with at most `limit` calls in flight, keeping order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Read the last `maxBytes` of a file without loading it all (events logs can be
 * tens of MB). Async, so a slow disk or a virus scanner holding the file never
 * blocks the main thread.
 */
export async function readTail(filePath: string, maxBytes = TAIL_BYTES): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const { size } = await handle.stat();
    const length = Math.min(maxBytes, size);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
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
    await handle?.close().catch(() => undefined);
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
export async function readTailEntries(
  filePath: string,
  isConclusive: (entries: Array<Record<string, unknown>>) => boolean,
  windows: number[] = TAIL_WINDOWS,
): Promise<Array<Record<string, unknown>>> {
  let size: number;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch {
    return [];
  }
  let entries: Array<Record<string, unknown>> = [];
  for (const window of windows) {
    const text = await readTail(filePath, window);
    if (text === null) break;
    entries = parseJsonLines(text);
    if (window >= size || isConclusive(entries)) break;
  }
  return entries;
}

// ── Incremental line scans ────────────────────────────────────────────────────
// Session logs only grow, and a live one grows on every sweep, so a full re-read
// each time (up to 100+ MB) would block the main thread for seconds. Scans keep
// their position and state per file and only read the bytes appended since.

/** Bytes read per step; each step is one await, so the event loop runs in between. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

export interface LineScan<S> {
  /** Bytes consumed so far (always just past a newline). */
  offset: number;
  /** Bytes after the last newline, waiting for the rest of their line. */
  carry: Buffer;
  state: S;
}

/**
 * Feed every complete line of `filePath` that `cache` hasn't seen yet to
 * `onLine`, then return the accumulated state. A file that shrank (rewritten or
 * replaced) is scanned again from the start. Null when the file can't be read.
 * Exported for tests.
 */
export async function scanNewLines<S>(
  filePath: string,
  cache: Map<string, LineScan<S>>,
  initial: () => S,
  onLine: (line: string, state: S) => void,
  chunkBytes = SCAN_CHUNK_BYTES,
): Promise<S | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const { size } = await handle.stat();
    let scan = cache.get(filePath);
    if (!scan || size < scan.offset + scan.carry.length) scan = { offset: 0, carry: Buffer.alloc(0), state: initial() };
    let position = scan.offset + scan.carry.length;
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(chunkBytes, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = scan.carry.length > 0 ? Buffer.concat([scan.carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      // A newline byte never occurs inside a multi-byte UTF-8 sequence, so whole lines decode safely.
      const nl = data.lastIndexOf(0x0a);
      if (nl < 0) {
        scan.carry = data;
        continue;
      }
      for (const line of data.toString('utf-8', 0, nl).split('\n')) onLine(line, scan.state);
      scan.offset += nl + 1;
      scan.carry = Buffer.from(data.subarray(nl + 1));
    }
    // A final line without a newline yet: take it once it is complete JSON.
    if (scan.carry.length > 0) {
      const tail = scan.carry.toString('utf-8');
      if (isCompleteJson(tail)) {
        onLine(tail, scan.state);
        scan.offset += scan.carry.length;
        scan.carry = Buffer.alloc(0);
      }
    }
    cache.set(filePath, scan);
    return scan.state;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Drop scan state for files that weren't looked at this sweep (sessions that ended). */
function pruneScans(cache: Map<string, unknown>, seen: ReadonlySet<string>): void {
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
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

/**
 * What a session-state dir held at a given dir mtime. Creating or deleting a
 * file (a lock, events.jsonl) bumps the dir mtime, so an unchanged mtime means
 * the listing and the (write-once) cloud task id are still current — thousands
 * of old dirs then cost one stat each instead of a readdir and a file read.
 */
interface SessionDirInfo {
  mtimeMs: number;
  files: string[];
  ws: Record<string, string>;
}

const sessionDirCache = new Map<string, SessionDirInfo>();

async function readSessionDir(dir: string, mtimeMs: number): Promise<SessionDirInfo | null> {
  const cached = sessionDirCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const yamlText = files.includes('workspace.yaml') ? await readFileText(path.join(dir, 'workspace.yaml')) : null;
  const info = { mtimeMs, files, ws: yamlText ? parseWorkspaceYaml(yamlText) : {} };
  sessionDirCache.set(dir, info);
  return info;
}

/** Exposed for tests. */
export function resetLocalSessionCaches(): void {
  sessionDirCache.clear();
  copilotPrScans.clear();
  claudePrScans.clear();
}

export async function discoverCopilotLocalSessions(options: LocalSessionDiscoveryOptions = {}): Promise<CopilotLocalDiscovery> {
  const home = options.homeDir ?? os.homedir();
  const alive = options.isPidAlive ?? isPidAlive;
  const now = options.now?.() ?? Date.now();
  const cutoff = now - (options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);
  const mirrorCutoff = Math.min(cutoff, now - (options.mirrorWindowMs ?? DEFAULT_MIRROR_WINDOW_MS));
  const root = path.join(home, '.copilot', 'session-state');
  const timer = options.timer ?? new PhaseTimer();
  const scanStart = Date.now();

  const sessions: ActiveAgentSession[] = [];
  const mirroredTasks = new Map<string, string>();

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { sessions, mirroredTasks };
  }

  // Thousands of dirs: stat them concurrently (in the libuv pool, off the main
  // thread) so a cold disk cache or a virus scanner costs wall time only.
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => ({ dirName: e.name, dir: path.join(root, e.name) }));
  const scanned = await mapLimit(dirs, SCAN_CONCURRENCY, async ({ dirName, dir }) => {
    const mtimeMs = await mtimeOf(dir);
    if (mtimeMs === null || mtimeMs < mirrorCutoff) {
      sessionDirCache.delete(dir);
      return null;
    }
    const info = await readSessionDir(dir, mtimeMs);
    return info ? { dirName, dir, info } : null;
  });

  const held: Array<{ dirName: string; dir: string; files: string[]; locks: LockCandidate[] }> = [];
  for (const entry of scanned) {
    if (!entry) continue;
    const { dirName, dir, info } = entry;
    if (info.ws.mc_task_id) mirroredTasks.set(info.ws.mc_task_id, clientLabel(info.ws.client_name));
    if (info.mtimeMs < cutoff) continue;

    const lockFiles = info.files
      .map((f) => ({ file: f, pid: Number(f.match(/^inuse\.(\d+)\.lock$/)?.[1]) }))
      .filter((l) => Number.isInteger(l.pid) && alive(l.pid));
    if (lockFiles.length === 0) continue;
    const locks = await Promise.all(lockFiles.map(async (l) => ({ pid: l.pid, writtenAtMs: await mtimeOf(path.join(dir, l.file)) })));
    held.push({ dirName, dir, files: info.files, locks });
  }

  timer.add('copilotScan', Date.now() - scanStart);
  const ownsLock = await timer.time('copilotPids', () => lockOwnerVerifier(held.flatMap((h) => h.locks), options));

  const scannedLogs = new Set<string>();
  for (const { dirName, dir, files, locks } of held) {
    const pid = locks.find(ownsLock)?.pid;
    if (pid === undefined) continue;

    // A live session rewrites workspace.yaml (name, updated_at) in place, so read it fresh.
    const yamlText = files.includes('workspace.yaml') ? await readFileText(path.join(dir, 'workspace.yaml')) : null;
    const ws = yamlText ? parseWorkspaceYaml(yamlText) : {};
    const eventsPath = files.includes('events.jsonl') ? path.join(dir, 'events.jsonl') : null;
    const events = eventsPath
      ? await timer.time('copilotTail', () => readTailEntries(eventsPath, (evs) => deriveCopilotActivity(evs, now) !== 'unknown'))
      : [];
    const sessionId = ws.id || dirName;
    const eventsMtime = eventsPath ? await mtimeOf(eventsPath) : null;
    const wsUpdated = toIso(ws.updated_at);
    const updatedAt = eventsMtime !== null && eventsMtime > (Date.parse(wsUpdated ?? '') || 0)
      ? new Date(eventsMtime).toISOString()
      : wsUpdated;
    if (eventsPath) scannedLogs.add(eventsPath);

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
      linkedPr: eventsPath ? await timer.time('copilotPrLink', () => findCopilotPrLink(eventsPath)) : null,
      sessionFile: eventsPath,
    });
  }
  pruneScans(copilotPrScans, scannedLogs);

  return { sessions, mirroredTasks };
}

interface CopilotPrScanState {
  /** toolCallIds of `gh pr create` shell calls seen so far. */
  createCalls: Set<string>;
  found: ActiveAgentSession['linkedPr'];
}

const copilotPrScans = new Map<string, LineScan<CopilotPrScanState>>();

function scanCopilotPrLine(line: string, state: CopilotPrScanState): void {
  const isStart = line.includes('gh pr create');
  const isComplete = !isStart && line.includes('/pull/') && state.createCalls.size > 0;
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
    if (typeof command === 'string' && /\bgh\s+pr\s+create\b/.test(command)) state.createCalls.add(id);
  } else if (ev.type === 'tool.execution_complete' && state.createCalls.has(id) && data.success !== false) {
    const content = (data.result as Record<string, unknown> | undefined)?.content;
    const m = typeof content === 'string'
      ? content.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\s*$/m)
      : null;
    if (m) state.found = { repoFullName: m[1], number: Number(m[2]) };
  }
}

/**
 * Latest PR a Copilot session created: the output of a successful `gh pr create`
 * shell call is the new PR's URL on its own line. Other PR URLs in the log
 * (reviews, comments on someone else's PR) are deliberately ignored. Exported for tests.
 */
export function findCopilotPrLinkInText(text: string): ActiveAgentSession['linkedPr'] {
  const state: CopilotPrScanState = { createCalls: new Set(), found: null };
  for (const line of text.split('\n')) scanCopilotPrLine(line, state);
  return state.found;
}

/** {@link findCopilotPrLinkInText} over an events log, reading only what was appended since the last call. Exported for tests. */
export async function findCopilotPrLink(eventsPath: string): Promise<ActiveAgentSession['linkedPr']> {
  const state = await scanNewLines(eventsPath, copilotPrScans, () => ({ createCalls: new Set<string>(), found: null }), scanCopilotPrLine);
  return state?.found ?? null;
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

interface ClaudePrScanState {
  found: ActiveAgentSession['linkedPr'];
}

const claudePrScans = new Map<string, LineScan<ClaudePrScanState>>();

function scanClaudePrLine(line: string, state: ClaudePrScanState): void {
  if (!line.includes('"pr-link"')) return;
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    if (e.type === 'pr-link' && typeof e.prNumber === 'number' && typeof e.prRepository === 'string') {
      state.found = { repoFullName: e.prRepository, number: e.prNumber };
    }
  } catch {
    // partial line — skip
  }
}

/**
 * Latest PR the session reported via a `pr-link` transcript entry. These can
 * sit anywhere in the file, so unlike the activity tail this scans line by line
 * (cheap string pre-filter before parsing), reading only what was appended
 * since the last call. Exported for tests.
 */
export async function findClaudePrLink(transcript: string): Promise<ActiveAgentSession['linkedPr']> {
  const state = await scanNewLines(transcript, claudePrScans, () => ({ found: null }), scanClaudePrLine);
  return state?.found ?? null;
}

export function findPrLinkInText(text: string): ActiveAgentSession['linkedPr'] {
  const state: ClaudePrScanState = { found: null };
  for (const line of text.split('\n')) scanClaudePrLine(line, state);
  return state.found;
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
    files = (await fsp.readdir(sessionsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const candidates: Array<{ meta: Record<string, unknown>; lock: LockCandidate }> = [];
  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    const raw = await readFileText(filePath);
    if (!raw) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pid = typeof meta.pid === 'number' ? meta.pid : Number(path.basename(file, '.json'));
    if (!alive(pid)) continue;
    candidates.push({ meta, lock: { pid, writtenAtMs: await mtimeOf(filePath) } });
  }

  const timer = options.timer ?? new PhaseTimer();
  const ownsLock = await timer.time('claudePids', () => lockOwnerVerifier(candidates.map((c) => c.lock), options));

  const sessions: ActiveAgentSession[] = [];
  const scannedTranscripts = new Set<string>();
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
      const mtime = await mtimeOf(transcript);
      if (mtime !== null) {
        // A title entry isn't necessarily near the tail — widen the read until
        // one turns up, not just until there's enough to tell activity, or
        // titles fall back to the first prompt.
        const entries = await timer.time('claudeTail', () => readTailEntries(
          transcript,
          (es) => es.some((e) => e.type === 'assistant' || e.type === 'user') && es.some(isClaudeTitleEntry),
        ));
        activity = deriveClaudeActivity(entries, mtime, now);
        title = extractClaudeTitle(entries);
        lastActiveMs = mtime;
        linkedPr = await timer.time('claudePrLink', () => findClaudePrLink(transcript));
        scannedTranscripts.add(transcript);
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
  pruneScans(claudePrScans, scannedTranscripts);
  return sessions;
}
