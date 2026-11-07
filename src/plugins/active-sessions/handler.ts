// ── Active agent sessions IPC handlers ────────────────────────────────────────
// Lists running Copilot / Claude sessions (local + cloud), links them to their
// PRs and reports whether each PR is ready for human review. A background
// sweep (see src/main/background-tasks.ts) keeps the snapshot fresh and raises
// a desktop notification once per head commit when a PR becomes ready (held
// while a linked agent is still working, since it may push more commits).

import { clipboard, shell, type BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { safeHandle } from '../ipc-utils';
import { logger } from '../../services/logger';
import { showSafeNotification } from '../../services/notifications';
import { accessForPrimary, accessForRepo, ghCliFallbacks } from '../../services/github-repo-access';
import { DEFAULT_HOST } from '../../services/github-host';
import { collectActiveSessions } from '../../services/active-sessions';
import { PhaseTimer } from '../../services/phase-timer';
import { summarizeGitHubApiCalls } from '../../services/github-api';
import { saveDatabase } from '../../storage/database';
import type { ActiveSessionEntry, ActiveSessionsSnapshot, AgentActionKind, AgentActionResult, PrReadiness } from '../types';
import { AGENT_ACTION_KINDS, AGENT_DEEP_LINK_SCHEMES, planAgentAction, type AgentActionPlan } from '../../services/agent-actions';
import { githubRequest } from '../../services/github-api';
import { openTerminal, resolveDirectory } from '../../services/process-launch';
import { apiBaseForHost } from '../../services/github-host';

let latestSnapshot: ActiveSessionsSnapshot | null = null;
let inFlight: Promise<ActiveSessionsSnapshot> | null = null;

/** The snapshot the renderer currently shows (null before the first sweep). */
export function getLatestActiveSessionsSnapshot(): ActiveSessionsSnapshot | null {
  return latestSnapshot;
}

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
  showSafeNotification(
    prs.length === 1 ? 'PR ready for your review' : `${prs.length} PRs ready for your review`,
    body,
    { tag: '[ActiveSessions]' },
  );
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
    // Cloud agent tasks belong to the primary account; each local session's PR is
    // looked up with the account that serves its repo (assignment, git config,
    // discovery), so org repos are checked with the org account.
    const timer = new PhaseTimer();
    const startedAt = Date.now();
    const primary = await timer.time('primary', () => accessForPrimary(db));
    const snapshot = await collectActiveSessions({
      timer,
      accessToken: primary?.token ?? null,
      accessAccount: primary?.id ?? null,
      // When that account's token can't see the repo (e.g. not SSO-authorized for
      // the org), retry with the GitHub CLI's logins.
      accessForRepo: async (repoFullName) => {
        const access = await accessForRepo(db, repoFullName, DEFAULT_HOST);
        if (!access) return null;
        return {
          token: access.token,
          account: access.id,
          fallbacks: async () => (await ghCliFallbacks(access, DEFAULT_HOST)).map((f) => ({ token: f.token, account: f.id })),
        };
      },
    });

    const openPrs = new Map<string, PrReadiness>();
    const holdNotify = new Set<string>();
    for (const entry of snapshot.entries) {
      if (!entry.pr || entry.pr.state !== 'OPEN') continue;
      const key = prKey(entry.pr);
      openPrs.set(key, entry.pr);
      if (STILL_PUSHING.has(entry.session.activity)) holdNotify.add(key);
    }
    try {
      const newlyReady = timer.sync('recordReadiness', () => recordReadiness(db, [...openPrs.values()], holdNotify));
      if (openPrs.size > 0) timer.sync('saveDatabase', () => saveDatabase());
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
    logger.debug(`[ActiveSessions] sweep took ${Date.now() - startedAt}ms: ${timer.summary()}`);
    const apiCalls = summarizeGitHubApiCalls(startedAt);
    if (apiCalls) logger.info(`[ActiveSessions] GitHub API usage this sweep: ${apiCalls}`);
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

function isActionKind(value: unknown): value is AgentActionKind {
  return typeof value === 'string' && (AGENT_ACTION_KINDS as readonly string[]).includes(value);
}

function isAllowedDeepLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (AGENT_DEEP_LINK_SCHEMES.includes(parsed.protocol)) return true;
    return parsed.protocol === 'https:' && /^(?:github\.com|[a-z0-9-]+\.ghe\.com)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Execute a planned action for `entry`: open a deep link, start a terminal
 * with the agent CLI, or post the follow-up as a PR comment. Exported for tests.
 */
export async function executeAgentAction(db: SqlJsDatabase, entry: ActiveSessionEntry, plan: AgentActionPlan): Promise<AgentActionResult> {
  const label = `${entry.session.client} ${entry.session.sessionId.slice(0, 8)}`;
  switch (plan.kind) {
    case 'unsupported':
      return { ok: false, error: plan.description };
    case 'deep-link': {
      if (!isAllowedDeepLink(plan.url)) return { ok: false, error: `Refusing to open ${plan.url}` };
      if (plan.copyPrompt && plan.prompt) clipboard.writeText(plan.prompt);
      logger.info(`[ActiveSessions] ${label}: opening ${plan.url.split('?')[0]}`);
      await shell.openExternal(plan.url);
      return { ok: true, kind: 'deep-link', message: plan.description, prompt: plan.prompt };
    }
    case 'terminal': {
      const cwd = plan.cwd ? resolveDirectory(plan.cwd) : null;
      if (!cwd) return { ok: false, error: `The session folder is missing: ${plan.cwd ?? '(none)'}` };
      logger.info(`[ActiveSessions] ${label}: ${plan.file} ${plan.args.slice(0, 2).join(' ')} in ${cwd}`);
      openTerminal(cwd, { file: plan.file, args: plan.args });
      return { ok: true, kind: 'terminal', message: plan.description, prompt: plan.prompt };
    }
    case 'pr-comment': {
      const access = await accessForRepo(db, plan.repoFullName, DEFAULT_HOST);
      if (!access) return { ok: false, error: `No GitHub account can comment on ${plan.repoFullName}` };
      const url = `${apiBaseForHost(access.host)}/repos/${plan.repoFullName}/issues/${plan.prNumber}/comments`;
      const response = await githubRequest(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: plan.body }),
      }, { purpose: 'agent-trigger:pr-comment' });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, error: `GitHub rejected the comment (HTTP ${response.status}) ${text.slice(0, 120)}`.trim() };
      }
      logger.info(`[ActiveSessions] ${label}: asked @copilot to continue on ${plan.repoFullName}#${plan.prNumber} (as @${access.id})`);
      return { ok: true, kind: 'pr-comment', message: `${plan.description} (as @${access.id})`, prompt: plan.prompt };
    }
  }
}

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  safeHandle('active-sessions:get', () => latestSnapshot);
  safeHandle('active-sessions:refresh', () => refreshActiveSessions(db, getWindow));
  safeHandle('active-sessions:run-action', async (_event, sessionKey: unknown, kind: unknown): Promise<AgentActionResult> => {
    if (typeof sessionKey !== 'string' || !isActionKind(kind)) return { ok: false, error: 'Invalid arguments' };
    const entry = latestSnapshot?.entries.find((e) => e.session.key === sessionKey);
    if (!entry) return { ok: false, error: 'Session not in the latest snapshot — refresh and try again' };
    return executeAgentAction(db, entry, planAgentAction(kind, entry));
  });
}
