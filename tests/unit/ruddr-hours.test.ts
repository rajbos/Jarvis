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
  entryRows,
  parseWeekEntries,
  planWeeks,
  projectDayRows,
  taskDayRows,
  projectTotals,
  projectsWithHours,
  saveWeek,
  saveWeekError,
  BACKFILL_EMPTY_STREAK,
} from '../../src/services/ruddr-hours';
import type { RuddrApiEntry, RuddrWeekRecord } from '../../src/services/ruddr-hours';
import { saveRuddrProjectsToDb, loadRuddrProjectsFromDb, upsertDiscoveredRuddrProjects } from '../../src/services/groups';

const WS = '/app/fixture-ws/portfolio/projects';

const ACME = { name: 'Acme | Rollout', key: 'acme-rollout', clientName: 'Acme', clientKey: 'acme', clientIsInternal: false };
const INTERNAL = { name: 'Internal Work', key: 'internal-work', clientName: 'Internal', clientKey: 'internal', clientIsInternal: true };
const PRESALES = { name: 'Pre-sales', number: 23 };
const UNDEFINED = { name: 'Undefined', number: 31 };

/** One week of Ruddr API entries (Mon 2026-10-05 … Sun 2026-10-11), 19 h in total. */
function apiEntries(): RuddrApiEntry[] {
  const e = (id: string, date: string, minutes: number, project: typeof ACME, task: typeof PRESALES | null, notes: string | null, isBillable = false): RuddrApiEntry => ({
    id, date, minutes, notes, statusId: 'approved', typeId: 'project_time', isBillable, project, task, timeOffType: null,
  });
  return [
    e('a1', '2026-10-08', 480, ACME, null, 'Rollout work-packages', true),
    e('i1', '2026-10-05', 60, INTERNAL, PRESALES, 'LBG - Dennis'),
    e('i2', '2026-10-06', 240, INTERNAL, PRESALES, null),
    // Two entries in one cell, with different notes.
    e('i3', '2026-10-07', 120, INTERNAL, PRESALES, 'LBG - Dennis'),
    e('i4', '2026-10-07', 60, INTERNAL, PRESALES, 'Syncore - Wesley'),
    e('u1', '2026-10-06', 60, INTERNAL, UNDEFINED, 'XMS - Tech Officer (intern)'),
    e('u2', '2026-10-07', 120, INTERNAL, UNDEFINED, 'XMS - Tech Officer (intern)'),
  ];
}

function parsedWeek() {
  const res = parseWeekEntries('2026-10-05', 'fixture-ws', apiEntries());
  if (!res.ok) throw new Error(res.error);
  return res.week;
}

function record(weekStart: string, fetchedAt: string, extra: Partial<RuddrWeekRecord> = {}): RuddrWeekRecord {
  return {
    weekStart, status: 'ok', totalMinutes: 600, approvedMinutes: 0, billableMinutes: null, nonBillableMinutes: null,
    internalMinutes: null, timeOffMinutes: null, error: null, fetchedAt, ...extra,
  };
}

describe('Ruddr hours parsing', () => {
  it('finds Mondays across a year boundary', () => {
    expect(mondayOf('2026-10-16')).toBe('2026-10-12');
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    expect(mondayOf('2027-01-03')).toBe('2026-12-28');
    expect(isWeekStart('2026-10-12')).toBe(true);
    expect(isWeekStart('2026-10-13')).toBe(false);
    expect(isWeekStart('../etc')).toBe(false);
  });

  it('maps API entries onto Ruddr-style project and work type paths', () => {
    const week = parsedWeek();
    expect(week.totalMinutes).toBe(19 * 60);
    expect(week.approvedMinutes).toBe(19 * 60);
    expect(week.internalMinutes).toBe(11 * 60);
    expect(week.billableMinutes).toBe(8 * 60);
    expect(week.entries).toHaveLength(7);
    expect(week.entries.find((x) => x.id === 'u1')).toEqual({
      id: 'u1', date: '2026-10-06', clientName: 'Internal', projectName: 'Internal Work',
      projectPath: `${WS}/internal/internal-work`, taskName: 'Undefined', taskPath: `${WS}/internal/internal-work/tasks/31/details`,
      minutes: 60, notes: 'XMS - Tech Officer (intern)', statusId: 'approved', typeId: 'project_time', isBillable: false,
    });
    expect(week.entries.find((x) => x.id === 'a1')).toMatchObject({ projectPath: `${WS}/acme/acme-rollout`, taskPath: '' });
  });

  it('skips entries outside the week and keys time off by its type', () => {
    const raw = apiEntries();
    raw.push({ ...raw[0], id: 'x', date: '2026-10-12' });
    raw.push({ id: 't1', date: '2026-10-09', minutes: 480, notes: null, statusId: 'approved', typeId: 'time_off', isBillable: false, project: null, task: null, timeOffType: 'Vacation' });
    const res = parseWeekEntries('2026-10-05', 'fixture-ws', raw);
    expect(res.ok && res.week.entries.map((x) => x.id)).not.toContain('x');
    expect(res.ok && res.week.entries.find((x) => x.id === 't1')).toMatchObject({ projectPath: 'label:Time Off / Vacation', projectName: 'Time Off / Vacation' });
    expect(res.ok && res.week.timeOffMinutes).toBe(480);
  });

  it('rejects a response that is not a list of entries', () => {
    expect(parseWeekEntries('2026-10-05', 'fixture-ws', null)).toEqual({ ok: false, error: 'no_data' });
    expect(parseWeekEntries('2026-10-05', 'fixture-ws', [{} as RuddrApiEntry])).toEqual({ ok: false, error: 'unexpected_entry_shape' });
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
    saveWeek(db, parsedWeek());
    saveWeek(db, parsedWeek());

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

    // Each entry keeps its own note.
    expect(entryRows(db, '2026-10-07', '2026-10-07').map((e) => [e.id, e.minutes, e.notes])).toEqual([
      ['i3', 120, 'LBG - Dennis'],
      ['i4', 60, 'Syncore - Wesley'],
      ['u2', 120, 'XMS - Tech Officer (intern)'],
    ]);
  });

  it('keeps earlier entries when a refetch fails', () => {
    saveWeek(db, parsedWeek());
    saveWeekError(db, '2026-10-05', 'totals_mismatch_week');
    expect(loadWeekRecords(db).get('2026-10-05')).toMatchObject({ status: 'error', error: 'totals_mismatch_week' });
    expect(projectTotals(db)).toHaveLength(2);
  });

  it('adds projects found through hours and keeps them across a project-list refresh', () => {
    saveWeek(db, parsedWeek());
    saveRuddrProjectsToDb(db, [{ name: 'Acme | Rollout', path: `${WS}/acme/acme-rollout` }]);

    const added = upsertDiscoveredRuddrProjects(db, projectsWithHours(db));
    expect(added).toEqual([{ name: 'Internal Work', path: `${WS}/internal/internal-work` }]);
    expect(upsertDiscoveredRuddrProjects(db, projectsWithHours(db))).toEqual([]);

    // The portfolio list does not show Internal Work, but it has logged hours.
    saveRuddrProjectsToDb(db, [{ name: 'Acme | Rollout', path: `${WS}/acme/acme-rollout` }, { name: 'Other', path: `${WS}/o/other` }]);
    expect(loadRuddrProjectsFromDb(db).map((p) => p.name).sort()).toEqual(['Acme | Rollout', 'Internal Work', 'Other']);
  });
});
