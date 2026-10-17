/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  app: { isPackaged: false },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

const sendCommand = vi.fn();
let connectedClients = 1;
vi.mock('../../src/plugins/browser-companion/server', () => ({
  sendCommand: (...args: unknown[]) => sendCommand(...args),
  getBridgeStatus: () => ({ running: true, port: 0, connectedClients }),
}));

import { createMemoryDatabase } from '../../src/storage/database';
import {
  runRuddrHoursDiscovery,
  refreshRuddrHoursWeek,
  getHoursStatus,
  getHoursSummary,
  HOURS_WEEKS_PER_RUN,
  HOURS_PAUSE_MIN_MS,
  _resetHoursDiscoveryState,
} from '../../src/plugins/groups/ruddr-hours-discovery';
import type { HoursDiscoveryDeps } from '../../src/plugins/groups/ruddr-hours-discovery';
import { addDays, loadWeekRecords, localToday, mondayOf } from '../../src/services/ruddr-hours';
import { createGroup } from '../../src/services/groups';

const PROJECT_PATH = '/app/fixture-ws/portfolio/projects/acme/acme-rollout';

/** A week page with 2h logged on its Monday for one project. */
function weekPage(date: string) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => ({
    day, date: addDays(date, i), total: i === 0 ? '2:00' : '0:00',
  }));
  return {
    ready: true,
    days,
    rows: [{
      clientName: 'Acme', clientPath: null, projectName: 'Acme | Rollout', projectPath: PROJECT_PATH,
      taskName: null, taskPath: null, label: 'Acme / Acme | Rollout', hours: { Mon: '2:00' },
    }],
    totalHours: '2,00',
    billableTypes: {},
    approval: {},
    memberId: 'm-1',
  };
}

function respondWith(handler: (cmd: { type: string; tabId?: number; payload: Record<string, unknown> }) => unknown) {
  sendCommand.mockImplementation(async (cmd: { type: string; tabId?: number; payload: Record<string, unknown> }) => handler(cmd));
}

describe('Ruddr hours discovery', () => {
  let db: SqlJsDatabase;
  let deps: HoursDiscoveryDeps;
  let sleeps: number[];
  let newProjects: Array<{ name: string; path: string }>;

  beforeEach(async () => {
    db = await createMemoryDatabase();
    sendCommand.mockReset();
    connectedClients = 1;
    _resetHoursDiscoveryState();
    sleeps = [];
    newProjects = [];
    deps = {
      getWorkspace: () => 'fixture-ws',
      getWindow: () => null,
      onNewProjects: (p) => newProjects.push(...p),
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    };
  });

  it('fetches a few weeks in one background tab, pausing between pages', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'scrape-ruddr-week') return { ok: true, data: weekPage(String(cmd.payload.date)) };
      return { ok: true, data: {} };
    });

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ fetched: HOURS_WEEKS_PER_RUN, newProjects: 1 });
    const types = sendCommand.mock.calls.map(([c]) => c.type);
    expect(types).not.toContain('focus-window');
    expect(types.filter((t) => t === 'navigate')).toHaveLength(HOURS_WEEKS_PER_RUN);
    expect(types[types.length - 1]).toBe('close-tab');

    const navs = sendCommand.mock.calls.map(([c]) => c).filter((c) => c.type === 'navigate');
    expect(navs[0].payload).toMatchObject({ newTab: true, background: true });
    expect(navs.slice(1).every((c) => c.tabId === 42 && !('newTab' in c.payload))).toBe(true);
    const current = mondayOf(localToday());
    expect(navs.map((c) => c.payload.url)).toEqual([0, 1, 2].map((i) =>
      `https://www.ruddr.io/app/fixture-ws/time/week?date=${addDays(current, -7 * i)}`));

    expect(sleeps).toEqual([HOURS_PAUSE_MIN_MS, HOURS_PAUSE_MIN_MS]);
    expect(newProjects).toEqual([{ name: 'Acme | Rollout', path: PROJECT_PATH }]);
    expect(getHoursStatus(db)).toMatchObject({ weeksCached: 3, newestWeek: current, loginRequired: false });
  });

  it('does not fetch the same weeks again on the next run', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'scrape-ruddr-week') return { ok: true, data: weekPage(String(cmd.payload.date)) };
      return { ok: true, data: {} };
    });
    await runRuddrHoursDiscovery(db, deps);
    sendCommand.mockClear();
    await runRuddrHoursDiscovery(db, deps);

    const urls = sendCommand.mock.calls.map(([c]) => c).filter((c) => c.type === 'navigate').map((c) => String(c.payload.url));
    const current = mondayOf(localToday());
    expect(urls).toHaveLength(HOURS_WEEKS_PER_RUN);
    expect(urls.some((u) => u.endsWith(current))).toBe(false);
    expect(urls[0]).toContain(addDays(current, -21));
  });

  it('stops on a login page without bringing the browser forward', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: 'https://www.ruddr.io/login', tabId: 42, createdTab: true } };
      return { ok: true, data: {} };
    });

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ skipped: true, reason: 'Ruddr login required' });
    const types = sendCommand.mock.calls.map(([c]) => c.type);
    expect(types).toEqual(['navigate', 'close-tab']);
    expect(loadWeekRecords(db).size).toBe(0);
    expect(getHoursStatus(db).loginRequired).toBe(true);
  });

  it('stops without marking the week when the page never renders', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true, loadTimedOut: true } };
      if (cmd.type === 'scrape-ruddr-week') return { ok: true, data: { ready: false, days: [], rows: [], url: 'https://www.ruddr.io/app/fixture-ws/time/week' } };
      return { ok: true, data: {} };
    });

    await expect(runRuddrHoursDiscovery(db, deps)).rejects.toThrow(/did not render/);

    const types = sendCommand.mock.calls.map(([c]) => c.type);
    expect(types).toEqual(['navigate', 'scrape-ruddr-week', 'close-tab']);
    expect(loadWeekRecords(db).size).toBe(0);
  });

  it('treats a scrape that ended on the login page as login required', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true, loadTimedOut: true } };
      if (cmd.type === 'scrape-ruddr-week') return { ok: true, data: { ready: false, days: [], rows: [], url: 'https://www.ruddr.io/login' } };
      return { ok: true, data: {} };
    });

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ skipped: true, reason: 'Ruddr login required' });
    expect(sendCommand.mock.calls.map(([c]) => c.type)).not.toContain('focus-window');
  });

  it('says why it skipped when no browser extension is connected', async () => {
    connectedClients = 0;

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ skipped: true, reason: expect.stringContaining('No browser extension connected') });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(getHoursStatus(db).lastError).toContain('pair the Jarvis extension');
  });

  it('flags an extension that does not know the week command yet', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'scrape-ruddr-week') return { ok: false, error: 'Unknown command type: scrape-ruddr-week' };
      return { ok: true, data: {} };
    });

    await runRuddrHoursDiscovery(db, deps);

    expect(getHoursStatus(db).extensionOutdated).toBe(true);
    expect(loadWeekRecords(db).size).toBe(0);
  });

  it('reloads one specific week on request, even when cached', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'scrape-ruddr-week') return { ok: true, data: weekPage(String(cmd.payload.date)) };
      return { ok: true, data: {} };
    });
    await refreshRuddrHoursWeek(db, deps, '2026-03-02');
    await refreshRuddrHoursWeek(db, deps, '2026-03-02');

    const urls = sendCommand.mock.calls.map(([c]) => c).filter((c) => c.type === 'navigate').map((c) => c.payload.url);
    expect(urls).toEqual([
      'https://www.ruddr.io/app/fixture-ws/time/week?date=2026-03-02',
      'https://www.ruddr.io/app/fixture-ws/time/week?date=2026-03-02',
    ]);
    expect(sleeps).toEqual([]);
  });

  it('rolls hours up per group and lists projects without a group', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'scrape-ruddr-week') return { ok: true, data: weekPage(String(cmd.payload.date)) };
      return { ok: true, data: {} };
    });
    await runRuddrHoursDiscovery(db, deps);

    let summary = getHoursSummary(db);
    expect(summary.unlinked).toMatchObject([{ projectName: 'Acme | Rollout', totalMinutes: 360 }]);

    const id = createGroup(db, 'Acme');
    db.run('UPDATE groups SET ruddr_project_name = ? WHERE id = ?', [JSON.stringify(['Acme | Rollout']), id]);
    summary = getHoursSummary(db);
    expect(summary.unlinked).toEqual([]);
    expect(summary.groups[id]).toMatchObject({ weekMinutes: 120, last4WeeksMinutes: 360, totalMinutes: 360 });
  });
});
