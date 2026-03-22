// ── Config & onboarding IPC handlers ─────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { getOnboardingStatus } from '../../agent/onboarding';
import { loadConfig, saveConfig } from '../../agent/config';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('onboarding:status', () => {
    return getOnboardingStatus(db);
  });

  ipcMain.handle('app:get-preferences', () => {
    return loadConfig().preferences;
  });

  ipcMain.handle('app:set-preferences', (_event, prefs: Partial<{ sortByNotifications: boolean; localSortByNotifs: boolean; localRepoSortKey: 'name' | 'scanned' | 'notifs' }>) => {
    if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) return { ok: false, error: 'Invalid preferences' };
    const config = loadConfig();
    config.preferences = { ...config.preferences, ...prefs };
    saveConfig(config);
    return { ok: true };
  });
}
