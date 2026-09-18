/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Groups plugin — Ruddr budget cache IPC tests.
 *
 * Covers the "open with what we already have" behaviour: budgets are persisted
 * across restarts, served from cache while inside the TTL window, and only
 * re-scraped once the window expires or the user forces a refresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { saveRuddrBudgetToDb, saveRuddrProjectsToDb } from '../../src/services/groups';

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
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/plugins/browser-companion/server', () => ({
  getBridgeStatus: vi.fn(),
  sendCommand: vi.fn(),
}));

type BridgeModule = typeof import('../../src/plugins/browser-companion/server');

// ── Helpers ───────────────────────────────────────────────────────────────────

function callHandler(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1, send: vi.fn(), isDestroyed: () => false } };
  return handler(fakeEvent, ...args);
}

/** Scrape payload the browser extension returns for a project overview page. */
const SCRAPED_STATS = {
  'Actual Billable Hours': '20',
  'Actual Non-Billable Hours': '1',
  'Actual Total Hours': '21',
  'Budget': '100',
  'Budget Left': '79',
  'Notes': 'fresh note',
  '_cloud_folder_url': 'https://example.com/fresh',
};

describe('Groups plugin — Ruddr budget cache', () => {
  let db: SqlJsDatabase;
  let bridge: BridgeModule;

  beforeEach(async () => {
    // Reset modules so the handler's in-memory caches start empty per test.
    vi.resetModules();
    vi.clearAllMocks();
    handlers.clear();

    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    db.run("INSERT INTO config (key, value) VALUES ('ruddr_workspace', 'test-workspace')");
    saveRuddrProjectsToDb(db, [{ name: 'Project A', path: '/app/test-workspace/portfolio/projects/a' }]);

    bridge = await import('../../src/plugins/browser-companion/server');
    vi.mocked(bridge.getBridgeStatus).mockReturnValue({ running: true, port: 35789, connectedClients: 1 });
    vi.mocked(bridge.sendCommand).mockImplementation(async (command: { type: string }) => {
      if (command.type === 'navigate') return { ok: true, data: { url: 'https://www.ruddr.io/overview', tabId: 7 } };
      if (command.type === 'scrape-stats') return { ok: true, data: SCRAPED_STATS };
      return { ok: true, data: null };
    });
  });

  /**
   * Registers the handlers against the current DB. Called after each test has
   * written its rows, mirroring startup order (DB first, then handlers seed
   * their in-memory cache from it).
   */
  async function register(): Promise<void> {
    handlers.clear();
    const { registerHandlers } = await import('../../src/plugins/groups/handler');
    registerHandlers(db, () => null);
  }

  afterEach(() => {
    db.close();
  });

  it('serves a persisted budget without scraping while inside the TTL window', async () => {
    saveRuddrBudgetToDb(db, {
      projectName: 'Project A',
      actualBillableHours: '10', actualNonBillableHours: '0', actualTotalHours: '10',
      budget: '100', budgetLeft: '90',
      projectUrl: 'https://www.ruddr.io/app/test-workspace/portfolio/projects/a/overview',
      note: 'cached note', cloudFolderUrl: 'https://example.com/a',
    });

    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A') as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.budgetLeft).toBe('90');
    expect(result.cached).toBe(true);
    expect(result.stale).toBe(false);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it('re-scrapes and persists once the cached budget is older than the TTL', async () => {
    saveRuddrBudgetToDb(db, {
      projectName: 'Project A',
      actualBillableHours: '10', actualNonBillableHours: '0', actualTotalHours: '10',
      budget: '100', budgetLeft: '90', projectUrl: '/a', note: null, cloudFolderUrl: null,
    });
    db.run("UPDATE ruddr_budgets SET fetched_at = datetime('now', '-10 hours')");

    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A') as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.budgetLeft).toBe('79');
    expect(result.stale).toBe(false);
    expect(bridge.sendCommand).toHaveBeenCalled();

    const stored = db.exec('SELECT budget_left FROM ruddr_budgets');
    expect(stored[0].values[0][0]).toBe('79');
  });

  it('re-scrapes when the caller forces a refresh even though the cache is fresh', async () => {
    saveRuddrBudgetToDb(db, {
      projectName: 'Project A',
      actualBillableHours: '10', actualNonBillableHours: '0', actualTotalHours: '10',
      budget: '100', budgetLeft: '90', projectUrl: '/a', note: null, cloudFolderUrl: null,
    });

    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A', { force: true }) as Record<string, unknown>;

    expect(result.budgetLeft).toBe('79');
    expect(bridge.sendCommand).toHaveBeenCalled();
  });

  it('falls back to stale cached figures when the extension is unavailable', async () => {
    saveRuddrBudgetToDb(db, {
      projectName: 'Project A',
      actualBillableHours: '10', actualNonBillableHours: '0', actualTotalHours: '10',
      budget: '100', budgetLeft: '90', projectUrl: '/a', note: null, cloudFolderUrl: null,
    });
    db.run("UPDATE ruddr_budgets SET fetched_at = datetime('now', '-10 hours')");
    vi.mocked(bridge.getBridgeStatus).mockReturnValue({ running: false, port: 35789, connectedClients: 0 });
    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A') as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.budgetLeft).toBe('90');
    expect(result.stale).toBe(true);
    expect(result.refreshError).toContain('No browser extension connected');
  });

  it('reports the error instead of stale data when a forced refresh cannot run', async () => {
    saveRuddrBudgetToDb(db, {
      projectName: 'Project A',
      actualBillableHours: '10', actualNonBillableHours: '0', actualTotalHours: '10',
      budget: '100', budgetLeft: '90', projectUrl: '/a', note: null, cloudFolderUrl: null,
    });
    vi.mocked(bridge.getBridgeStatus).mockReturnValue({ running: false, port: 35789, connectedClients: 0 });
    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A', { force: true }) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No browser extension connected');
  });

  it('exposes persisted budgets through the cache handler with age metadata', async () => {
    saveRuddrBudgetToDb(db, {
      projectName: 'Project A',
      actualBillableHours: '10', actualNonBillableHours: '0', actualTotalHours: '10',
      budget: '100', budgetLeft: '90', projectUrl: '/a', note: 'cached note', cloudFolderUrl: null,
    });
    saveRuddrBudgetToDb(db, {
      projectName: 'Project Old',
      actualBillableHours: '1', actualNonBillableHours: '0', actualTotalHours: '1',
      budget: '5', budgetLeft: '4', projectUrl: '/old', note: null, cloudFolderUrl: null,
    });
    db.run("UPDATE ruddr_budgets SET fetched_at = datetime('now', '-10 hours') WHERE project_name = 'Project Old'");

    await register();

    const result = callHandler('groups:get-ruddr-budget-cache') as {
      ok: boolean;
      budgets: Record<string, Record<string, unknown>>;
    };

    expect(result.ok).toBe(true);
    expect(result.budgets['Project A'].budgetLeft).toBe('90');
    expect(result.budgets['Project A'].note).toBe('cached note');
    expect(result.budgets['Project A'].stale).toBe(false);
    expect(typeof result.budgets['Project A'].fetchedAt).toBe('string');
    expect(result.budgets['Project Old'].stale).toBe(true);
  });
});
