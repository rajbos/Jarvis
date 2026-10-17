/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';
import { createMemoryDatabase } from '../../src/storage/database';
import {
  addDays,
  isWeekDue,
  isWeekFinal,
  isWeekStart,
  loadWeekRecords,
  mondayOf,
  normalizeRuddrPath,
  parseRuddrDuration,
  parseWeekScrape,
  planWeeks,
  projectDayRows,
  taskDayRows,
  projectTotals,
  projectsWithHours,
  saveWeek,
  saveWeekError,
  BACKFILL_EMPTY_STREAK,
} from '../../src/services/ruddr-hours';
import type { RuddrWeekRecord, RuddrWeekScrape } from '../../src/services/ruddr-hours';
import { saveRuddrProjectsToDb, loadRuddrProjectsFromDb, upsertDiscoveredRuddrProjects } from '../../src/services/groups';

const WS = '/app/fixture-ws/portfolio/projects';

function scrape(overrides: Partial<RuddrWeekScrape> = {}): RuddrWeekScrape {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    ready: true,
    days: days.map((day, i) => ({ day, date: addDays('2026-10-05', i), total: ['1:00', '5:00', '5:00', '8:00', '0:00', '0:00', '0:00'][i] })),
    rows: [
      {
        clientName: 'Acme', clientPath: '/app/fixture-ws/portfolio/clients/acme',
        projectName: 'Acme | Rollout', projectPath: `${WS}/acme/acme-rollout`,
        taskName: null, taskPath: null, label: 'Acme / Acme | Rollout',
        hours: { Thu: '8:00' },
      },
      {
        clientName: 'Internal', clientPath: '/app/fixture-ws/portfolio/clients/internal',
        projectName: 'Internal Work', projectPath: `${WS}/internal/internal-work?tab=x`,
        taskName: 'Pre-sales', taskPath: `${WS}/internal/internal-work/tasks/23/details`, label: 'Internal / Internal Work Pre-sales',
        hours: { Mon: '1:00', Tue: '4:00', Wed: '3:00' },
      },
      {
        clientName: 'Internal', clientPath: '/app/fixture-ws/portfolio/clients/internal',
        projectName: 'Internal Work', projectPath: `${WS}/internal/internal-work`,
        taskName: 'Undefined', taskPath: `${WS}/internal/internal-work/tasks/31/details`, label: 'Internal / Internal Work Undefined',
        hours: { Tue: '1:00', Wed: '2:00' },
      },
      {
        // Allocation-only row: placeholders are never read, so every value is empty.
        clientName: 'Globex', clientPath: null, projectName: 'Globex Pilot', projectPath: `${WS}/globex/pilot`,
        taskName: null, taskPath: null, label: 'Globex / Globex Pilot', hours: {},
      },
    ],
    totalHours: '19,00',
    billableTypes: { billable: '8,00', non_billable: '0,00', internal: '11,00', time_off: '0,00' },
    approval: { approved: '19,00' },
    memberId: 'member-1',
    ...overrides,
  };
}

function record(weekStart: string, fetchedAt: string, extra: Partial<RuddrWeekRecord> = {}): RuddrWeekRecord {
  return {
    weekStart, status: 'ok', totalMinutes: 600, approvedMinutes: 0, billableMinutes: null, nonBillableMinutes: null,
    internalMinutes: null, timeOffMinutes: null, error: null, fetchedAt, ...extra,
  };
}

describe('Ruddr hours parsing', () => {
  it('parses clock, decimal and empty durations', () => {
    expect(parseRuddrDuration('8:00')).toBe(480);
    expect(parseRuddrDuration('0:45')).toBe(45);
    expect(parseRuddrDuration('35,00')).toBe(2100);
    expect(parseRuddrDuration('1.5')).toBe(90);
    expect(parseRuddrDuration('')).toBe(0);
    expect(parseRuddrDuration('n/a')).toBeNull();
  });

  it('normalizes links to the ruddr_projects path format', () => {
    expect(normalizeRuddrPath('https://www.ruddr.io/app/ws/portfolio/projects/a/b?x=1#y')).toBe('/app/ws/portfolio/projects/a/b');
    expect(normalizeRuddrPath(null)).toBeNull();
  });

  it('finds Mondays across a year boundary', () => {
    expect(mondayOf('2026-10-16')).toBe('2026-10-12');
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    expect(mondayOf('2027-01-03')).toBe('2026-12-28');
    expect(isWeekStart('2026-10-12')).toBe(true);
    expect(isWeekStart('2026-10-13')).toBe(false);
    expect(isWeekStart('../etc')).toBe(false);
  });

  it('turns a week scrape into per day, project and task entries', () => {
    const res = parseWeekScrape('2026-10-05', scrape());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.week.totalMinutes).toBe(19 * 60);
    expect(res.week.approvedMinutes).toBe(19 * 60);
    expect(res.week.internalMinutes).toBe(11 * 60);
    expect(res.week.entries).toHaveLength(6);
    expect(res.week.entries).toContainEqual({
      date: '2026-10-07', clientName: 'Internal', projectName: 'Internal Work', projectPath: `${WS}/internal/internal-work`,
      taskName: 'Pre-sales', taskPath: `${WS}/internal/internal-work/tasks/23/details`, minutes: 180,
    });
    expect(res.week.entries.some((e) => e.projectName === 'Globex Pilot')).toBe(false);
  });

  it('rejects a scrape whose rows do not add up to the page totals', () => {
    const bad = scrape();
    bad.rows = bad.rows.slice(1);
    expect(parseWeekScrape('2026-10-05', bad)).toEqual({ ok: false, error: 'totals_mismatch_2026-10-08' });
  });

  it('rejects a page that never rendered or shows a different week', () => {
    expect(parseWeekScrape('2026-10-05', scrape({ ready: false }))).toEqual({ ok: false, error: 'page_not_ready' });
    expect(parseWeekScrape('2026-10-12', scrape())).toEqual({ ok: false, error: 'week_mismatch' });
  });

  it('keys rows without a project link by their label', () => {
    const s = scrape({ totalHours: '27,00' });
    s.days[4].total = '8:00';
    s.rows.push({ clientName: null, clientPath: null, projectName: null, projectPath: null, taskName: null, taskPath: null, label: 'Time Off / Vacation', hours: { Fri: '8:00' } });
    const res = parseWeekScrape('2026-10-05', s);
    expect(res.ok && res.week.entries.find((e) => e.date === '2026-10-09')).toMatchObject({ projectPath: 'label:Time Off / Vacation', projectName: 'Time Off / Vacation' });
  });
});

describe('Ruddr hours cache policy', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');

  it('treats weeks fetched long after they ended as final', () => {
    expect(isWeekFinal(record('2026-08-03', '2026-10-01 10:00:00'))).toBe(true);
    // Approved and 14+ days after the week ended.
    expect(isWeekFinal(record('2026-09-14', '2026-10-06 10:00:00', { approvedMinutes: 600 }))).toBe(true);
    // Same week, but not fully approved yet.
    expect(isWeekFinal(record('2026-09-14', '2026-10-06 10:00:00'))).toBe(false);
    // Fetched early: an old week is final only once it was read after the window.
    expect(isWeekFinal(record('2026-08-03', '2026-08-12 10:00:00'))).toBe(false);
  });

  it('refreshes open weeks every few hours and retries errors after an hour', () => {
    expect(isWeekDue(undefined, now)).toBe(true);
    expect(isWeekDue(record('2026-10-12', '2026-10-16 10:00:00'), now)).toBe(false);
    expect(isWeekDue(record('2026-10-12', '2026-10-16 07:00:00'), now)).toBe(true);
    expect(isWeekDue(record('2026-10-12', '2026-10-16 11:30:00', { status: 'error' }), now)).toBe(false);
    expect(isWeekDue(record('2026-10-12', '2026-10-16 10:30:00', { status: 'error' }), now)).toBe(true);
  });

  it('refreshes due weeks first, then backfills the newest missing week', () => {
    const cached = new Map([
      ['2026-10-12', record('2026-10-12', '2026-10-16 06:00:00')], // due
      ['2026-10-05', record('2026-10-05', '2026-10-16 11:00:00')], // fresh
    ]);
    expect(planWeeks(cached, '2026-10-16', now, 3)).toEqual({
      weeks: ['2026-10-12', '2026-09-28', '2026-09-21'],
      backfillDone: false,
    });
  });

  it('stops going back after a streak of empty weeks', () => {
    const cached = new Map<string, RuddrWeekRecord>();
    for (let i = 0; i < 3; i++) {
      const w = addDays('2026-10-12', -7 * i);
      cached.set(w, record(w, '2026-10-16 11:00:00'));
    }
    for (let i = 3; i < 3 + BACKFILL_EMPTY_STREAK; i++) {
      const w = addDays('2026-10-12', -7 * i);
      cached.set(w, record(w, '2026-10-16 11:00:00', { totalMinutes: 0 }));
    }
    expect(planWeeks(cached, '2026-10-16', now, 3)).toEqual({ weeks: [], backfillDone: true });
  });
});

describe('Ruddr hours storage', () => {
  let db: SqlJsDatabase;
  beforeEach(async () => { db = await createMemoryDatabase(); });

  it('replaces a week atomically and rolls entries up per project', () => {
    const parsed = parseWeekScrape('2026-10-05', scrape());
    if (!parsed.ok) throw new Error(parsed.error);
    saveWeek(db, parsed.week);
    saveWeek(db, parsed.week);

    const records = loadWeekRecords(db);
    expect(records.get('2026-10-05')).toMatchObject({ status: 'ok', totalMinutes: 1140, approvedMinutes: 1140 });

    const totals = projectTotals(db);
    expect(totals.map((t) => [t.projectName, t.minutes])).toEqual([['Internal Work', 660], ['Acme | Rollout', 480]]);
    expect(projectTotals(db, '2026-10-08', '2026-10-08').map((t) => t.minutes)).toEqual([480]);

    const days = projectDayRows(db, '2026-10-05', '2026-10-11');
    expect(days.find((d) => d.date === '2026-10-07')).toMatchObject({ projectName: 'Internal Work', minutes: 300 });

    // The week view keeps Internal Work's tasks apart.
    const tasks = taskDayRows(db, '2026-10-07', '2026-10-07');
    expect(tasks.map((t) => [t.projectName, t.taskName, t.minutes])).toEqual([
      ['Internal Work', 'Pre-sales', 180],
      ['Internal Work', 'Undefined', 120],
    ]);
  });

  it('keeps earlier entries when a refetch fails', () => {
    const parsed = parseWeekScrape('2026-10-05', scrape());
    if (!parsed.ok) throw new Error(parsed.error);
    saveWeek(db, parsed.week);
    saveWeekError(db, '2026-10-05', 'totals_mismatch_week');
    expect(loadWeekRecords(db).get('2026-10-05')).toMatchObject({ status: 'error', error: 'totals_mismatch_week' });
    expect(projectTotals(db)).toHaveLength(2);
  });

  it('adds projects found through hours and keeps them across a project-list refresh', () => {
    const parsed = parseWeekScrape('2026-10-05', scrape());
    if (!parsed.ok) throw new Error(parsed.error);
    saveWeek(db, parsed.week);
    saveRuddrProjectsToDb(db, [{ name: 'Acme | Rollout', path: `${WS}/acme/acme-rollout` }]);

    const added = upsertDiscoveredRuddrProjects(db, projectsWithHours(db));
    expect(added).toEqual([{ name: 'Internal Work', path: `${WS}/internal/internal-work` }]);
    expect(upsertDiscoveredRuddrProjects(db, projectsWithHours(db))).toEqual([]);

    // The portfolio list does not show Internal Work, but it has logged hours.
    saveRuddrProjectsToDb(db, [{ name: 'Acme | Rollout', path: `${WS}/acme/acme-rollout` }, { name: 'Other', path: `${WS}/o/other` }]);
    expect(loadRuddrProjectsFromDb(db).map((p) => p.name).sort()).toEqual(['Acme | Rollout', 'Internal Work', 'Other']);
  });
});
