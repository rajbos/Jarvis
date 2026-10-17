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
import { saveRuddrBudgetToDb, saveRuddrProjectsToDb, listGroups } from '../../src/services/groups';

// ── Track registered handlers ─────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

/** Electron Notification mock — the handler shows a desktop toast when the Ruddr scrape breaks. */
const mockNotification = Object.assign(vi.fn(), { isSupported: vi.fn(() => true) });

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  Notification: mockNotification,
}));

vi.mock('../../src/services/groups', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/groups')>();
  return { ...actual, listGroups: vi.fn(actual.listGroups) };
});

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

const PROJECT_API_PATH = 'clients/client-a/projects/project-a';
const KPI_API_PATH = 'projects/p-1/kpi/hours';

/** Ruddr API answers per workspace-relative path, as the extension's `ruddr-api-get` returns them. */
type ApiAnswers = Record<string, { status: number; body: unknown }>;

const HEALTHY_API: ApiAnswers = {
  [PROJECT_API_PATH]: { status: 200, body: { id: 'p-1', description: 'fresh note', cloudFolderUrl: 'https://example.com/fresh' } },
  [KPI_API_PATH]: { status: 200, body: { actual: { billable: 20, nonBillable: 1, total: 21 }, budget: { billable: 100, nonBillable: 0, total: 100 } } },
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
    saveRuddrProjectsToDb(db, [{ name: 'Project A', path: '/app/test-workspace/portfolio/projects/client-a/project-a' }]);

    bridge = await import('../../src/plugins/browser-companion/server');
    vi.mocked(bridge.getBridgeStatus).mockReturnValue({ running: true, port: 35789, connectedClients: 1 });
    mockRuddrApi(HEALTHY_API);
  });

  /** Bridge mock: one Ruddr tab, then API answers looked up by path. */
  function mockRuddrApi(answers: ApiAnswers): void {
    vi.mocked(bridge.sendCommand).mockImplementation(async (command) => {
      if (command.type === 'navigate') {
        return { id: 'cmd-1', ok: true, data: { url: 'https://www.ruddr.io/app/test-workspace/time/week', tabId: 7, createdTab: true } };
      }
      if (command.type === 'ruddr-api-get') {
        const paths = (command.payload as { paths: string[] }).paths;
        return { id: 'cmd-1', ok: true, data: { ok: true, status: 200, responses: paths.map((p) => answers[p] ?? { status: 404, body: null }) } };
      }
      if (command.type === 'close-tab') return { id: 'cmd-1', ok: true, data: { closed: true } };
      return { id: 'cmd-1', ok: true, data: null };
    });
  }

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

  it('resolves { ok: false, error } via safeHandle when listGroups throws (no try/catch in handler)', async () => {
    await register();
    vi.mocked(listGroups).mockImplementationOnce(() => {
      throw new Error('groups table missing');
    });

    // `groups:list` has no try/catch of its own — safeHandle must turn the
    // synchronous throw into a predictable error payload for the renderer.
    const result = await callHandler('groups:list');
    expect(result).toEqual({ ok: false, error: 'groups table missing' });
  });

  // ── Ruddr API ────────────────────────────────────────────────────────────────

  it('reads the budget from the project and hours KPI API calls, without scraping pages', async () => {
    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A', { force: true }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true, actualBillableHours: '20', actualNonBillableHours: '1', actualTotalHours: '21',
      budget: '100', budgetLeft: '79', note: 'fresh note', cloudFolderUrl: 'https://example.com/fresh',
      projectUrl: 'https://www.ruddr.io/app/test-workspace/portfolio/projects/client-a/project-a/overview',
    });
    const types = vi.mocked(bridge.sendCommand).mock.calls.map(([c]) => c.type);
    expect(types).toEqual(['navigate', 'ruddr-api-get', 'ruddr-api-get', 'close-tab']);
    expect(types).not.toContain('scrape-stats');
    const stored = db.exec('SELECT budget, budget_left, note FROM ruddr_budgets');
    expect(stored[0].values[0]).toEqual(['100', '79', 'fresh note']);
  });

  it('reports a project without a budget as budget 0', async () => {
    mockRuddrApi({
      ...HEALTHY_API,
      [KPI_API_PATH]: { status: 200, body: { actual: { billable: 174, nonBillable: 0, total: 174 }, budget: { billable: 0, nonBillable: 0, total: 0 } } },
    });
    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A', { force: true }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, budget: '0', budgetLeft: '-174', actualBillableHours: '174' });
  });

  it('reports project_not_in_ruddr when Ruddr does not know the project', async () => {
    mockRuddrApi({});
    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A', { force: true }) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: false, error: 'project_not_in_ruddr' });
  });

  it('keeps cached figures, reports ruddr_api_changed and notifies once when the API answer is unreadable', async () => {
    saveRuddrBudgetToDb(db, {
      projectName: 'Project A',
      actualBillableHours: '10', actualNonBillableHours: '0', actualTotalHours: '10',
      budget: '100', budgetLeft: '90', projectUrl: '/a', note: null, cloudFolderUrl: null,
    });
    db.run("UPDATE ruddr_budgets SET fetched_at = datetime('now', '-10 hours')");
    mockRuddrApi({ ...HEALTHY_API, [KPI_API_PATH]: { status: 200, body: { something: 'else' } } });
    await register();

    const result = await callHandler('groups:get-ruddr-budget', 'Project A') as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, cached: true, budgetLeft: '90', refreshError: 'ruddr_api_changed' });
    expect(mockNotification).toHaveBeenCalledTimes(1);

    // Same outage: no second notification. A forced refresh reports the error itself.
    const forced = await callHandler('groups:get-ruddr-budget', 'Project A', { force: true }) as Record<string, unknown>;
    expect(forced).toMatchObject({ ok: false, error: 'ruddr_api_changed' });
    expect(mockNotification).toHaveBeenCalledTimes(1);

    // Recovery clears the alert.
    mockRuddrApi(HEALTHY_API);
    await callHandler('groups:get-ruddr-budget', 'Project A', { force: true });
    expect(db.exec("SELECT value FROM config WHERE key = 'ruddr_budget_alert_at'").length).toBe(0);
  });
});
