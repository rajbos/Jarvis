// ── "What's on fire" brief ────────────────────────────────────────────────────
// Assembles one structured brief from data Jarvis already has: notifications
// that survived auto-dismiss, failed workflow runs, PR readiness, agent
// sessions that need input or stalled, and background task failures.
//
// `buildFireBrief` is pure (inputs in, brief out) so it is unit tested without a
// database; `collectBriefInputs` reads the inputs from SQLite. The prose summary
// is optional and only ever added on top (`addProseSummary`): the structured
// list never depends on Ollama.
//
// "Since the last brief": the config key `fire_brief.last_ack_at` holds the time
// the user last acknowledged a brief. Failed runs and task failures newer than
// that count as new; with no marker we look back one day, and never further
// than seven days. Notifications, PRs and sessions are state, not events, so
// they always show their current state.
import type { Database as SqlJsDatabase } from 'sql.js';
import type { ActiveSessionEntry, ActiveSessionsSnapshot } from '../plugins/types';
import { apiUrlToWebUrl, repoWebUrl } from '../plugins/shared/github-urls';
import { logger } from './logger';

export const LAST_ACK_CONFIG_KEY = 'fire_brief.last_ack_at';
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** A "working" agent session with no update for this long counts as stalled. */
export const SESSION_STALL_MS = 30 * 60 * 1000;
/** pr_readiness rows older than this are likely merged/closed leftovers. */
export const PR_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const MAX_ITEMS_PER_SECTION = 10;

export type BriefSectionId = 'notifications' | 'failed_runs' | 'prs' | 'sessions' | 'task_failures';
export type BriefSeverity = 'fire' | 'attention';

export interface BriefItem {
  id: string;
  severity: BriefSeverity;
  text: string;
  /** Web URL of the item; null when it has none (e.g. a background task). */
  url: string | null;
  /** Local navigation hint for items with no web URL. */
  tab?: 'agent-sessions' | 'dashboard' | 'setup';
}

export interface BriefSection {
  id: BriefSectionId;
  title: string;
  /** Total matching items; `items` is capped at MAX_ITEMS_PER_SECTION. */
  total: number;
  items: BriefItem[];
}

export interface FireBrief {
  generatedAt: string;
  /** Start of the window used for "since the last brief". */
  since: string;
  sections: BriefSection[];
  /** Number of items across all sections (uncapped). */
  totalItems: number;
  /** True when nothing needs attention. */
  allClear: boolean;
  /** Optional Ollama prose; absent when Ollama is unavailable. */
  summary?: string;
}

export interface BriefNotification { id: string; repoFullName: string; title: string | null; subjectType: string | null; subjectUrl: string | null; host: string }
export interface BriefFailedRun { id: string; repoFullName: string; workflowName: string | null; branch: string | null; htmlUrl: string | null; at: string | null }
export interface BriefPr { repoFullName: string; prNumber: number; ready: boolean; waitingOn: string[]; checkedAt: string }
export interface BriefTaskFailure { taskId: string; failedAt: string; error: string }

export interface FireBriefInputs {
  now: number;
  /** Epoch ms of the last acknowledged brief, or null. */
  lastBriefAt: number | null;
  notifications: BriefNotification[];
  failedRuns: BriefFailedRun[];
  prs: BriefPr[];
  sessions: ActiveSessionEntry[];
  taskFailures: BriefTaskFailure[];
}

export function resolveSince(now: number, lastBriefAt: number | null): number {
  if (lastBriefAt === null || !Number.isFinite(lastBriefAt) || lastBriefAt > now) return now - DEFAULT_LOOKBACK_MS;
  return Math.max(lastBriefAt, now - MAX_LOOKBACK_MS);
}

function parseTime(value: string | null | undefined): number {
  if (!value) return NaN;
  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const normalized = /^\d{4}-\d{2}-\d{2} \d/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(normalized);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Coarse, human-readable length of time: "31 min", "5 hours", "3 days",
 * "6 weeks", "2 months", "1 year". Rounds down to the largest sensible unit.
 */
export function formatElapsed(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return plural(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 14) return plural(days, 'day');
  if (days < 60) return plural(Math.floor(days / 7), 'week');
  if (days < 365) return plural(Math.floor(days / 30), 'month');
  return plural(Math.floor(days / 365), 'year');
}

function section(id: BriefSectionId, title: string, items: BriefItem[]): BriefSection {
  return { id, title, total: items.length, items: items.slice(0, MAX_ITEMS_PER_SECTION) };
}

function notificationItems(list: BriefNotification[]): BriefItem[] {
  const byRepo = new Map<string, BriefNotification[]>();
  for (const n of list) byRepo.set(n.repoFullName, [...(byRepo.get(n.repoFullName) ?? []), n]);
  return [...byRepo.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([repo, ns]) => {
      const host = ns[0].host;
      // A single notification links to the item itself, several link to the repo.
      const single = ns.length === 1 && ns[0].subjectUrl ? apiUrlToWebUrl(ns[0].subjectUrl) : null;
      const text = ns.length === 1
        ? `${repo}: ${ns[0].title ?? ns[0].subjectType ?? 'notification'}`
        : `${repo}: ${plural(ns.length, 'unread notification')}`;
      return { id: `notif:${repo}`, severity: 'attention' as const, text, url: single ?? repoWebUrl(repo, host) };
    });
}

function sessionLabel(e: ActiveSessionEntry): string {
  return e.session.title ?? e.session.repoFullName ?? e.session.client;
}

function sessionItems(entries: ActiveSessionEntry[], now: number): BriefItem[] {
  const items: BriefItem[] = [];
  for (const e of entries) {
    const s = e.session;
    // The session's PR was merged or closed: its work is finished, whatever
    // the agent last reported. Sessions with no PR (or an open one) still show.
    if (e.pr && e.pr.state !== 'OPEN') continue;
    const prUrl = e.pr?.url ?? (s.linkedPr ? `${repoWebUrl(s.linkedPr.repoFullName)}/pull/${s.linkedPr.number}` : null);
    if (s.activity === 'waiting_for_user') {
      items.push({ id: `session:${s.key}`, severity: 'fire', text: `${s.client} needs input: ${sessionLabel(e)}`, url: prUrl, tab: 'agent-sessions' });
      continue;
    }
    const updated = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
    if (s.activity === 'working' && Number.isFinite(updated) && now - updated >= SESSION_STALL_MS) {
      items.push({ id: `session:${s.key}`, severity: 'attention', text: `${s.client} looks stalled (no update for ${formatElapsed(now - updated)}): ${sessionLabel(e)}`, url: prUrl, tab: 'agent-sessions' });
    }
  }
  return items;
}

/** Pure: build the structured brief. Never throws on malformed rows. */
export function buildFireBrief(inputs: FireBriefInputs): FireBrief {
  const { now } = inputs;
  const since = resolveSince(now, inputs.lastBriefAt);

  const runs = inputs.failedRuns
    .filter((r) => { const t = parseTime(r.at); return Number.isFinite(t) && t >= since; })
    .sort((a, b) => parseTime(b.at) - parseTime(a.at))
    .map<BriefItem>((r) => ({
      id: `run:${r.id}`,
      severity: 'fire',
      text: `${r.repoFullName}: ${r.workflowName ?? 'workflow'} failed${r.branch ? ` on ${r.branch}` : ''}`,
      url: r.htmlUrl ?? repoWebUrl(r.repoFullName),
    }));

  const prs = inputs.prs
    .filter((p) => { const t = parseTime(p.checkedAt); return Number.isFinite(t) && now - t <= PR_MAX_AGE_MS; })
    .filter((p) => p.ready || p.waitingOn.length > 0)
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.repoFullName.localeCompare(b.repoFullName) || a.prNumber - b.prNumber)
    .map<BriefItem>((p) => ({
      id: `pr:${p.repoFullName}#${p.prNumber}`,
      severity: 'attention',
      text: p.ready
        ? `${p.repoFullName}#${p.prNumber} is ready for review`
        : `${p.repoFullName}#${p.prNumber} is blocked, waiting on ${p.waitingOn.map((w) => (w === 'checks' ? 'checks' : 'Copilot review')).join(' + ')}`,
      url: `${repoWebUrl(p.repoFullName)}/pull/${p.prNumber}`,
    }));

  const failures = inputs.taskFailures
    .filter((f) => { const t = parseTime(f.failedAt); return Number.isFinite(t) && t >= since; })
    .sort((a, b) => parseTime(b.failedAt) - parseTime(a.failedAt))
    .map<BriefItem>((f, i) => ({
      id: `task:${f.taskId}:${f.failedAt}:${i}`,
      severity: 'attention',
      text: `Background task "${f.taskId}" failed: ${f.error.slice(0, 120)}`,
      url: null,
      tab: 'setup',
    }));

  const sections: BriefSection[] = [
    section('sessions', 'Agent sessions', sessionItems(inputs.sessions, now)),
    section('failed_runs', 'Failed workflow runs', runs),
    section('prs', 'Pull requests', prs),
    section('notifications', 'Unread notifications', notificationItems(inputs.notifications)),
    section('task_failures', 'Background task failures', failures),
  ].filter((s) => s.total > 0);

  const totalItems = sections.reduce((n, s) => n + s.total, 0);
  return { generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), sections, totalItems, allClear: totalItems === 0 };
}

// ── Database access ───────────────────────────────────────────────────────────

function rows<T>(db: SqlJsDatabase, sql: string, params: Array<string | number> = []): T[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out: T[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as T);
    return out;
  } finally {
    stmt.free();
  }
}

export function getLastBriefAt(db: SqlJsDatabase): number | null {
  const found = rows<{ value: string }>(db, 'SELECT value FROM config WHERE key = ?', [LAST_ACK_CONFIG_KEY])[0];
  const t = found ? Date.parse(found.value) : NaN;
  return Number.isFinite(t) ? t : null;
}

export function acknowledgeBrief(db: SqlJsDatabase, now = Date.now()): void {
  db.run(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [LAST_ACK_CONFIG_KEY, new Date(now).toISOString()],
  );
}

function parseWaitingOn(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* stored as a plain list */ }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Read each source defensively: one broken table must not hide the rest of the brief. */
export function collectBriefInputs(db: SqlJsDatabase, snapshot: ActiveSessionsSnapshot | null, now = Date.now()): FireBriefInputs {
  const safe = <T>(label: string, read: () => T[]): T[] => {
    try {
      return read();
    } catch (err) {
      logger.warn(`[FireBrief] Could not read ${label}:`, err instanceof Error ? err.message : String(err));
      return [];
    }
  };
  const lastBriefAt = safe('config', () => [getLastBriefAt(db)])[0] ?? null;
  const since = new Date(resolveSince(now, lastBriefAt)).toISOString().slice(0, 19).replace('T', ' ');
  return {
    now,
    lastBriefAt,
    notifications: safe('notifications', () => rows<{ id: string; repo_full_name: string; subject_title: string | null; subject_type: string | null; subject_url: string | null; host: string | null }>(
      db, 'SELECT id, repo_full_name, subject_title, subject_type, subject_url, host FROM github_notifications WHERE unread = 1')
      .map((r) => ({ id: r.id, repoFullName: r.repo_full_name, title: r.subject_title, subjectType: r.subject_type, subjectUrl: r.subject_url, host: r.host ?? 'github.com' }))),
    failedRuns: safe('workflow runs', () => rows<{ id: string; repo_full_name: string; workflow_name: string | null; head_branch: string | null; html_url: string | null; at: string | null }>(
      db, `SELECT id, repo_full_name, workflow_name, head_branch, html_url, COALESCE(updated_at, run_started_at) AS at
           FROM github_workflow_runs WHERE conclusion = 'failure' AND COALESCE(updated_at, run_started_at) >= ?`, [since])
      .map((r) => ({ id: r.id, repoFullName: r.repo_full_name, workflowName: r.workflow_name, branch: r.head_branch, htmlUrl: r.html_url, at: r.at }))),
    prs: safe('PR readiness', () => rows<{ repo_full_name: string; pr_number: number; ready: number; waiting_on: string | null; checked_at: string }>(
      db, 'SELECT repo_full_name, pr_number, ready, waiting_on, checked_at FROM pr_readiness')
      .map((r) => ({ repoFullName: r.repo_full_name, prNumber: r.pr_number, ready: r.ready === 1, waitingOn: parseWaitingOn(r.waiting_on), checkedAt: r.checked_at }))),
    sessions: snapshot?.entries ?? [],
    taskFailures: safe('task failures', () => rows<{ task_id: string; failed_at: string; error: string }>(
      db, 'SELECT task_id, failed_at, error FROM task_failures ORDER BY id DESC LIMIT 100')
      .map((r) => ({ taskId: r.task_id, failedAt: r.failed_at, error: r.error }))),
  };
}

// ── Optional prose ────────────────────────────────────────────────────────────

export function briefToPrompt(brief: FireBrief): string {
  const lines = brief.sections.flatMap((s) => [`${s.title} (${s.total}):`, ...s.items.map((i) => `- ${i.text}`)]);
  return `Summarize this status list in at most three plain sentences. Lead with the most urgent item. Do not invent anything.\n\n${lines.join('\n')}`;
}

export type SummarizeFn = (prompt: string) => Promise<string>;

/** Adds Ollama prose when it works; returns the brief unchanged on any failure. */
export async function addProseSummary(brief: FireBrief, summarize: SummarizeFn | null, timeoutMs = 20000): Promise<FireBrief> {
  if (!summarize || brief.allClear) return brief;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      summarize(briefToPrompt(brief)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    const trimmed = text.trim();
    return trimmed ? { ...brief, summary: trimmed } : brief;
  } catch (err) {
    logger.debug('[FireBrief] Prose summary skipped:', err instanceof Error ? err.message : String(err));
    return brief;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
