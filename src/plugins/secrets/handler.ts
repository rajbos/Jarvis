// ── Secrets IPC handlers ──────────────────────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { loadGitHubPat } from '../../services/github-oauth';
import { accessForPrimary } from '../../services/github-repo-access';
import {
  runSecretsBatch,
  setOrgSecretScan,
  searchSecrets,
  listSecretFavorites,
  addSecretFavorite,
  removeSecretFavorite,
} from '../../services/github-secrets';
import { safeHandle } from '../ipc-utils';

/** "Scan Now" takes a bigger bite than the background trickle; the trickle does the rest. */
const MANUAL_SCAN_BATCH_SIZE = 100;

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  // Intentionally kept custom catch/early-return shape (`{ error }`, not `{ ok: false, error }`):
  // the renderer's secrets scan UI checks `result.error` directly.
  safeHandle('secrets:scan', async () => {
    const auth = await accessForPrimary(db);
    if (!auth) return { error: 'Not authenticated with GitHub' };

    const pat = loadGitHubPat(db);

    try {
      const result = await runSecretsBatch(db, {
        batchSize: MANUAL_SCAN_BATCH_SIZE,
        ownerLogin: auth.login,
        patToken: pat,
        onProgress: (done, total, secretsFound) => {
          _getWindow()?.webContents.send('secrets:scan-progress', { done, total, secretsFound });
        },
      });
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // enabled: true = always scan the org's repos, false = never, null = automatic (small orgs only)
  safeHandle('secrets:set-org-scan', (_event, orgLogin: string, enabled: boolean | null) => {
    if (typeof orgLogin !== 'string' || orgLogin.length === 0) return { ok: false, error: 'Invalid orgLogin' };
    if (enabled !== null && typeof enabled !== 'boolean') return { ok: false, error: 'Invalid enabled value' };
    setOrgSecretScan(db, orgLogin, enabled);
    return { ok: true };
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
