// ── Ruddr hours cache ─────────────────────────────────────────────────────────
// The logged-in member's time entries, read week by week from Ruddr's own
// time-entries API (through the browser extension) and stored one row per
// entry, with its note. Weeks are the unit of fetching: a week is replaced
// atomically, and its row in ruddr_time_weeks decides whether it ever needs
// fetching again.
//
// Everything in this file is pure or DB-only — the browser side lives in
// src/plugins/groups/ruddr-hours-discovery.ts.
import type { Database as SqlJsDatabase } from 'sql.js';
import { parseSqliteUtc } from './groups';

/** One entry as the extension's `fetch-ruddr-week-entries` command returns it. */
export interface RuddrApiEntry {
  id: string;
  date: string;
  minutes: number;
  notes: string | null;
  statusId: string | null;
  typeId: string | null;
  isBillable: boolean | null;
  project: {
    name: string;
    key: string;
    clientName: string | null;
    clientKey: string | null;
    clientIsInternal: boolean | null;
  } | null;
  task: { name: string; number: number } | null;
  timeOffType: string | null;
}

/** A parsed week ready for storage. */
export interface RuddrParsedWeek {
  weekStart: string;
  entries: RuddrTimeEntry[];
  totalMinutes: number;
  approvedMinutes: number;
  billableMinutes: number | null;
  nonBillableMinutes: number | null;
  internalMinutes: number | null;
  timeOffMinutes: number | null;
  memberId: string | null;
}

export interface RuddrTimeEntry {
  id: string;
  date: string;
  clientName: string | null;
  projectName: string;
  /** Ruddr project URL path, or `label:<text>` for entries without a project (time off). */
  projectPath: string;
  taskName: string | null;
  /** Ruddr task URL path, or '' when the entry has no work type. */
  taskPath: string;
  minutes: number;
  notes: string | null;
  statusId: string | null;
  typeId: string | null;
  isBillable: boolean | null;
}

// ── Dates ─────────────────────────────────────────────────────────────────────
// Weeks are handled as plain 'YYYY-MM-DD' strings with UTC arithmetic so DST
// changes never shift a day.

function parseDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n * 86_400_000);
}

/** Today's local calendar date as 'YYYY-MM-DD'. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The Monday on or before `day`. */
export function mondayOf(day: string): string {
  const dow = new Date(parseDay(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export function isWeekStart(day: unknown): day is string {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(parseDay(day)) && mondayOf(day) === day;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export type ParseWeekResult = { ok: true; week: RuddrParsedWeek } | { ok: false; error: string };

/**
 * Map Ruddr's API entries for one week onto stored entries. Paths are built
 * in the same shape as Ruddr's own links, so they match ruddr_projects.path
 * (`/app/<workspace>/portfolio/projects/<client>/<project>`).
 */
export function parseWeekEntries(
  weekStart: string,
  workspace: string,
  raw: RuddrApiEntry[] | null | undefined,
): ParseWeekResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'no_data' };
  const weekEnd = addDays(weekStart, 6);
  const entries: RuddrTimeEntry[] = [];
  const internal = new Set<string>();
  for (const e of raw) {
    if (!e || typeof e.id !== 'string' || typeof e.date !== 'string') return { ok: false, error: 'unexpected_entry_shape' };
    if (e.date < weekStart || e.date > weekEnd) continue;
    const minutes = Math.round(Number(e.minutes));
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const p = e.project;
    const timeOffLabel = e.timeOffType ? `Time Off / ${e.timeOffType}` : null;
    const projectPath = p
      ? `/app/${workspace}/portfolio/projects/${p.clientKey ?? '_'}/${p.key}`
      : `label:${timeOffLabel ?? e.typeId ?? 'other'}`;
    if (p?.clientIsInternal) internal.add(e.id);
    entries.push({
      id: e.id,
      date: e.date,
      clientName: p?.clientName?.trim() || null,
      projectName: (p?.name ?? timeOffLabel ?? 'Other time').trim(),
      projectPath,
      taskName: e.task?.name?.trim() || null,
      taskPath: p && e.task ? `${projectPath}/tasks/${e.task.number}/details` : '',
      minutes,
      notes: e.notes?.trim() || null,
      statusId: e.statusId ?? null,
      typeId: e.typeId ?? null,
      isBillable: typeof e.isBillable === 'boolean' ? e.isBillable : null,
    });
  }

  const sum = (pick: (e: RuddrTimeEntry) => boolean): number =>
    entries.reduce((acc, e) => acc + (pick(e) ? e.minutes : 0), 0);
  const timeOff = (e: RuddrTimeEntry) => e.typeId === 'time_off';
  return {
    ok: true,
    week: {
      weekStart,
      entries,
      totalMinutes: sum(() => true),
      approvedMinutes: sum((e) => e.statusId === 'approved'),
      billableMinutes: sum((e) => e.isBillable === true),
      internalMinutes: sum((e) => internal.has(e.id)),
      nonBillableMinutes: sum((e) => e.isBillable !== true && !internal.has(e.id) && !timeOff(e)),
      timeOffMinutes: sum(timeOff),
      memberId: null,
    },
  };
}

// ── Cache policy ──────────────────────────────────────────────────────────────

/** A week fetched this long after it ended is final, approved or not. */
export const FINAL_AFTER_DAYS = 42;
/** A fully approved week fetched this long after it ended is final. */
export const FINAL_IF_APPROVED_AFTER_DAYS = 14;
/** Open weeks are re-fetched at most this often. */
export const OPEN_WEEK_REFRESH_MS = 4 * 60 * 60 * 1000;
/** A week that failed to scrape is retried after this long. */
export const ERROR_RETRY_MS = 60 * 60 * 1000;
/** Backfill stops after this many consecutive empty weeks… */
export const BACKFILL_EMPTY_STREAK = 8;
/** …or this many weeks back from the current one. */
export const BACKFILL_MAX_WEEKS = 104;

export interface RuddrWeekRecord {
  weekStart: string;
  status: 'ok' | 'error';
  totalMinutes: number;
  approvedMinutes: number;
  billableMinutes: number | null;
  nonBillableMinutes: number | null;
  internalMinutes: number | null;
  timeOffMinutes: number | null;
  error: string | null;
  /** SQLite UTC timestamp of the last fetch attempt. */
  fetchedAt: string;
}

/**
 * True when a cached week will never change any more: it was fetched long
 * enough after it ended (and, for the shorter window, was fully approved).
 * Based on when it was *fetched*, so an early fetch of an old week stays open
 * until it has been re-read after the window.
 */
export function isWeekFinal(week: RuddrWeekRecord): boolean {
  if (week.status !== 'ok') return false;
  const weekEndMs = parseDay(addDays(week.weekStart, 7));
  const fetchedMs = parseSqliteUtc(week.fetchedAt);
  const daysAfterEnd = (fetchedMs - weekEndMs) / 86_400_000;
  if (daysAfterEnd >= FINAL_AFTER_DAYS) return true;
  return daysAfterEnd >= FINAL_IF_APPROVED_AFTER_DAYS && week.approvedMinutes >= week.totalMinutes;
}

/** True when a cached week should be fetched again now. */
export function isWeekDue(week: RuddrWeekRecord | undefined, nowMs: number): boolean {
  if (!week) return true;
  if (isWeekFinal(week)) return false;
  const age = nowMs - parseSqliteUtc(week.fetchedAt);
  return age >= (week.status === 'error' ? ERROR_RETRY_MS : OPEN_WEEK_REFRESH_MS);
}

export interface WeekPlan {
  /** Weeks to fetch now, in order (refreshes first, then backfill). */
  weeks: string[];
  backfillDone: boolean;
}

/**
 * Pick the next weeks to fetch: first cached weeks that are due again (newest
 * first — that is where hours still change), then the newest week that has
 * never been fetched, walking backwards. The backwards walk ends after
 * BACKFILL_EMPTY_STREAK consecutive empty weeks or BACKFILL_MAX_WEEKS.
 */
export function planWeeks(
  cached: Map<string, RuddrWeekRecord>,
  today: string,
  nowMs: number,
  limit: number,
): WeekPlan {
  const current = mondayOf(today);
  const refresh: string[] = [];
  const backfill: string[] = [];
  let emptyStreak = 0;
  let backfillDone = true;

  for (let i = 0; i < BACKFILL_MAX_WEEKS; i++) {
    const week = addDays(current, -7 * i);
    const record = cached.get(week);
    if (!record) {
      backfillDone = false;
      backfill.push(week);
      emptyStreak = 0;
      continue;
    }
    if (isWeekDue(record, nowMs)) refresh.push(week);
    if (record.status === 'ok' && record.totalMinutes === 0) {
      emptyStreak++;
      if (emptyStreak >= BACKFILL_EMPTY_STREAK) break;
    } else {
      emptyStreak = 0;
    }
  }

  return { weeks: [...refresh, ...backfill].slice(0, limit), backfillDone };
}

// ── Storage ───────────────────────────────────────────────────────────────────

export function loadWeekRecords(db: SqlJsDatabase): Map<string, RuddrWeekRecord> {
  const map = new Map<string, RuddrWeekRecord>();
  const stmt = db.prepare(`SELECT week_start, status, total_minutes, approved_minutes, billable_minutes,
      non_billable_minutes, internal_minutes, time_off_minutes, error, fetched_at FROM ruddr_time_weeks`);
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, string | number | null>;
      map.set(String(r.week_start), {
        weekStart: String(r.week_start),
        status: r.status === 'ok' ? 'ok' : 'error',
        totalMinutes: Number(r.total_minutes ?? 0),
        approvedMinutes: Number(r.approved_minutes ?? 0),
        billableMinutes: r.billable_minutes === null ? null : Number(r.billable_minutes),
        nonBillableMinutes: r.non_billable_minutes === null ? null : Number(r.non_billable_minutes),
        internalMinutes: r.internal_minutes === null ? null : Number(r.internal_minutes),
        timeOffMinutes: r.time_off_minutes === null ? null : Number(r.time_off_minutes),
        error: r.error === null ? null : String(r.error),
        fetchedAt: String(r.fetched_at),
      });
    }
  } finally {
    stmt.free();
  }
  return map;
}

/** Replace one week's entries and record it as fetched. */
export function saveWeek(db: SqlJsDatabase, week: RuddrParsedWeek): void {
  db.run('BEGIN');
  try {
    db.run('DELETE FROM ruddr_time_entries WHERE week_start = ?', [week.weekStart]);
    for (const e of week.entries) {
      db.run(
        `INSERT OR REPLACE INTO ruddr_time_entries
           (entry_id, entry_date, week_start, project_path, task_path, client_name, project_name, task_name,
            minutes, notes, status_id, type_id, is_billable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [e.id, e.date, week.weekStart, e.projectPath, e.taskPath, e.clientName, e.projectName, e.taskName,
          e.minutes, e.notes, e.statusId, e.typeId, e.isBillable === null ? null : e.isBillable ? 1 : 0],
      );
    }
    db.run(
      `INSERT INTO ruddr_time_weeks (week_start, status, total_minutes, approved_minutes, billable_minutes,
         non_billable_minutes, internal_minutes, time_off_minutes, member_id, error, fetched_at)
       VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))
       ON CONFLICT(week_start) DO UPDATE SET
         status = 'ok', total_minutes = excluded.total_minutes, approved_minutes = excluded.approved_minutes,
         billable_minutes = excluded.billable_minutes, non_billable_minutes = excluded.non_billable_minutes,
         internal_minutes = excluded.internal_minutes, time_off_minutes = excluded.time_off_minutes,
         member_id = excluded.member_id, error = NULL, fetched_at = excluded.fetched_at`,
      [week.weekStart, week.totalMinutes, week.approvedMinutes, week.billableMinutes, week.nonBillableMinutes,
        week.internalMinutes, week.timeOffMinutes, week.memberId],
    );
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/**
 * Record a failed fetch. Entries from an earlier good fetch are kept; the
 * week just becomes due again after ERROR_RETRY_MS.
 */
export function saveWeekError(db: SqlJsDatabase, weekStart: string, error: string): void {
  db.run(
    `INSERT INTO ruddr_time_weeks (week_start, status, total_minutes, approved_minutes, error, fetched_at)
     VALUES (?, 'error', 0, 0, ?, datetime('now'))
     ON CONFLICT(week_start) DO UPDATE SET status = 'error', error = excluded.error, fetched_at = excluded.fetched_at`,
    [weekStart, error],
  );
}

export interface RuddrHoursProjectTotal {
  projectPath: string;
  projectName: string;
  clientName: string | null;
  minutes: number;
  firstDate: string;
  lastDate: string;
}

/** Totals per project over [from, to] (inclusive dates; omit for all time). */
export function projectTotals(db: SqlJsDatabase, from?: string, to?: string): RuddrHoursProjectTotal[] {
  const stmt = db.prepare(`
    SELECT project_path, MAX(project_name) AS project_name, MAX(client_name) AS client_name,
           SUM(minutes) AS minutes, MIN(entry_date) AS first_date, MAX(entry_date) AS last_date
    FROM ruddr_time_entries
    WHERE entry_date >= ? AND entry_date <= ?
    GROUP BY project_path
    ORDER BY minutes DESC`);
  const out: RuddrHoursProjectTotal[] = [];
  try {
    stmt.bind([from ?? '0000-00-00', to ?? '9999-99-99']);
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, string | number | null>;
      out.push({
        projectPath: String(r.project_path),
        projectName: String(r.project_name),
        clientName: r.client_name === null ? null : String(r.client_name),
        minutes: Number(r.minutes),
        firstDate: String(r.first_date),
        lastDate: String(r.last_date),
      });
    }
  } finally {
    stmt.free();
  }
  return out;
}

export interface RuddrHoursDayRow {
  date: string;
  projectPath: string;
  projectName: string;
  clientName: string | null;
  minutes: number;
}

/** Hours per project per day (tasks rolled up) over [from, to]. */
export function projectDayRows(db: SqlJsDatabase, from: string, to: string): RuddrHoursDayRow[] {
  const stmt = db.prepare(`
    SELECT entry_date, project_path, MAX(project_name) AS project_name, MAX(client_name) AS client_name,
           SUM(minutes) AS minutes
    FROM ruddr_time_entries
    WHERE entry_date >= ? AND entry_date <= ?
    GROUP BY entry_date, project_path
    ORDER BY entry_date, project_name COLLATE NOCASE`);
  const out: RuddrHoursDayRow[] = [];
  try {
    stmt.bind([from, to]);
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, string | number | null>;
      out.push({
        date: String(r.entry_date),
        projectPath: String(r.project_path),
        projectName: String(r.project_name),
        clientName: r.client_name === null ? null : String(r.client_name),
        minutes: Number(r.minutes),
      });
    }
  } finally {
    stmt.free();
  }
  return out;
}

export interface RuddrHoursTaskDayRow extends RuddrHoursDayRow {
  /** Ruddr task path, '' when the row has no task. */
  taskPath: string;
  taskName: string | null;
}

/** Hours per project, task and day over [from, to] — the split Ruddr's week view shows. */
export function taskDayRows(db: SqlJsDatabase, from: string, to: string): RuddrHoursTaskDayRow[] {
  const stmt = db.prepare(`
    SELECT entry_date, project_path, task_path, MAX(project_name) AS project_name, MAX(client_name) AS client_name,
           MAX(task_name) AS task_name, SUM(minutes) AS minutes
    FROM ruddr_time_entries
    WHERE entry_date >= ? AND entry_date <= ?
    GROUP BY entry_date, project_path, task_path
    ORDER BY entry_date, project_name COLLATE NOCASE, task_name COLLATE NOCASE`);
  const out: RuddrHoursTaskDayRow[] = [];
  try {
    stmt.bind([from, to]);
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, string | number | null>;
      out.push({
        date: String(r.entry_date),
        projectPath: String(r.project_path),
        projectName: String(r.project_name),
        clientName: r.client_name === null ? null : String(r.client_name),
        taskPath: String(r.task_path ?? ''),
        taskName: r.task_name === null ? null : String(r.task_name),
        minutes: Number(r.minutes),
      });
    }
  } finally {
    stmt.free();
  }
  return out;
}

/** Distinct real Ruddr projects (not label rows) seen in the hours cache. */
export function projectsWithHours(db: SqlJsDatabase): Array<{ name: string; path: string }> {
  const res = db.exec(`SELECT project_path, MAX(project_name) FROM ruddr_time_entries
    WHERE project_path NOT LIKE 'label:%' GROUP BY project_path`);
  return (res[0]?.values ?? []).map(([path, name]) => ({ path: String(path), name: String(name) }));
}

export interface RuddrHoursEntryRow {
  id: string;
  date: string;
  projectPath: string;
  taskPath: string;
  minutes: number;
  notes: string | null;
  statusId: string | null;
}

/** The individual entries over [from, to], for notes per cell and per-note breakdowns. */
export function entryRows(db: SqlJsDatabase, from: string, to: string): RuddrHoursEntryRow[] {
  const stmt = db.prepare(`
    SELECT entry_id, entry_date, project_path, task_path, minutes, notes, status_id
    FROM ruddr_time_entries
    WHERE entry_date >= ? AND entry_date <= ?
    ORDER BY entry_date, entry_id`);
  const out: RuddrHoursEntryRow[] = [];
  try {
    stmt.bind([from, to]);
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, string | number | null>;
      out.push({
        id: String(r.entry_id),
        date: String(r.entry_date),
        projectPath: String(r.project_path),
        taskPath: String(r.task_path ?? ''),
        minutes: Number(r.minutes),
        notes: r.notes === null ? null : String(r.notes),
        statusId: r.status_id === null ? null : String(r.status_id),
      });
    }
  } finally {
    stmt.free();
  }
  return out;
}
