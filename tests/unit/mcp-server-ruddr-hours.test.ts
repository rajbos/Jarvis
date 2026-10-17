/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { getRuddrHoursStatus, listRuddrHourEntries, queryRuddrHours } from '../../src/mcp-server/tools/ruddr-hours';

const WS = '/app/ws/portfolio/projects';
const ASML = `${WS}/asml/asml-rollout`;
const INTERNAL = `${WS}/internal-xms/internal-work`;
/** "Now" is Friday 16 Oct 2026, so the default range is Mon 12 – Sun 18 Oct. */
const NOW = new Date(2026, 9, 16, 12, 0, 0);

function entry(
  db: SqlJsDatabase,
  id: string, date: string, week: string, client: string, project: string, path: string,
  task: string | null, minutes: number, notes: string | null, status = 'approved', billable = false,
): void {
  db.run(
    `INSERT INTO ruddr_time_entries (entry_id, entry_date, week_start, project_path, task_path, client_name, project_name,
       task_name, minutes, notes, status_id, type_id, is_billable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'project_time', ?)`,
    [id, date, week, path, task ? `${path}/tasks/${task}` : '', client, project, task, minutes, notes, status, billable ? 1 : 0],
  );
}

describe('MCP server — Ruddr hours tools', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    for (const w of ['2026-09-28', '2026-10-12']) {
      db.run(`INSERT INTO ruddr_time_weeks (week_start, status, total_minutes, approved_minutes, fetched_at) VALUES (?, 'ok', 0, 0, '2026-10-16 08:00:00')`, [w]);
    }
    db.run(`INSERT INTO ruddr_time_weeks (week_start, status, total_minutes, approved_minutes, error, fetched_at) VALUES ('2026-10-05', 'error', 0, 0, 'time entries request failed (HTTP 500)', '2026-10-16 09:00:00')`);
    db.run(`INSERT INTO groups (name, ruddr_project_name) VALUES ('ASML', '["ASML | Rollout"]')`);

    entry(db, 'a1', '2026-10-15', '2026-10-12', 'ASML Netherlands BV', 'ASML | Rollout', ASML, null, 240, 'Work-packages', 'approved', true);
    entry(db, 'i1', '2026-10-13', '2026-10-12', 'Internal XMS', 'Internal Work', INTERNAL, 'Pre-sales werkzaamheden', 60, 'LBG - Dennis');
    entry(db, 'i2', '2026-10-14', '2026-10-12', 'Internal XMS', 'Internal Work', INTERNAL, 'Pre-sales werkzaamheden', 180, 'Syncore - Wesley', 'pending_approval');
    entry(db, 'u1', '2026-10-14', '2026-10-12', 'Internal XMS', 'Internal Work', INTERNAL, 'Undefined', 120, 'XMS - Tech Officer (intern)');
    entry(db, 'u2', '2026-10-16', '2026-10-12', 'Internal XMS', 'Internal Work', INTERNAL, 'Undefined', 60, 'Recruitment');
    // An earlier week, outside the default range.
    entry(db, 'old', '2026-09-29', '2026-09-28', 'ASML Netherlands BV', 'ASML | Rollout', ASML, null, 480, 'Kick-off', 'approved', true);
  });

  afterEach(() => db.close());

  it('sums this week per project by default, with totals and coverage', () => {
    const res = queryRuddrHours(db, {}, NOW);
    if (!res.ok) throw new Error(res.error);

    expect(res.value.range).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(res.value.rows).toEqual([
      { client: 'Internal XMS', project: 'Internal Work', hours: 7, entries: 4 },
      { client: 'ASML Netherlands BV', project: 'ASML | Rollout', hours: 4, entries: 1 },
    ]);
    expect(res.value.totals).toEqual({ hours: 11, billableHours: 4, nonBillableHours: 7, approvedHours: 8, entries: 5 });
    expect(res.value.coverage).toEqual({ weeksInRange: 1, weeksCached: 1, missingWeeks: [], complete: true });
  });

  it('splits Undefined work by note', () => {
    const res = queryRuddrHours(db, { workType: 'undefined', groupBy: ['note'] }, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.rows).toEqual([
      { note: 'XMS - Tech Officer (intern)', hours: 2, entries: 1 },
      { note: 'Recruitment', hours: 1, entries: 1 },
    ]);
  });

  it('groups by Jarvis group and filters on a fuzzy group name', () => {
    const byGroup = queryRuddrHours(db, { from: '2026-09-28', to: '2026-10-18', groupBy: ['group'] }, NOW);
    if (!byGroup.ok) throw new Error(byGroup.error);
    expect(byGroup.value.rows).toEqual([
      { group: 'ASML', hours: 12, entries: 2 },
      { group: '(no group)', hours: 7, entries: 4 },
    ]);
    // 5 Oct failed to fetch: the range is not complete.
    expect(byGroup.value.coverage).toMatchObject({ weeksInRange: 3, weeksCached: 2, missingWeeks: ['2026-10-05'], complete: false });

    const asml = queryRuddrHours(db, { from: '2026-09-28', to: '2026-10-18', group: 'asml' }, NOW);
    expect(asml.ok && asml.value).toMatchObject({ group: 'ASML', totals: { hours: 12 } });
    expect(queryRuddrHours(db, { group: 'Nope' }, NOW)).toMatchObject({ ok: false });
  });

  it('lists entries with notes, filtered by note text and approval status', () => {
    const res = listRuddrHourEntries(db, { note: 'wesley' }, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.entries).toEqual([{
      date: '2026-10-14', client: 'Internal XMS', project: 'Internal Work', workType: 'Pre-sales werkzaamheden',
      hours: 3, note: 'Syncore - Wesley', status: 'pending_approval', billable: false,
    }]);

    const pending = listRuddrHourEntries(db, { status: 'pending_approval', limit: 1 }, NOW);
    expect(pending.ok && pending.value).toMatchObject({ totalMatching: 1, truncated: false });
    const capped = listRuddrHourEntries(db, { limit: 2 }, NOW);
    expect(capped.ok && capped.value).toMatchObject({ totalMatching: 5, truncated: true });
  });

  it('rejects malformed dates', () => {
    expect(queryRuddrHours(db, { from: '16-10-2026' }, NOW)).toEqual({ ok: false, error: '`from` must be YYYY-MM-DD' });
    expect(queryRuddrHours(db, { from: '2026-10-18', to: '2026-10-01' }, NOW)).toEqual({ ok: false, error: '`to` is before `from`' });
  });

  it('reports how far the cache reaches, with gaps and failed weeks', () => {
    expect(getRuddrHoursStatus(db, NOW)).toMatchObject({
      cacheAvailable: true,
      weeksCached: 2,
      oldestWeek: '2026-09-28',
      newestWeek: '2026-10-12',
      gaps: ['2026-10-05'],
      failedWeeks: [{ week: '2026-10-05', error: 'time entries request failed (HTTP 500)' }],
      lastFetchedAt: '2026-10-16 09:00:00',
      entries: 6,
    });
  });

  it('says the cache is unavailable on a database without hours', async () => {
    const SQL = await initSqlJs();
    const empty = new SQL.Database();
    expect(getRuddrHoursStatus(empty, NOW)).toMatchObject({ cacheAvailable: false, weeksCached: 0 });
    expect(queryRuddrHours(empty, {}, NOW)).toMatchObject({ ok: false });
    empty.close();
  });
});
