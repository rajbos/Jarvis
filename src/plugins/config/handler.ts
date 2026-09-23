// ── Config & onboarding IPC handlers ─────────────────────────────────────────
import { app } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { loadConfig, saveConfig } from '../../agent/config';
import { getAboutInfo } from '../../services/about';
import { safeHandle } from '../ipc-utils';

export function registerHandlers(_db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  safeHandle('app:get-system-locale', () => app.getSystemLocale());

  safeHandle('app:get-about-info', async () => {
    return await getAboutInfo();
  });

  safeHandle('app:get-preferences', () => {
    return loadConfig().preferences;
  });

  safeHandle('app:get-startup-settings', () => {
    return { ...loadConfig().electron, canRegisterAtLogin: app.isPackaged };
  });

  safeHandle('app:set-startup-settings', (_event, settings: unknown) => {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return { ok: false, error: 'Invalid startup settings' };
    }

    const candidate = settings as Record<string, unknown>;
    if (typeof candidate.openAtLogin !== 'boolean' || typeof candidate.startMinimized !== 'boolean') {
      return { ok: false, error: 'Invalid startup settings' };
    }

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
  });

  safeHandle('app:set-preferences', (_event, prefs: Partial<{
    sortByNotifications: boolean;
    localSortByNotifs: boolean;
    localRepoSortKey: 'name' | 'scanned' | 'notifs';
    dashboardDefaultFilter: 'all' | 'healthy' | 'warnings' | 'notifications' | 'human-notifications' | 'failed-runs';
    dashboardSortMode: 'attention' | 'local-activity' | 'remote-activity';
    dashboardNotifSort: 'count' | 'name';
  }>) => {
    if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) return { ok: false, error: 'Invalid preferences' };
    const config = loadConfig();
    config.preferences = { ...config.preferences, ...prefs };
    saveConfig(config);
    return { ok: true };
  });
}
