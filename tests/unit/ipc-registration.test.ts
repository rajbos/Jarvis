/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * IPC registration integration test.
 *
 * Verifies that all expected IPC channels are registered when
 * registerIpcHandlers() is called, by mocking electron's ipcMain.
 *
 * This catches regressions where someone renames a channel or forgets to
 * wire up a new plugin in the main ipc-handlers.ts shell.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

// ── Mock electron before importing any plugin handlers ────────────────────────
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
}));

// Mock saveDatabase so no file I/O happens
vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

import { registerIpcHandlers } from '../../src/main/ipc-handlers';
import { ipcMain } from 'electron';

// ── Expected IPC channel catalogue ───────────────────────────────────────────
// Add new channels here as new plugins are created.
const EXPECTED_CHANNELS = [
  // config plugin
  'onboarding:status',
  'app:get-preferences',
  'app:set-preferences',
  // ollama plugin
  'ollama:status',
  'ollama:list-models',
  'ollama:get-selected-model',
  'ollama:set-selected-model',
  // chat plugin
  'chat:send',
  'chat:abort',
  'window:adjust-width',
  // github-auth plugin
  'github:oauth-status',
  'github:open-url',
  'github:get-run-url-for-check-suite',
  'github:save-pat',
  'github:delete-pat',
  'github:logout',
  'github:pat-status',
  'github:start-oauth-discovery',
  'github:start-oauth',
  // discovery plugin
  'github:discovery-status',
  'github:start-discovery',
  'github:start-pat-discovery',
  // orgs plugin
  'github:list-orgs',
  'github:set-org-enabled',
  // repos plugin
  'github:search-repos',
  'github:list-repos-for-org',
  'github:list-starred',
  // notifications plugin
  'github:fetch-notifications',
  'github:notification-counts',
  'github:fetch-notifications-for-owner',
  'github:fetch-notifications-for-repo',
  'github:list-notifications-for-repo',
  'github:list-notifications-for-owner',
  'github:list-notifications-for-starred',
  'github:dismiss-notification',
  // local-repos plugin
  'local:get-folders',
  'local:add-folder',
  'local:remove-folder',
  'local:get-scan-status',
  'local:start-scan',
  'local:list-repos',
  'local:list-repos-for-folder',
  'local:link-repo',
  'local:open-folder',
  // agents plugin
  'agents:list',
  'agents:update',
  'agents:run',
  'agents:get-session',
  'agents:approve-finding',
  'agents:reject-finding',
  'agents:execute-finding',
  // workflow data (agents plugin)
  'github:fetch-workflow-runs',
  'github:get-workflow-summary',
  'github:get-cached-workflow-info',
  // secrets plugin
  'secrets:scan',
  'secrets:list-for-repo',
  'secrets:list-all',
  'secrets:list-favorites',
  'secrets:add-favorite',
  'secrets:remove-favorite',
] as const;

describe('IPC handler registration', () => {
  let db: SqlJsDatabase;
  let registeredChannels: string[];

  beforeEach(async () => {
    process.env.JARVIS_ENCRYPTION_KEY = 'test-encryption-key-ipc-reg';
    vi.clearAllMocks();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());

    const getWindow = () => null;
    registerIpcHandlers(db, getWindow);

    // Collect every channel name passed to ipcMain.handle()
    registeredChannels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
  });

  it('registers all expected IPC channels', () => {
    for (const channel of EXPECTED_CHANNELS) {
      expect(
        registeredChannels,
        `Expected IPC channel "${channel}" to be registered`,
      ).toContain(channel);
    }
  });

  it('registers no duplicate channels', () => {
    const unique = new Set(registeredChannels);
    expect(registeredChannels.length).toBe(unique.size);
  });

  it('total registration count matches expected catalogue', () => {
    expect(registeredChannels.length).toBe(EXPECTED_CHANNELS.length);
  });
});
