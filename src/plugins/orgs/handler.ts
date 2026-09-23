// ── Orgs IPC handlers ─────────────────────────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { listOrgs, setOrgDiscoveryEnabled } from '../../services/github-discovery';
import { saveDatabase } from '../../storage/database';
import { safeHandle } from '../ipc-utils';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  safeHandle('github:list-orgs', () => {
    return listOrgs(db);
  });

  safeHandle('github:set-org-enabled', (_event, orgLogin: string, enabled: boolean) => {
    if (typeof orgLogin !== 'string' || orgLogin.length === 0) return { ok: false, error: 'Invalid orgLogin' };
    if (typeof enabled !== 'boolean') return { ok: false, error: 'Invalid enabled value' };
    setOrgDiscoveryEnabled(db, orgLogin, enabled);
    saveDatabase();
    return { ok: true };
  });
}
