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
  app: { isPackaged: false },
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
  'app:get-system-locale',
  'app:get-about-info',
  'app:get-preferences',
  'app:set-preferences',
  'app:get-startup-settings',
  'app:set-startup-settings',
  // ollama plugin
  'ollama:status',
  'ollama:get-selected-model',
  'ollama:set-selected-model',
  // chat plugin
  'chat:send',
  'chat:abort',
  // github-auth plugin
  'github:oauth-status',
  'github:open-url',
  'github:get-run-url-for-check-suite',
  'github:get-issue-state',
  'github:save-pat',
  'github:delete-pat',
  'github:logout',
  'github:pat-status',
  'github:start-oauth-discovery',
  'github:start-oauth',
  'github:get-rate-limit',
  // claude plugin
  'claude:status',
  'claude:rate-limit',
  'claude:disconnect',
  'claude:begin-oauth',
  'claude:complete-oauth',
  // discovery plugin
  'github:discovery-status',
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
  'github:list-auto-dismiss-log',
  'github:auto-dismiss-stats',
  // local-repos plugin
  'local:get-folders',
  'local:add-folder',
  'local:remove-folder',
  'local:get-scan-status',
  'local:start-scan',
  'local:get-index-status',
  'local:start-index',
  'local:list-repos',
  'local:list-repos-for-folder',
  'local:open-folder',
  'local:open-terminal',
  // mcp-server plugin
  'mcp:get-client-config',
  // agents plugin
  'agents:list',
  'agents:update',
  'agents:run',
  'agents:get-session',
  'agents:approve-finding',
  'agents:reject-finding',
  'agents:execute-finding',
  'agents:escalation-readiness',
  'agents:escalate',
  'agents:check-copilot-availability',
  // workflow data (agents plugin)
  'github:fetch-workflow-runs',
  'github:get-workflow-summary',
  'github:get-cached-workflow-info',
  // secrets plugin
  'secrets:scan',
  'secrets:list-all',
  'secrets:list-favorites',
  'secrets:add-favorite',
  'secrets:remove-favorite',
  // dashboard plugin
  'dashboard:get-summary',
  'dashboard:push-branch-upstream',
  // groups plugin
  'groups:list',
  'groups:get',
  'groups:create',
  'groups:rename',
  'groups:delete',
  'groups:add-local-repo',
  'groups:remove-local-repo',
  'groups:remove-github-repo',
  'groups:find-ruddr-projects',
  'groups:set-ruddr-project',
  'groups:remove-ruddr-project',
  'groups:refresh-ruddr-cache',
  'groups:get-ruddr-cache',
  'groups:get-ruddr-workspace',
  'groups:set-ruddr-workspace',
  'groups:get-ruddr-budget',
  'groups:get-ruddr-budget-cache',
  'groups:sync-ruddr-cache-now',
  'groups:get-ruddr-project-info',
  'groups:list-ruddr-projects',
  // onedrive plugin
  'onedrive:list-roots',
  'onedrive:browse-folder',
  'onedrive:add-root',
  'onedrive:remove-root',
  'onedrive:discover-for-group',
  'onedrive:rescan-files',
  'onedrive:list-files-for-folder',
  'onedrive:read-onenote-file',
  'onedrive:read-url-shortcut',
  'onedrive:cache-onenote-files-for-group',
  'onedrive:get-onenote-cache-for-group',
  'shell:open-url',
  // browser-companion plugin
  'browser:status',
  'browser:get-token',
  'browser:regenerate-token',
  'browser:list-skills',
  'browser:create-skill',
  'browser:update-skill',
  'browser:delete-skill',
  'browser:list-runs',
  'browser:run-skill',
  'browser:focus-window',
  // active agent sessions / PR readiness
  'active-sessions:get',
  'active-sessions:refresh',
  // background tasks
  'tasks:list',
  'tasks:run-now',
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
