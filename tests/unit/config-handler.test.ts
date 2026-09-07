/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Config plugin — IPC handler tests.
 *
 * Full-handler pattern: registers only the config handlers against a real
 * in-memory DB, then invokes captured handlers directly to verify:
 * - Onboarding status lookup
 * - System locale passthrough
 * - Preferences load/save + input validation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

// ── Track registered handlers ─────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  app: {
    isPackaged: false,
    getSystemLocale: vi.fn().mockReturnValue('en-US'),
    setLoginItemSettings: vi.fn(),
  },
}));

vi.mock('../../src/agent/onboarding', () => ({
  getOnboardingStatus: vi.fn().mockReturnValue({
    ollama: 'pending',
    local_repos: 'pending',
    github_oauth: 'pending',
  }),
}));

vi.mock('../../src/agent/config', () => ({
  loadConfig: vi.fn().mockReturnValue({
    electron: { openAtLogin: true, startMinimized: false },
    preferences: { sortByNotifications: true },
  }),
  saveConfig: vi.fn(),
}));

import { registerHandlers } from '../../src/plugins/config/handler';
import { getOnboardingStatus } from '../../src/agent/onboarding';
import { loadConfig, saveConfig } from '../../src/agent/config';
import { app } from 'electron';

// ── Helper ────────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Config plugin — IPC handlers', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-config-handler';
    vi.clearAllMocks();
    handlers.clear();
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
    vi.mocked(loadConfig).mockReturnValue({
      electron: { openAtLogin: true, startMinimized: false },
      preferences: { sortByNotifications: true },
    } as ReturnType<typeof loadConfig>);

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    registerHandlers(db, () => null);
  });

  afterEach(() => {
    db.close();
  });

  // ── onboarding:status ─────────────────────────────────────────────────────

  describe('onboarding:status', () => {
    it('delegates to getOnboardingStatus', () => {
      const result = callHandler('onboarding:status');
      expect(getOnboardingStatus).toHaveBeenCalledWith(db);
      expect(result).toEqual({
        ollama: 'pending',
        local_repos: 'pending',
        github_oauth: 'pending',
      });
    });

    it('returns an error object when the service throws', () => {
      vi.mocked(getOnboardingStatus).mockImplementationOnce(() => {
        throw new Error('db error');
      });
      const result = callHandler('onboarding:status') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });

  // ── app:get-system-locale ─────────────────────────────────────────────────

  describe('app:get-system-locale', () => {
    it('returns the system locale from electron', () => {
      const result = callHandler('app:get-system-locale');
      expect(app.getSystemLocale).toHaveBeenCalled();
      expect(result).toBe('en-US');
    });
  });

  // ── app:get-preferences ───────────────────────────────────────────────────

  describe('app:get-preferences', () => {
    it('returns preferences from the config file', () => {
      const result = callHandler('app:get-preferences');
      expect(loadConfig).toHaveBeenCalled();
      expect(result).toEqual({ sortByNotifications: true });
    });

    it('returns an error object when loadConfig throws', () => {
      vi.mocked(loadConfig).mockImplementationOnce(() => {
        throw new Error('read error');
      });
      const result = callHandler('app:get-preferences') as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });

  // ── app startup settings ──────────────────────────────────────────────────

  describe('app startup settings', () => {
    it('returns startup settings and reports that development cannot register at login', () => {
      expect(callHandler('app:get-startup-settings')).toEqual({
        openAtLogin: true,
        startMinimized: false,
        canRegisterAtLogin: false,
      });
    });

    it('rejects invalid startup settings', () => {
      expect(callHandler('app:set-startup-settings', { openAtLogin: true })).toEqual({
        ok: false,
        error: 'Invalid startup settings',
      });
    });

    it('saves startup settings without registering development Electron', () => {
      const result = callHandler('app:set-startup-settings', {
        openAtLogin: false,
        startMinimized: true,
      });

      expect(result).toEqual({ ok: true, canRegisterAtLogin: false });
      expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
        electron: { openAtLogin: false, startMinimized: true },
      }));
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    });

    it('updates Windows login registration for the packaged app', () => {
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });

      const result = callHandler('app:set-startup-settings', {
        openAtLogin: true,
        startMinimized: true,
      });

      expect(result).toEqual({ ok: true, canRegisterAtLogin: true });
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({
        openAtLogin: true,
        args: ['--hidden'],
      });
    });
  });

  // ── app:set-preferences ───────────────────────────────────────────────────

  describe('app:set-preferences', () => {
    it('returns an error for a null prefs value', () => {
      const result = callHandler('app:set-preferences', null);
      expect(result).toEqual({ ok: false, error: 'Invalid preferences' });
    });

    it('returns an error for a non-object prefs value', () => {
      const result = callHandler('app:set-preferences', 'nope');
      expect(result).toEqual({ ok: false, error: 'Invalid preferences' });
    });

    it('returns an error for an array prefs value', () => {
      const result = callHandler('app:set-preferences', []);
      expect(result).toEqual({ ok: false, error: 'Invalid preferences' });
    });

    it('merges preferences and saves the config', () => {
      const result = callHandler('app:set-preferences', { localSortByNotifs: true });
      expect(result).toEqual({ ok: true });
      expect(saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({
            sortByNotifications: true,
            localSortByNotifs: true,
          }),
        }),
      );
    });

    it('returns an error object when saveConfig throws', () => {
      vi.mocked(saveConfig).mockImplementationOnce(() => {
        throw new Error('write error');
      });
      const result = callHandler('app:set-preferences', { localSortByNotifs: true }) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    });
  });
});
