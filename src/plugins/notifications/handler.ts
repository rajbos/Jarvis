// ── Notifications IPC handlers ────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
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
} from '../../services/github-notifications';
import { loadGitHubAuth } from '../../services/github-oauth';
import { saveDatabase } from '../../storage/database';
import { fetchAndStoreWorkflowData } from '../../services/github-workflows';

// ── Boot workflow check constants ─────────────────────────────────────────────

/** Workflow cache is considered fresh if fetched within this window. */
const WORKFLOW_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/** When rate limit remaining is below this value, check estimated call count. */
const BOOT_CHECK_RATE_LIMIT_THRESHOLD = 1000;

/** Skip boot pre-warm if estimated API calls exceed this when rate limit is low. */
const BOOT_CHECK_MAX_ESTIMATED_CALLS = 50;

/** Conservative per-repo estimate: 1 runs page + up to 5 failing-run details. */
const BOOT_CHECK_ESTIMATED_CALLS_PER_REPO = 10;

/**
 * Returns true if workflow run data for the given repo was fetched recently
 * (within WORKFLOW_CACHE_MAX_AGE_MS). Avoids redundant API calls on rapid
 * restarts (e.g. during agentic dev sessions with hot reload).
 */
export function isWorkflowDataFresh(db: SqlJsDatabase, repoFullName: string): boolean {
  const result = db.exec(
    `SELECT MAX(fetched_at) FROM github_workflow_runs WHERE repo_full_name = ?`,
    [repoFullName],
  );
  const raw = result[0]?.values[0]?.[0] as string | null | undefined;
  if (!raw) return false;
  // SQLite datetime('now') stores UTC without 'Z' suffix — append it before parsing.
  const fetchedAt = new Date(raw.includes('T') ? raw : raw + 'Z');
  return Date.now() - fetchedAt.getTime() < WORKFLOW_CACHE_MAX_AGE_MS;
}

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

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('github:fetch-notifications', async () => {
    const auth = loadGitHubAuth(db);
    if (!auth) return { error: 'Not authenticated' };
    try {
      const notifications = await fetchNotifications(auth.accessToken);
      storeNotifications(db, notifications);
      saveDatabase();
      return getNotificationCounts(db);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('github:notification-counts', () => {
    return getNotificationCounts(db);
  });

  ipcMain.handle('github:fetch-notifications-for-owner', async (_event, owner: string) => {
    if (typeof owner !== 'string' || owner.length === 0) return { error: 'Invalid owner' };
    const auth = loadGitHubAuth(db);
    if (!auth) return { error: 'Not authenticated' };
    try {
      const notifications = await fetchNotifications(auth.accessToken);
      storeNotificationsForOwner(db, owner, notifications);
      saveDatabase();
      return getNotificationCounts(db);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('github:fetch-notifications-for-repo', async (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || !repoFullName.includes('/')) return { error: 'Invalid repo' };
    const auth = loadGitHubAuth(db);
    if (!auth) return { error: 'Not authenticated' };
    try {
      const notifications = await fetchNotificationsForRepo(auth.accessToken, repoFullName);
      storeNotificationsForRepo(db, repoFullName, notifications);
      saveDatabase();
      return getNotificationCounts(db);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
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
