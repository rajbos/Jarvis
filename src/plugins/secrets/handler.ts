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
    const token = pat ?? auth.accessToken;

    try {
      const result = await scanUserRepoSecrets(db, token, auth.login, (done, total, secretsFound) => {
        _getWindow()?.webContents.send('secrets:scan-progress', { done, total, secretsFound });
      });
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('secrets:list-for-repo', (_event, repoFullName: string) => {
    return listSecretsForRepo(db, repoFullName);
  });

  ipcMain.handle('secrets:list-all', () => {
    return searchSecrets(db, '');
  });

  ipcMain.handle('secrets:list-favorites', () => {
    return listSecretFavorites(db);
  });

  ipcMain.handle('secrets:add-favorite', (_event, targetType: 'org' | 'repo', targetName: string) => {
    addSecretFavorite(db, targetType, targetName);
    return { ok: true };
  });

  ipcMain.handle('secrets:remove-favorite', (_event, targetName: string) => {
    removeSecretFavorite(db, targetName);
    return { ok: true };
  });
}
