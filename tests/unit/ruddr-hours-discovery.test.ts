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
  setProjectHidden,
} from '../../src/plugins/groups/ruddr-hours-discovery';
import type { HoursDiscoveryDeps } from '../../src/plugins/groups/ruddr-hours-discovery';
import { addDays, entryRows, loadWeekRecords, localToday, mondayOf } from '../../src/services/ruddr-hours';
import { createGroup } from '../../src/services/groups';

const PROJECT_PATH = '/app/fixture-ws/portfolio/projects/acme/acme-rollout';

/** Ruddr's API answer for a week: 2h on its Monday for one project, with a note. */
function weekEntries(date: string) {
  return {
    ok: true,
    status: 200,
    url: 'https://www.ruddr.io/app/fixture-ws/time/week',
    entries: [{
      id: `e-${date}`, date, minutes: 120, notes: 'Rollout prep', statusId: 'approved', typeId: 'project_time', isBillable: true,
      project: { name: 'Acme | Rollout', key: 'acme-rollout', clientName: 'Acme', clientKey: 'acme', clientIsInternal: false },
      task: null, timeOffType: null,
    }],
  };
}

type Cmd = { type: string; tabId?: number; payload: Record<string, unknown> };

function respondWith(handler: (cmd: Cmd) => unknown) {
  sendCommand.mockImplementation(async (cmd: Cmd) => handler(cmd));
}

/** A healthy extension: one Ruddr tab, and API answers per requested week. */
function healthyRuddr() {
  respondWith((cmd) => {
    if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
    if (cmd.type === 'fetch-ruddr-week-entries') return { ok: true, data: weekEntries(String(cmd.payload.date)) };
    return { ok: true, data: {} };
  });
}

const commands = () => sendCommand.mock.calls.map(([c]) => c as Cmd);

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

  it('opens one background Ruddr tab per run and asks the API for a few weeks, pausing between them', async () => {
    healthyRuddr();

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ fetched: HOURS_WEEKS_PER_RUN, newProjects: 1 });
    const types = commands().map((c) => c.type);
    expect(types).not.toContain('focus-window');
    expect(types).toEqual(['navigate', ...Array(HOURS_WEEKS_PER_RUN).fill('fetch-ruddr-week-entries'), 'close-tab']);
    expect(commands()[0].payload).toMatchObject({ newTab: true, background: true });

    const current = mondayOf(localToday());
    const fetches = commands().filter((c) => c.type === 'fetch-ruddr-week-entries');
    expect(fetches.every((c) => c.tabId === 42 && c.payload.workspace === 'fixture-ws')).toBe(true);
    expect(fetches.map((c) => c.payload.date)).toEqual([0, 1, 2].map((i) => addDays(current, -7 * i)));

    expect(sleeps).toEqual([HOURS_PAUSE_MIN_MS, HOURS_PAUSE_MIN_MS]);
    expect(newProjects).toEqual([{ name: 'Acme | Rollout', path: PROJECT_PATH }]);
    expect(getHoursStatus(db)).toMatchObject({ weeksCached: 3, newestWeek: current, loginRequired: false });
    expect(entryRows(db, current, addDays(current, 6))).toMatchObject([{ notes: 'Rollout prep', minutes: 120 }]);
  });

  it('does not fetch the same weeks again on the next run', async () => {
    healthyRuddr();
    await runRuddrHoursDiscovery(db, deps);
    sendCommand.mockClear();
    await runRuddrHoursDiscovery(db, deps);

    const dates = commands().filter((c) => c.type === 'fetch-ruddr-week-entries').map((c) => String(c.payload.date));
    const current = mondayOf(localToday());
    expect(dates).toEqual([3, 4, 5].map((i) => addDays(current, -7 * i)));
  });

  it('stops on a login page without bringing the browser forward', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: 'https://www.ruddr.io/login', tabId: 42, createdTab: true } };
      return { ok: true, data: {} };
    });

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ skipped: true, reason: 'Ruddr login required' });
    expect(commands().map((c) => c.type)).toEqual(['navigate', 'close-tab']);
    expect(loadWeekRecords(db).size).toBe(0);
    expect(getHoursStatus(db).loginRequired).toBe(true);
  });

  it('treats an unauthorised API answer as login required', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'fetch-ruddr-week-entries') return { ok: true, data: { ok: false, status: 401, error: 'workspace lookup failed (HTTP 401)' } };
      return { ok: true, data: {} };
    });

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ skipped: true, reason: 'Ruddr login required' });
    expect(commands().map((c) => c.type)).not.toContain('focus-window');
    expect(loadWeekRecords(db).size).toBe(0);
  });

  it('records a failed API call on the week and moves on', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'fetch-ruddr-week-entries') {
        return cmd.payload.date === mondayOf(localToday())
          ? { ok: true, data: { ok: false, status: 500, error: 'time entries request failed (HTTP 500)' } }
          : { ok: true, data: weekEntries(String(cmd.payload.date)) };
      }
      return { ok: true, data: {} };
    });

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ fetched: HOURS_WEEKS_PER_RUN - 1 });
    expect(loadWeekRecords(db).get(mondayOf(localToday()))).toMatchObject({ status: 'error', error: 'time entries request failed (HTTP 500)' });
  });

  it('stops without marking the week when the tab does not answer', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true, loadTimedOut: true } };
      if (cmd.type === 'fetch-ruddr-week-entries') return { ok: false, error: 'Ruddr tab did not answer — the browser may have suspended the background tab' };
      return { ok: true, data: {} };
    });

    await expect(runRuddrHoursDiscovery(db, deps)).rejects.toThrow(/did not answer/);
    expect(commands().map((c) => c.type)).toEqual(['navigate', 'fetch-ruddr-week-entries', 'close-tab']);
    expect(loadWeekRecords(db).size).toBe(0);
  });

  it('says why it skipped when no browser extension is connected', async () => {
    connectedClients = 0;

    const result = await runRuddrHoursDiscovery(db, deps);

    expect(result).toMatchObject({ skipped: true, reason: expect.stringContaining('No browser extension connected') });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(getHoursStatus(db).lastError).toContain('pair the Jarvis extension');
  });

  it('flags an extension that does not know the API command yet', async () => {
    respondWith((cmd) => {
      if (cmd.type === 'navigate') return { ok: true, data: { url: cmd.payload.url, tabId: 42, createdTab: true } };
      if (cmd.type === 'fetch-ruddr-week-entries') return { ok: false, error: 'Unknown command type: fetch-ruddr-week-entries' };
      return { ok: true, data: {} };
    });

    await runRuddrHoursDiscovery(db, deps);

    expect(getHoursStatus(db).extensionOutdated).toBe(true);
    expect(loadWeekRecords(db).size).toBe(0);
  });

  it('reloads one specific week on request, even when cached', async () => {
    healthyRuddr();
    await refreshRuddrHoursWeek(db, deps, '2026-03-02');
    await refreshRuddrHoursWeek(db, deps, '2026-03-02');

    const dates = commands().filter((c) => c.type === 'fetch-ruddr-week-entries').map((c) => c.payload.date);
    expect(dates).toEqual(['2026-03-02', '2026-03-02']);
    expect(sleeps).toEqual([]);
  });

  it('rolls hours up per group and lists projects without a group', async () => {
    healthyRuddr();
    await runRuddrHoursDiscovery(db, deps);

    let summary = getHoursSummary(db);
    expect(summary.unlinked).toMatchObject([{ projectName: 'Acme | Rollout', totalMinutes: 360 }]);

    // Hidden projects move out of the list for good, and can be shown again.
    setProjectHidden(db, PROJECT_PATH, true);
    summary = getHoursSummary(db);
    expect(summary.unlinked).toEqual([]);
    expect(summary.hidden).toMatchObject([{ projectPath: PROJECT_PATH }]);
    setProjectHidden(db, PROJECT_PATH, false);
    expect(getHoursSummary(db).unlinked).toHaveLength(1);

    const id = createGroup(db, 'Acme');
    db.run('UPDATE groups SET ruddr_project_name = ? WHERE id = ?', [JSON.stringify(['Acme | Rollout']), id]);
    summary = getHoursSummary(db);
    expect(summary.unlinked).toEqual([]);
    expect(summary.groups[id]).toMatchObject({ weekMinutes: 120, last4WeeksMinutes: 360, totalMinutes: 360 });
  });
});
