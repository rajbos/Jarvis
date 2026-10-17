/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Groups plugin — the Ruddr project list and project details come from
 * Ruddr's API (through the extension's `ruddr-api-get`), not from scrolling
 * the portfolio list or reading edit-page form fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { loadRuddrProjectsFromDb } from '../../src/services/groups';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => true) }),
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/plugins/browser-companion/server', () => ({
  getBridgeStatus: vi.fn(() => ({ running: true, port: 35789, connectedClients: 1 })),
  sendCommand: vi.fn(),
}));

type Cmd = { type: string; tabId?: number; payload: Record<string, unknown> };

/** 150 active projects, served 100 per page like Ruddr's projects API. */
function projectPage(page: number) {
  const all = Array.from({ length: 150 }, (_, i) => ({
    name: `Project ${String(i).padStart(3, '0')}`,
    key: `project-${i}`,
    client: { key: `client-${i % 7}`, name: `Client ${i % 7}` },
  }));
  return { results: all.slice(page * 100, page * 100 + 100), total: all.length };
}

describe('Groups plugin — Ruddr projects through the API', () => {
  let db: SqlJsDatabase;
  let sendCommand: ReturnType<typeof vi.fn>;
  let apiPaths: string[];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    db.run("INSERT INTO config (key, value) VALUES ('ruddr_workspace', 'test-ws')");
    // One group linked to a project that still misses its note.
    db.run(`INSERT INTO groups (name, ruddr_project_name) VALUES ('Client 3', '["Project 003"]')`);

    apiPaths = [];
    const bridge = await import('../../src/plugins/browser-companion/server');
    sendCommand = vi.mocked(bridge.sendCommand) as unknown as ReturnType<typeof vi.fn>;
    sendCommand.mockImplementation(async (command: Cmd) => {
      if (command.type === 'navigate') return { id: 'x', ok: true, data: { url: 'https://www.ruddr.io/app/test-ws/time/week', tabId: 9, createdTab: true } };
      if (command.type === 'ruddr-api-get') {
        const paths = command.payload.paths as string[];
        apiPaths.push(...paths);
        const responses = paths.map((p) => {
          const page = /^projects\?page=(\d+)&size=100&sort=name:asc&projectRecordStatusId=active$/.exec(p);
          if (page) return { status: 200, body: projectPage(Number(page[1])) };
          if (p === 'clients/client-3/projects/project-3') return { status: 200, body: { id: 'p3', description: 'Fixed price, 10 days', cloudFolderUrl: 'https://example.com/p3' } };
          return { status: 404, body: null };
        });
        return { id: 'x', ok: true, data: { ok: true, status: 200, responses } };
      }
      return { id: 'x', ok: true, data: { closed: true } };
    });
  });

  afterEach(() => db.close());

  it('pages through the projects API, then fetches details for linked projects in the same tab', async () => {
    const { refreshRuddrProjectsInBackground } = await import('../../src/plugins/groups/handler');

    const result = await refreshRuddrProjectsInBackground(db, () => null, true);

    expect(result).toEqual({ ok: true });
    const types = sendCommand.mock.calls.map(([c]) => (c as Cmd).type);
    expect(types).toEqual(['navigate', 'ruddr-api-get', 'ruddr-api-get', 'ruddr-api-get', 'close-tab']);
    expect(types).not.toContain('scroll-extract');
    expect(types).not.toContain('read-form-fields');
    expect(types).not.toContain('focus-window');
    expect(apiPaths).toEqual([
      'projects?page=0&size=100&sort=name:asc&projectRecordStatusId=active',
      'projects?page=1&size=100&sort=name:asc&projectRecordStatusId=active',
      'clients/client-3/projects/project-3',
    ]);

    const stored = loadRuddrProjectsFromDb(db);
    expect(stored).toHaveLength(150);
    expect(stored.find((p) => p.name === 'Project 003')).toMatchObject({
      path: '/app/test-ws/portfolio/projects/client-3/project-3',
      note: 'Fixed price, 10 days',
      cloud_folder_url: 'https://example.com/p3',
    });
  });

  it('reports login_required when Ruddr refuses the session', async () => {
    sendCommand.mockImplementation(async (command: Cmd) => {
      if (command.type === 'navigate') return { id: 'x', ok: true, data: { url: 'https://www.ruddr.io/app/test-ws/time/week', tabId: 9, createdTab: true } };
      if (command.type === 'ruddr-api-get') return { id: 'x', ok: true, data: { ok: false, status: 401, error: 'workspace lookup failed (HTTP 401)' } };
      return { id: 'x', ok: true, data: {} };
    });
    const { refreshRuddrProjectsInBackground } = await import('../../src/plugins/groups/handler');

    const result = await refreshRuddrProjectsInBackground(db, () => null, true);

    expect(result).toMatchObject({ skipped: true, error: 'login_required' });
    expect(loadRuddrProjectsFromDb(db)).toHaveLength(0);
  });
});
