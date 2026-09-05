// ── Notifications IPC handlers ────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import type { AutoDismissLogInput } from '../types';
import {
  fetchNotifications,
  fetchNotificationsForRepo,
  storeNotifications,
  storeNotificationsForOwner,
  storeNotificationsForRepo,
  getNotificationCounts,
  listNotificationsForRepo,
  listNotificationsForOwner,
  listNotificationsForStarred,
  listPrNotifications,
  listIssueNotifications,
  deleteNotification,
  markNotificationRead,
  listMergedDependabotPRNotifications,
  listDeletedBranchNotifications,
} from '../../services/github-notifications';
import { loadGitHubAuth } from '../../services/github-oauth';
import { saveDatabase } from '../../storage/database';
import { fetchAndStoreWorkflowData, getWorkflowSummaryForRepo } from '../../services/github-workflows';
import { isWorkflowDataFresh } from './workflow-cache';

// ── Boot workflow check constants ─────────────────────────────────────────────

/** When rate limit remaining is below this value, check estimated call count. */
const BOOT_CHECK_RATE_LIMIT_THRESHOLD = 1000;

/** Skip boot pre-warm if estimated API calls exceed this when rate limit is low. */
const BOOT_CHECK_MAX_ESTIMATED_CALLS = 50;

/** Conservative per-repo estimate: 1 runs page + up to 5 failing-run details. */
const BOOT_CHECK_ESTIMATED_CALLS_PER_REPO = 10;

/**
 * Fetches the core rate-limit remaining count for the given token.
 * Returns null if the request fails (caller should treat null as "unknown / proceed").
 */
async function fetchTokenRateLimitRemaining(token: string): Promise<number | null> {
  try {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { resources: { core: { remaining: number } } };
    return data.resources.core.remaining;
  } catch {
    return null;
  }
}


export interface AutoDismissStepResult {
  id: string;
  label: string;
  dismissed: number;
}

export interface AutoDismissRunResult {
  steps: AutoDismissStepResult[];
  total: number;
}

export interface AutoDismissSweepResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  counts?: ReturnType<typeof getNotificationCounts>;
  result?: AutoDismissRunResult;
  logEntries?: AutoDismissLogInput[];
}

export async function syncGitHubNotifications(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<{ ok: boolean; skipped?: boolean; error?: string; counts?: ReturnType<typeof getNotificationCounts> }> {
  const auth = loadGitHubAuth(db);
  if (!auth) return { ok: true, skipped: true, error: 'Not authenticated' };
  const notifications = await fetchNotifications(auth.accessToken);
  storeNotifications(db, notifications);
  saveDatabase();
  const counts = getNotificationCounts(db);
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('github:notification-counts-updated', counts);
  }
  return { ok: true, counts };
}

async function fetchPrState(
  accessToken: string,
  currentLogin: string,
  subjectUrl: string,
): Promise<{ state: 'open' | 'closed' | 'merged'; isDependabot: boolean; closedByMe: boolean } | null> {
  if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(subjectUrl)) return null;
  try {
    const res = await fetch(subjectUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) return null;
    const pr = (await res.json()) as {
      state: string;
      merged: boolean;
      user: { login: string } | null;
      merged_by: { login: string } | null;
    };
    const authorLogin = (pr.user?.login ?? '').toLowerCase();
    const isDependabot = authorLogin.includes('dependabot');
    const myLogin = currentLogin.toLowerCase();
    if (pr.merged) {
      return { state: 'merged', isDependabot, closedByMe: (pr.merged_by?.login ?? '').toLowerCase() === myLogin };
    }
    if (pr.state === 'closed') {
      return { state: 'closed', isDependabot, closedByMe: authorLogin === myLogin };
    }
    return { state: 'open', isDependabot, closedByMe: false };
  } catch {
    return null;
  }
}

async function fetchIssueState(
  accessToken: string,
  currentLogin: string,
  subjectUrl: string,
): Promise<{ state: 'open' | 'closed'; closedByMe: boolean; closedViaMergedPr: boolean; closedViaCollabPr: boolean } | null> {
  if (!/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(subjectUrl)) return null;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  try {
    const issueRes = await fetch(subjectUrl, { headers });
    if (!issueRes.ok) return null;
    const issue = (await issueRes.json()) as { state: string };
    if (issue.state !== 'closed') return { state: 'open', closedByMe: false, closedViaMergedPr: false, closedViaCollabPr: false };

    const eventsRes = await fetch(`${subjectUrl}/events`, { headers });
    let closedByMe = false;
    let closedViaMergedPr = false;
    if (eventsRes.ok) {
      const events = (await eventsRes.json()) as Array<{
        event: string;
        actor: { login: string } | null;
        commit_id: string | null;
      }>;
      const closedEvent = [...events].reverse().find((e) => e.event === 'closed');
      if (closedEvent) {
        closedByMe = (closedEvent.actor?.login ?? '').toLowerCase() === currentLogin.toLowerCase();
        closedViaMergedPr = closedEvent.commit_id !== null && closedEvent.commit_id !== '';
      }
    }
    // Not closed by me and no direct merge-commit link: check whether the issue was
    // closed by someone else's PR that I collaborated on (authored/merged/committed).
    let closedViaCollabPr = false;
    if (!closedByMe && !closedViaMergedPr) {
      closedViaCollabPr = await issueClosedViaCollabPr(currentLogin, subjectUrl, headers);
    }
    return { state: 'closed', closedByMe, closedViaMergedPr, closedViaCollabPr };
  } catch {
    return null;
  }
}

/** Max merged PRs to inspect per issue when checking for user collaboration. */
const MAX_COLLAB_PRS_PER_ISSUE = 3;

async function issueClosedViaCollabPr(
  currentLogin: string,
  subjectUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const timelineRes = await fetch(`${subjectUrl}/timeline?per_page=100`, {
      headers: { ...headers, Accept: 'application/vnd.github.mockingbird-preview+json' },
    });
    if (!timelineRes.ok) return false;
    const timeline = (await timelineRes.json()) as Array<{
      event: string;
      source?: { issue?: { pull_request?: { url?: string; merged_at?: string | null } } };
    }>;
    const mergedPrUrls: string[] = [];
    for (const entry of timeline) {
      if (entry.event !== 'cross-referenced') continue;
      const pr = entry.source?.issue?.pull_request;
      if (pr?.merged_at && pr.url && !mergedPrUrls.includes(pr.url)) mergedPrUrls.push(pr.url);
      if (mergedPrUrls.length >= MAX_COLLAB_PRS_PER_ISSUE) break;
    }
    const myLogin = currentLogin.toLowerCase();
    for (const prUrl of mergedPrUrls) {
      if (await collaboratedOnPr(myLogin, prUrl, headers)) return true;
    }
  } catch { /* non-fatal */ }
  return false;
}

async function collaboratedOnPr(
  myLogin: string,
  prUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const prRes = await fetch(prUrl, { headers });
    if (!prRes.ok) return false;
    const pr = (await prRes.json()) as {
      merged: boolean;
      user: { login: string } | null;
      merged_by: { login: string } | null;
    };
    if (!pr.merged) return false;
    if ((pr.user?.login ?? '').toLowerCase() === myLogin) return true;
    if ((pr.merged_by?.login ?? '').toLowerCase() === myLogin) return true;

    const commitsRes = await fetch(`${prUrl}/commits?per_page=100`, { headers });
    if (!commitsRes.ok) return false;
    const commits = (await commitsRes.json()) as Array<{
      author: { login: string } | null;
      committer: { login: string } | null;
    }>;
    return commits.some(
      (c) =>
        (c.author?.login ?? '').toLowerCase() === myLogin ||
        (c.committer?.login ?? '').toLowerCase() === myLogin,
    );
  } catch {
    return false;
  }
}

function logAutoDismissEntries(db: SqlJsDatabase, entries: AutoDismissLogInput[]): void {
  if (entries.length === 0) return;
  const sql =
    `INSERT INTO auto_dismiss_log (notification_id, dismissed_at, reason, repo_full_name, subject_title, subject_type)
     VALUES (?, datetime('now'), ?, ?, ?, ?)`;
  for (const e of entries) {
    if (typeof e.notification_id !== 'string' || typeof e.reason !== 'string') continue;
    db.run(sql, [
      e.notification_id,
      e.reason,
      typeof e.repo_full_name === 'string' ? e.repo_full_name : null,
      typeof e.subject_title === 'string' ? e.subject_title : null,
      typeof e.subject_type === 'string' ? e.subject_type : null,
    ]);
  }
}

async function dismissStoredNotification(
  db: SqlJsDatabase,
  accessToken: string,
  n: { id: string },
): Promise<boolean> {
  try {
    await markNotificationRead(accessToken, n.id);
  } catch (err) {
    console.warn('[AutoDismiss] Could not mark notification as read on GitHub:', err instanceof Error ? err.message : String(err));
  }
  deleteNotification(db, n.id);
  return true;
}

async function runRecoverableStep(db: SqlJsDatabase, accessToken: string, repoFullNames: string[]): Promise<{ dismissed: number; logEntries: AutoDismissLogInput[] }> {
  const logEntries: AutoDismissLogInput[] = [];
  let dismissed = 0;
  for (const repoFullName of repoFullNames) {
    try {
      const notifs = listNotificationsForRepo(db, repoFullName);
      const ciNotifs = notifs.filter((n) => n.subject_type === 'CheckSuite' || n.subject_type === 'WorkflowRun');
      if (ciNotifs.length === 0) continue;

      let summary = getWorkflowSummaryForRepo(db, repoFullName);
      if (summary.total_runs === 0) {
        await fetchAndStoreWorkflowData(db, accessToken, repoFullName);
        summary = getWorkflowSummaryForRepo(db, repoFullName);
      }

      const byWorkflow = new Map<string, typeof ciNotifs>();
      for (const n of ciNotifs) {
        const name = n.subject_title.match(/^(.+?)\s+workflow\s+run/i)?.[1]?.trim() ?? n.subject_title;
        if (!byWorkflow.has(name)) byWorkflow.set(name, []);
        byWorkflow.get(name)!.push(n);
      }

      for (const [workflowName, wNotifs] of byWorkflow) {
        const branch = wNotifs[0].subject_title.match(/\bfor\s+(\S+)\s+branch\b/i)?.[1] ?? null;
        const latestNotifTime = Math.max(...wNotifs.map((n) => new Date(n.updated_at).getTime()));
        const recovered = summary.recent_runs.some(
          (r) =>
            r.workflow_name === workflowName &&
            (branch === null || r.head_branch === branch) &&
            r.conclusion === 'success' &&
            new Date(r.run_started_at).getTime() > latestNotifTime,
        );
        if (!recovered) continue;
        for (const n of wNotifs) {
          if (await dismissStoredNotification(db, accessToken, n)) {
            logEntries.push({ notification_id: n.id, reason: 'recovered_workflow', repo_full_name: repoFullName, subject_title: n.subject_title, subject_type: n.subject_type });
            dismissed++;
          }
        }
      }
    } catch { /* non-fatal per repo */ }
  }
  return { dismissed, logEntries };
}

async function runClosedPrStep(db: SqlJsDatabase, accessToken: string, currentLogin: string): Promise<{ dismissed: number; logEntries: AutoDismissLogInput[] }> {
  const logEntries: AutoDismissLogInput[] = [];
  let dismissed = 0;
  const byUrl = new Map<string, ReturnType<typeof listPrNotifications>>();
  for (const n of listPrNotifications(db)) {
    if (!n.subject_url) continue;
    if (!byUrl.has(n.subject_url)) byUrl.set(n.subject_url, []);
    byUrl.get(n.subject_url)!.push(n);
  }
  for (const [url, urlNotifs] of byUrl) {
    const result = await fetchPrState(accessToken, currentLogin, url);
    if (!result || result.state === 'open') continue;
    const { state, isDependabot, closedByMe } = result;
    if (!isDependabot && !closedByMe) continue;
    const reason: AutoDismissLogInput['reason'] = isDependabot ? 'closed_pr_dependabot' : state === 'merged' ? 'closed_pr_merged_me' : 'closed_pr_closed_me';
    for (const n of urlNotifs) {
      if (await dismissStoredNotification(db, accessToken, n)) {
        logEntries.push({ notification_id: n.id, reason, repo_full_name: n.repo_full_name, subject_title: n.subject_title, subject_type: n.subject_type });
        dismissed++;
      }
    }
  }
  return { dismissed, logEntries };
}

async function runClosedIssueStep(db: SqlJsDatabase, accessToken: string, currentLogin: string): Promise<{ dismissed: number; logEntries: AutoDismissLogInput[] }> {
  const logEntries: AutoDismissLogInput[] = [];
  let dismissed = 0;
  const byUrl = new Map<string, ReturnType<typeof listIssueNotifications>>();
  for (const n of listIssueNotifications(db)) {
    if (!n.subject_url) continue;
    if (!byUrl.has(n.subject_url)) byUrl.set(n.subject_url, []);
    byUrl.get(n.subject_url)!.push(n);
  }
  for (const [url, urlNotifs] of byUrl) {
    const result = await fetchIssueState(accessToken, currentLogin, url);
    if (!result || result.state !== 'closed') continue;
    const { closedByMe, closedViaMergedPr, closedViaCollabPr } = result;
    if (!closedByMe && !closedViaMergedPr && !closedViaCollabPr) continue;
    const reason: AutoDismissLogInput['reason'] = closedViaMergedPr
      ? 'closed_issue_via_pr'
      : closedByMe
        ? 'closed_issue_me'
        : 'closed_issue_collab_pr';
    for (const n of urlNotifs) {
      if (await dismissStoredNotification(db, accessToken, n)) {
        logEntries.push({ notification_id: n.id, reason, repo_full_name: n.repo_full_name, subject_title: n.subject_title, subject_type: n.subject_type });
        dismissed++;
      }
    }
  }
  return { dismissed, logEntries };
}

async function runDeletedBranchStep(db: SqlJsDatabase, accessToken: string): Promise<{ dismissed: number; logEntries: AutoDismissLogInput[] }> {
  const logEntries: AutoDismissLogInput[] = [];
  let dismissed = 0;
  const notifs = await listDeletedBranchNotifications(db, accessToken);
  for (const n of notifs) {
    if (await dismissStoredNotification(db, accessToken, n)) {
      logEntries.push({ notification_id: n.id, reason: 'deleted_branch', repo_full_name: n.repo_full_name, subject_title: n.subject_title, subject_type: n.subject_type });
      dismissed++;
    }
  }
  return { dismissed, logEntries };
}

export async function runAutoDismissSweep(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<AutoDismissSweepResult> {
  const auth = loadGitHubAuth(db);
  if (!auth) return { ok: true, skipped: true, reason: 'Not authenticated' };

  const counts = getNotificationCounts(db);
  const repoFullNames = Object.entries(counts.perRepo)
    .filter(([, count]) => count > 0)
    .map(([repo]) => repo);

  const [rec, pr, issue, delBranch] = await Promise.all([
    runRecoverableStep(db, auth.accessToken, repoFullNames),
    runClosedPrStep(db, auth.accessToken, auth.login),
    runClosedIssueStep(db, auth.accessToken, auth.login),
    runDeletedBranchStep(db, auth.accessToken),
  ]);

  const steps: AutoDismissStepResult[] = [
    { id: 'recovered-workflows', label: 'Recovered workflows', dismissed: rec.dismissed },
    { id: 'closed-prs', label: 'Closed / merged PRs', dismissed: pr.dismissed },
    { id: 'closed-issues', label: 'Closed issues', dismissed: issue.dismissed },
    { id: 'deleted-branches', label: 'Deleted branches', dismissed: delBranch.dismissed },
  ];
  const logEntries = [...rec.logEntries, ...pr.logEntries, ...issue.logEntries, ...delBranch.logEntries];
  logAutoDismissEntries(db, logEntries);
  if (logEntries.length > 0) saveDatabase();

  const result = { steps, total: steps.reduce((sum, step) => sum + step.dismissed, 0) };
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('github:auto-dismiss-complete', { result, logEntries });
    if (logEntries.length > 0) win.webContents.send('github:notification-counts-updated', getNotificationCounts(db));
  }
  return { ok: true, counts, result, logEntries };
}

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('github:fetch-notifications', async () => {
    try {
      const result = await syncGitHubNotifications(db, _getWindow);
      if (result.skipped) return { ok: false, error: result.error ?? 'Skipped' };
      return result.counts ?? getNotificationCounts(db);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('github:notification-counts', () => {
    return getNotificationCounts(db);
  });

  ipcMain.handle('github:fetch-notifications-for-owner', async (_event, owner: string) => {
    if (typeof owner !== 'string' || owner.length === 0) return { ok: false, error: 'Invalid owner' };
    const auth = loadGitHubAuth(db);
    if (!auth) return { ok: false, error: 'Not authenticated' };
    try {
      const notifications = await fetchNotifications(auth.accessToken);
      storeNotificationsForOwner(db, owner, notifications);
      saveDatabase();
      return getNotificationCounts(db);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('github:fetch-notifications-for-repo', async (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || !repoFullName.includes('/')) return { ok: false, error: 'Invalid repo' };
    const auth = loadGitHubAuth(db);
    if (!auth) return { ok: false, error: 'Not authenticated' };
    try {
      const notifications = await fetchNotificationsForRepo(auth.accessToken, repoFullName);
      storeNotificationsForRepo(db, repoFullName, notifications);
      saveDatabase();
      return getNotificationCounts(db);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('github:list-notifications-for-repo', (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || repoFullName.length === 0) return [];
    return listNotificationsForRepo(db, repoFullName);
  });

  ipcMain.handle('github:list-notifications-for-owner', (_event, owner: string) => {
    if (typeof owner !== 'string' || owner.length === 0) return [];
    return listNotificationsForOwner(db, owner);
  });

  ipcMain.handle('github:list-notifications-for-starred', () => {
    return listNotificationsForStarred(db);
  });

  ipcMain.handle('github:list-pr-notifications', () => {
    return listPrNotifications(db);
  });

  ipcMain.handle('github:list-issue-notifications', () => {
    return listIssueNotifications(db);
  });

  ipcMain.handle('github:dismiss-notification', async (_event, id: string) => {
    if (typeof id !== 'string' || id.length === 0) return;
    const auth = loadGitHubAuth(db);
    if (auth) {
      try {
        await markNotificationRead(auth.accessToken, id);
      } catch (err) {
        console.warn('[Jarvis] Could not mark notification as read on GitHub:', err);
      }
    }
    deleteNotification(db, id);
    saveDatabase();
  });

  ipcMain.handle('github:check-merged-dependabot-prs', async () => {
    const auth = loadGitHubAuth(db);
    if (!auth) return [];
    try {
      return await listMergedDependabotPRNotifications(db, auth.accessToken);
    } catch (err) {
      console.warn('[Jarvis] Could not check merged dependabot PRs:', err instanceof Error ? err.message : String(err));
      return [];
    }
  });

  ipcMain.handle('github:check-deleted-branches', async () => {
    const auth = loadGitHubAuth(db);
    if (!auth) return [];
    try {
      return await listDeletedBranchNotifications(db, auth.accessToken);
    } catch (err) {
      console.warn('[Jarvis] Could not check deleted branches:', err instanceof Error ? err.message : String(err));
      return [];
    }
  });

  // ── Auto-dismiss log IPC handlers ─────────────────────────────────────────

  ipcMain.handle('github:log-auto-dismiss', (_event, entries: AutoDismissLogInput[]) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const valid = entries.filter((e) => typeof e.notification_id === 'string' && typeof e.reason === 'string');
    logAutoDismissEntries(db, valid);
    saveDatabase();
  });

  ipcMain.handle('github:list-auto-dismiss-log', (_event, limit = 200) => {
    const safeLimit = typeof limit === 'number' && limit > 0 ? Math.min(limit, 1000) : 200;
    const result = db.exec(
      `SELECT id, notification_id, dismissed_at, reason, repo_full_name, subject_title, subject_type
       FROM auto_dismiss_log ORDER BY dismissed_at DESC LIMIT ?`,
      [safeLimit],
    );
    if (!result[0]) return [];
    const cols = result[0].columns;
    return result[0].values.map((row) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  });

  ipcMain.handle('github:auto-dismiss-stats', () => {
    const toRows = (res: ReturnType<typeof db.exec>) => {
      if (!res[0]) return [];
      return res[0].values.map((row) => ({ period: row[0] as string, count: row[1] as number }));
    };
    return {
      weekly: toRows(db.exec(
        `SELECT strftime('%Y-W%W', dismissed_at) as period, COUNT(*) as count
         FROM auto_dismiss_log GROUP BY period ORDER BY period DESC LIMIT 52`,
      )),
      monthly: toRows(db.exec(
        `SELECT strftime('%Y-%m', dismissed_at) as period, COUNT(*) as count
         FROM auto_dismiss_log GROUP BY period ORDER BY period DESC LIMIT 24`,
      )),
    };
  });
}

/**
 * On app boot, pre-warm the workflow run cache for every repo that has
 * CI-type notifications stored locally. This ensures the recovery check in
 * the UI can resolve immediately without a user-triggered fetch.
 */
export async function runBootWorkflowCheck(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const auth = loadGitHubAuth(db);
  if (!auth) return;

  // Find distinct repos with CheckSuite or WorkflowRun notifications
  const result = db.exec(
    `SELECT DISTINCT repo_full_name FROM github_notifications
     WHERE subject_type IN ('CheckSuite', 'WorkflowRun')`,
  );

  const allRepos: string[] = result[0]?.values.map((row) => row[0] as string) ?? [];
  if (allRepos.length === 0) return;

  // Feature 2: skip repos whose workflow data is already fresh (avoids burning rate
  // limit on rapid restarts, e.g. during agentic dev sessions with hot reload).
  const staleRepos = allRepos.filter((repo) => !isWorkflowDataFresh(db, repo));
  if (staleRepos.length === 0) {
    console.log('[Boot] Workflow cache is fresh for all CI repos — skipping pre-warm');
    return;
  }

  // Feature 1: when estimated API calls exceed the threshold AND the rate-limit
  // budget is below BOOT_CHECK_RATE_LIMIT_THRESHOLD, skip the pre-warm entirely.
  const estimatedCalls = staleRepos.length * BOOT_CHECK_ESTIMATED_CALLS_PER_REPO;
  if (estimatedCalls > BOOT_CHECK_MAX_ESTIMATED_CALLS) {
    const remaining = await fetchTokenRateLimitRemaining(auth.accessToken);
    if (remaining !== null && remaining < BOOT_CHECK_RATE_LIMIT_THRESHOLD) {
      console.log(
        `[Boot] Skipping workflow pre-warm: rate limit low (${remaining} remaining, ` +
        `threshold ${BOOT_CHECK_RATE_LIMIT_THRESHOLD}) and ~${estimatedCalls} calls needed ` +
        `for ${staleRepos.length} repo(s)`,
      );
      return;
    }
  }

  const sendStatus = (msg: string) => getWindow()?.webContents.send('app:background-status', msg);

  console.log(`[Boot] Pre-warming workflow cache for ${staleRepos.length} stale repo(s)…`);
  sendStatus(`Caching workflow data for ${staleRepos.length} repo${staleRepos.length !== 1 ? 's' : ''}…`);

  for (const repo of staleRepos) {
    try {
      sendStatus(`Loading workflow runs: ${repo.split('/')[1]}…`);
      const { runsStored } = await fetchAndStoreWorkflowData(db, auth.accessToken, repo);
      console.log(`[Boot] Cached ${runsStored} workflow run(s) for ${repo}`);
    } catch (err) {
      // Non-fatal — the UI will fall back to fetching on demand
      console.warn(`[Boot] Could not fetch workflow runs for ${repo}:`, err instanceof Error ? err.message : String(err));
    }
  }

  sendStatus('Workflow cache ready.');
  saveDatabase();
}
