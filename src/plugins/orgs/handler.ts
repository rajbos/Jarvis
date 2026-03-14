// ── Orgs IPC handlers ─────────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { listOrgs, setOrgDiscoveryEnabled } from '../../services/github-discovery';
import { saveDatabase } from '../../storage/database';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('github:list-orgs', () => {
    return listOrgs(db);
  });

  ipcMain.handle('github:set-org-enabled', (_event, orgLogin: string, enabled: boolean) => {
    setOrgDiscoveryEnabled(db, orgLogin, enabled);
    saveDatabase();
    return { ok: true };
  });
}
