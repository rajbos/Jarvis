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
} from '../../services/github-notifications';
import { loadGitHubAuth } from '../../services/github-oauth';
import { saveDatabase } from '../../storage/database';

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
}
