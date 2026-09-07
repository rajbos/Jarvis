// ── Config & onboarding IPC handlers ─────────────────────────────────────────
import { ipcMain, app } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { getOnboardingStatus } from '../../agent/onboarding';
import { loadConfig, saveConfig } from '../../agent/config';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('onboarding:status', () => {
    try {
      return getOnboardingStatus(db);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('app:get-system-locale', () => app.getSystemLocale());

  ipcMain.handle('app:get-preferences', () => {
    try {
      return loadConfig().preferences;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('app:get-startup-settings', () => {
    try {
      return { ...loadConfig().electron, canRegisterAtLogin: app.isPackaged };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('app:set-startup-settings', (_event, settings: unknown) => {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return { ok: false, error: 'Invalid startup settings' };
    }

    const candidate = settings as Record<string, unknown>;
    if (typeof candidate.openAtLogin !== 'boolean' || typeof candidate.startMinimized !== 'boolean') {
      return { ok: false, error: 'Invalid startup settings' };
    }

    try {
      const config = loadConfig();
      config.electron = {
        openAtLogin: candidate.openAtLogin,
        startMinimized: candidate.startMinimized,
      };
      saveConfig(config);

      if (app.isPackaged) {
        app.setLoginItemSettings({
          openAtLogin: config.electron.openAtLogin,
          args: ['--hidden'],
        });
      }

      return { ok: true, canRegisterAtLogin: app.isPackaged };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('app:set-preferences', (_event, prefs: Partial<{
    sortByNotifications: boolean;
    localSortByNotifs: boolean;
    localRepoSortKey: 'name' | 'scanned' | 'notifs';
    dashboardDefaultFilter: 'all' | 'healthy' | 'warnings' | 'notifications' | 'human-notifications' | 'failed-runs';
    dashboardSortMode: 'attention' | 'local-activity' | 'remote-activity';
    dashboardNotifSort: 'count' | 'name';
  }>) => {
    if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) return { ok: false, error: 'Invalid preferences' };
    try {
      const config = loadConfig();
      config.preferences = { ...config.preferences, ...prefs };
      saveConfig(config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
