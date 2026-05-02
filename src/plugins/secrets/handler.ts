// ── Secrets IPC handlers ──────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { loadGitHubAuth, loadGitHubPat } from '../../services/github-oauth';
import {
  scanUserRepoSecrets,
  listSecretsForRepo,
  searchSecrets,
  listSecretFavorites,
  addSecretFavorite,
  removeSecretFavorite,
} from '../../services/github-secrets';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('secrets:scan', async () => {
    const auth = loadGitHubAuth(db);
    if (!auth) return { error: 'Not authenticated with GitHub' };

    const pat = loadGitHubPat(db);

    try {
      const result = await scanUserRepoSecrets(
        db,
        auth.accessToken,
        auth.login,
        (done, total, secretsFound) => {
          _getWindow()?.webContents.send('secrets:scan-progress', { done, total, secretsFound });
        },
        pat ?? undefined,
      );
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('secrets:list-for-repo', (_event, repoFullName: string) => {
    if (typeof repoFullName !== 'string' || repoFullName.length === 0) return { ok: false, error: 'Invalid repoFullName' };
    try {
      return listSecretsForRepo(db, repoFullName);
    } catch (err) {
      console.error('[IPC] secrets:list-for-repo failed:', err);
      return [];
    }
  });

  ipcMain.handle('secrets:list-all', () => {
    try {
      return searchSecrets(db, '');
    } catch (err) {
      console.error('[IPC] secrets:list-all failed:', err);
      return [];
    }
  });

  ipcMain.handle('secrets:list-favorites', () => {
    try {
      return listSecretFavorites(db);
    } catch (err) {
      console.error('[IPC] secrets:list-favorites failed:', err);
      return [];
    }
  });

  ipcMain.handle('secrets:add-favorite', (_event, targetType: 'org' | 'repo', targetName: string) => {
    if (targetType !== 'org' && targetType !== 'repo') return { ok: false, error: 'Invalid targetType' };
    if (typeof targetName !== 'string' || targetName.length === 0) return { ok: false, error: 'Invalid targetName' };
    try {
      addSecretFavorite(db, targetType, targetName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('secrets:remove-favorite', (_event, targetName: string) => {
    if (typeof targetName !== 'string' || targetName.length === 0) return { ok: false, error: 'Invalid targetName' };
    try {
      removeSecretFavorite(db, targetName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
