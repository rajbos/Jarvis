// ── Orgs IPC handlers ─────────────────────────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { listOrgs, setOrgDiscoveryEnabled, approveLargeOrg } from '../../services/github-discovery';
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

  // Orgs with more than 500 repos are skipped by discovery until approved here.
  // The next discovery run picks the org up.
  safeHandle('github:approve-large-org', (_event, orgLogin: string, approved: boolean) => {
    if (typeof orgLogin !== 'string' || orgLogin.length === 0) return { ok: false, error: 'Invalid orgLogin' };
    if (typeof approved !== 'boolean') return { ok: false, error: 'Invalid approved value' };
    approveLargeOrg(db, orgLogin, approved);
    saveDatabase();
    return { ok: true };
  });
}
