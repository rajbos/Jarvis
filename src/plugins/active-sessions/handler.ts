// ── Active agent sessions IPC handlers ────────────────────────────────────────
// Lists running Copilot / Claude sessions (local + cloud), links them to their
// PRs and reports whether each PR is ready for human review. A background
// sweep (see src/main/background-tasks.ts) keeps the snapshot fresh and raises
// a desktop notification once per head commit when a PR becomes ready (held
// while a linked agent is still working, since it may push more commits).

import { Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { safeHandle } from '../ipc-utils';
import { logger } from '../../services/logger';
import { loadGitHubAuth } from '../../services/github-oauth';
import { collectActiveSessions } from '../../services/active-sessions';
import { saveDatabase } from '../../storage/database';
import type { ActiveSessionsSnapshot, PrReadiness } from '../types';

let latestSnapshot: ActiveSessionsSnapshot | null = null;
let inFlight: Promise<ActiveSessionsSnapshot> | null = null;

/** Exposed for tests. */
export function resetActiveSessionsState(): void {
  latestSnapshot = null;
  inFlight = null;
}

/** Linked agent activities that may still push commits — hold the "ready" notification until they settle. */
const STILL_PUSHING: ReadonlySet<string> = new Set(['working', 'queued']);

export function prKey(pr: Pick<PrReadiness, 'repoFullName' | 'prNumber'>): string {
  return `${pr.repoFullName.toLowerCase()}#${pr.prNumber}`;
}

/**
 * Upsert readiness rows and return the PRs that just became ready for a head
 * commit we haven't notified about yet. PRs in `holdNotify` (keyed by
 * `prKey`) are recorded but not notified, so they notify on a later sweep.
 */
export function recordReadiness(
  db: SqlJsDatabase,
  prs: PrReadiness[],
  holdNotify: ReadonlySet<string> = new Set(),
): PrReadiness[] {
  const newlyReady: PrReadiness[] = [];
  for (const pr of prs) {
    const existing = db.exec(
      'SELECT ready_notified_sha FROM pr_readiness WHERE repo_full_name = ? AND pr_number = ?',
      [pr.repoFullName, pr.prNumber],
    );
    const notifiedSha = (existing[0]?.values[0]?.[0] as string | null | undefined) ?? null;
    const shouldNotify = pr.ready && notifiedSha !== pr.headSha && !holdNotify.has(prKey(pr));
    if (shouldNotify) newlyReady.push(pr);

    db.run(
      `INSERT INTO pr_readiness (repo_full_name, pr_number, head_sha, ready, waiting_on, checked_at, ready_notified_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_full_name, pr_number) DO UPDATE SET
         head_sha = excluded.head_sha,
         ready = excluded.ready,
         waiting_on = excluded.waiting_on,
         checked_at = excluded.checked_at,
         ready_notified_sha = COALESCE(excluded.ready_notified_sha, pr_readiness.ready_notified_sha)`,
      [
        pr.repoFullName,
        pr.prNumber,
        pr.headSha,
        pr.ready ? 1 : 0,
        pr.waitingOn.join(',') || null,
        pr.checkedAt,
        shouldNotify ? pr.headSha : null,
      ],
    );
  }
  return newlyReady;
}

function notifyReady(prs: PrReadiness[]): void {
  if (prs.length === 0) return;
  const body = prs.length === 1
    ? `${prs[0].repoFullName}#${prs[0].prNumber} — ${prs[0].title}`
    : prs.map((p) => `${p.repoFullName}#${p.prNumber}`).join(', ');
  new Notification({
    title: prs.length === 1 ? 'PR ready for your review' : `${prs.length} PRs ready for your review`,
    body,
  }).show();
}

/**
 * Collect a fresh snapshot, persist readiness, notify on newly-ready PRs and
 * push the snapshot to the renderer. Concurrent callers share one sweep.
 */
export async function refreshActiveSessions(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<ActiveSessionsSnapshot> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const auth = loadGitHubAuth(db);
    const snapshot = await collectActiveSessions({ accessToken: auth?.accessToken ?? null });

    const openPrs = new Map<string, PrReadiness>();
    const holdNotify = new Set<string>();
    for (const entry of snapshot.entries) {
      if (!entry.pr || entry.pr.state !== 'OPEN') continue;
      const key = prKey(entry.pr);
      openPrs.set(key, entry.pr);
      if (STILL_PUSHING.has(entry.session.activity)) holdNotify.add(key);
    }
    try {
      const newlyReady = recordReadiness(db, [...openPrs.values()], holdNotify);
      if (openPrs.size > 0) saveDatabase();
      try {
        notifyReady(newlyReady);
      } catch (err) {
        logger.warn('[ActiveSessions] Failed to show ready notification:', err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      logger.warn('[ActiveSessions] Failed to record PR readiness:', err instanceof Error ? err.message : String(err));
    }

    latestSnapshot = snapshot;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('active-sessions:updated', snapshot);
    logger.debug(`[ActiveSessions] ${snapshot.entries.length} session(s), ${snapshot.readyCount} ready for review`);
    return snapshot;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Background-task entry point; returns a compact summary for the task log. */
export async function runActiveSessionsSweep(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<{ sessions: number; ready: number; waiting: number; errors: string[] }> {
  const snapshot = await refreshActiveSessions(db, getWindow);
  const errors = Object.entries(snapshot.sources)
    .filter(([, s]) => !s.ok && s.error)
    .map(([name, s]) => `${name}: ${s.error}`);
  return {
    sessions: snapshot.entries.length,
    ready: snapshot.readyCount,
    waiting: snapshot.entries.filter((e) => e.verdict === 'waiting').length,
    errors,
  };
}

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  safeHandle('active-sessions:get', () => latestSnapshot);
  safeHandle('active-sessions:refresh', () => refreshActiveSessions(db, getWindow));
}
