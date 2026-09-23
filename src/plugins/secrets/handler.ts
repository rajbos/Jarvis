// ── Secrets IPC handlers ──────────────────────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { loadGitHubAuth, loadGitHubPat } from '../../services/github-oauth';
import {
  scanUserRepoSecrets,
  searchSecrets,
  listSecretFavorites,
  addSecretFavorite,
  removeSecretFavorite,
} from '../../services/github-secrets';
import { safeHandle } from '../ipc-utils';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  // Intentionally kept custom catch/early-return shape (`{ error }`, not `{ ok: false, error }`):
  // the renderer's secrets scan UI checks `result.error` directly.
  safeHandle('secrets:scan', async () => {
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

  safeHandle('secrets:list-all', () => {
    return searchSecrets(db, '');
  });

  safeHandle('secrets:list-favorites', () => {
    return listSecretFavorites(db);
  });

  safeHandle('secrets:add-favorite', (_event, targetType: 'org' | 'repo', targetName: string) => {
    if (targetType !== 'org' && targetType !== 'repo') return { ok: false, error: 'Invalid targetType' };
    if (typeof targetName !== 'string' || targetName.length === 0) return { ok: false, error: 'Invalid targetName' };
    addSecretFavorite(db, targetType, targetName);
    return { ok: true };
  });

  safeHandle('secrets:remove-favorite', (_event, targetName: string) => {
    if (typeof targetName !== 'string' || targetName.length === 0) return { ok: false, error: 'Invalid targetName' };
    removeSecretFavorite(db, targetName);
    return { ok: true };
  });
}
