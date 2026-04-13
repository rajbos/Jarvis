// ── Orgs IPC handlers ─────────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { listOrgs, setOrgDiscoveryEnabled } from '../../services/github-discovery';
import { saveDatabase } from '../../storage/database';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('github:list-orgs', () => {
    try {
      return listOrgs(db);
    } catch (err) {
      console.error('[IPC] github:list-orgs failed:', err);
      return [];
    }
  });

  ipcMain.handle('github:set-org-enabled', (_event, orgLogin: string, enabled: boolean) => {
    if (typeof orgLogin !== 'string' || orgLogin.length === 0) return { ok: false, error: 'Invalid orgLogin' };
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Invalid enabled value' };
    try {
      setOrgDiscoveryEnabled(db, orgLogin, enabled);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
