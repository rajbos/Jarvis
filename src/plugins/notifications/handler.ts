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
  deleteNotification,
  markNotificationRead,
} from '../../services/github-notifications';
import { loadGitHubAuth } from '../../services/github-oauth';
import { saveDatabase } from '../../storage/database';
import { fetchAndStoreWorkflowData } from '../../services/github-workflows';

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
}

/**
 * On app boot, pre-warm the workflow run cache for every repo that has
 * CI-type notifications stored locally. This ensures the recovery check in
 * the UI can resolve immediately without a user-triggered fetch.
 */
export async function runBootWorkflowCheck(db: SqlJsDatabase): Promise<void> {
  const auth = loadGitHubAuth(db);
  if (!auth) return;

  // Find distinct repos with CheckSuite or WorkflowRun notifications
  const result = db.exec(
    `SELECT DISTINCT repo_full_name FROM github_notifications
     WHERE subject_type IN ('CheckSuite', 'WorkflowRun')`,
  );

  const repos: string[] = result[0]?.values.map((row) => row[0] as string) ?? [];
  if (repos.length === 0) return;

  console.log(`[Boot] Pre-warming workflow cache for ${repos.length} repo(s) with CI notifications…`);

  for (const repo of repos) {
    try {
      const { runsStored } = await fetchAndStoreWorkflowData(db, auth.accessToken, repo);
      console.log(`[Boot] Cached ${runsStored} workflow run(s) for ${repo}`);
    } catch (err) {
      // Non-fatal — the UI will fall back to fetching on demand
      console.warn(`[Boot] Could not fetch workflow runs for ${repo}:`, err instanceof Error ? err.message : String(err));
    }
  }

  saveDatabase();
}
