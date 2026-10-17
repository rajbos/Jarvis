// ── Ruddr hours tools for the Jarvis MCP server ───────────────────────────────
// Reads the logged-in member's Ruddr time entries that the Jarvis app caches
// week by week (ruddr_time_entries / ruddr_time_weeks), so a caller can ask
// "how many hours did I log on X" or "what were those Undefined hours about".
// Read-only; never talks to Ruddr itself.
import type { Database as SqlJsDatabase } from 'sql.js';
import { listGroupsWithRuddr } from './ruddr.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export const HOURS_GROUP_BY = ['day', 'week', 'client', 'project', 'work_type', 'note', 'group'] as const;
export type HoursGroupBy = (typeof HOURS_GROUP_BY)[number];

export interface HoursFilters {
  /** Inclusive 'YYYY-MM-DD'; defaults to the Monday of the current week. */
  from?: string;
  /** Inclusive 'YYYY-MM-DD'; defaults to the Sunday after `from`'s week start. */
  to?: string;
  /** Case-insensitive substring of the client name. */
  client?: string;
  /** Case-insensitive substring of the project name. */
  project?: string;
  /** Jarvis group (customer) name, fuzzy; restricts to the group's linked Ruddr projects. */
  group?: string;
  /** Case-insensitive substring of the work type (Ruddr task) name. */
  workType?: string;
}

export interface HoursCoverage {
  /** Mondays of every week the range touches. */
  weeksInRange: number;
  weeksCached: number;
  /** Weeks in the range Jarvis has not fetched (successfully) yet — their hours are missing. */
  missingWeeks: string[];
  /** True when every week in the range is cached. */
  complete: boolean;
}

interface EntryRow {
  id: string;
  date: string;
  weekStart: string;
  clientName: string | null;
  projectName: string;
  projectPath: string;
  workType: string | null;
  minutes: number;
  notes: string | null;
  statusId: string | null;
  typeId: string | null;
  isBillable: boolean | null;
}

type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

// ── Dates ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

function localToday(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function resolveRange(filters: HoursFilters, now: Date): Resolved<{ from: string; to: string }> {
  if (filters.from !== undefined && !isDate(filters.from)) return { ok: false, error: '`from` must be YYYY-MM-DD' };
  if (filters.to !== undefined && !isDate(filters.to)) return { ok: false, error: '`to` must be YYYY-MM-DD' };
  const from = filters.from ?? mondayOf(localToday(now));
  const to = filters.to ?? addDays(mondayOf(from), 6);
  if (to < from) return { ok: false, error: '`to` is before `from`' };
  return { ok: true, value: { from, to } };
}

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasTable(db: SqlJsDatabase, table: string): boolean {
  const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  stmt.bind([table]);
  try {
    return stmt.step();
  } finally {
    stmt.free();
  }
}

/** True when the cache has the per-entry layout (schema v37+); older layouts have no notes or ids. */
function hasEntryCache(db: SqlJsDatabase): boolean {
  if (!hasTable(db, 'ruddr_time_entries') || !hasTable(db, 'ruddr_time_weeks')) return false;
  const res = db.exec("SELECT 1 FROM pragma_table_info('ruddr_time_entries') WHERE name = 'entry_id'");
  return res.length > 0 && res[0].values.length > 0;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Resolve a fuzzy group name to the Ruddr project names and paths linked to it. */
function resolveGroup(db: SqlJsDatabase, query: string): Resolved<{ name: string; projectNames: Set<string>; projectPaths: Set<string> }> {
  const q = normalize(query);
  const groups = listGroupsWithRuddr(db);
  const exact = groups.find((g) => normalize(g.name) === q);
  const partial = groups.filter((g) => normalize(g.name).includes(q) || q.includes(normalize(g.name)));
  const match = exact ?? (partial.length === 1 ? partial[0] : undefined);
  if (!match) {
    const names = (partial.length > 1 ? partial : groups).map((g) => g.name).slice(0, 15).join(', ');
    return { ok: false, error: `No single Jarvis group matches "${query}". ${partial.length > 1 ? 'Candidates' : 'Groups with Ruddr projects'}: ${names || '(none)'}` };
  }
  return {
    ok: true,
    value: {
      name: match.name,
      projectNames: new Set(match.ruddrProjectNames.map((n) => n.toLowerCase())),
      projectPaths: new Set(match.ruddrProjectPaths),
    },
  };
}

function loadEntries(db: SqlJsDatabase, from: string, to: string): EntryRow[] {
  const stmt = db.prepare(`
    SELECT entry_id, entry_date, week_start, client_name, project_name, project_path, task_name,
           minutes, notes, status_id, type_id, is_billable
    FROM ruddr_time_entries
    WHERE entry_date >= ? AND entry_date <= ?
    ORDER BY entry_date, project_name COLLATE NOCASE, task_name COLLATE NOCASE, entry_id`);
  const out: EntryRow[] = [];
  try {
    stmt.bind([from, to]);
    while (stmt.step()) {
      const r = stmt.getAsObject() as Record<string, string | number | null>;
      out.push({
        id: String(r.entry_id),
        date: String(r.entry_date),
        weekStart: String(r.week_start),
        clientName: r.client_name === null ? null : String(r.client_name),
        projectName: String(r.project_name),
        projectPath: String(r.project_path),
        workType: r.task_name === null ? null : String(r.task_name),
        minutes: Number(r.minutes),
        notes: r.notes === null ? null : String(r.notes),
        statusId: r.status_id === null ? null : String(r.status_id),
        typeId: r.type_id === null ? null : String(r.type_id),
        isBillable: r.is_billable === null ? null : Number(r.is_billable) === 1,
      });
    }
  } finally {
    stmt.free();
  }
  return out;
}

function coverage(db: SqlJsDatabase, from: string, to: string): HoursCoverage {
  const cached = new Set(
    (db.exec(`SELECT week_start FROM ruddr_time_weeks WHERE status = 'ok' AND week_start >= ? AND week_start <= ?`, [mondayOf(from), to])[0]?.values ?? [])
      .map(([w]) => String(w)),
  );
  const weeks: string[] = [];
  for (let w = mondayOf(from); w <= to; w = addDays(w, 7)) weeks.push(w);
  const missingWeeks = weeks.filter((w) => !cached.has(w));
  return { weeksInRange: weeks.length, weeksCached: weeks.length - missingWeeks.length, missingWeeks, complete: missingWeeks.length === 0 };
}

/** Entries in range that pass every filter; the shared base of both query tools. */
function filteredEntries(db: SqlJsDatabase, filters: HoursFilters, now: Date): Resolved<{ from: string; to: string; group: string | null; entries: EntryRow[] }> {
  const range = resolveRange(filters, now);
  if (!range.ok) return range;
  let groupFilter: { name: string; projectNames: Set<string>; projectPaths: Set<string> } | null = null;
  if (filters.group) {
    const g = resolveGroup(db, filters.group);
    if (!g.ok) return g;
    groupFilter = g.value;
  }
  const has = (value: string | null, needle?: string) => !needle || (value ?? '').toLowerCase().includes(needle.toLowerCase());
  const entries = loadEntries(db, range.value.from, range.value.to).filter((e) =>
    has(e.clientName, filters.client)
    && has(e.projectName, filters.project)
    && has(e.workType, filters.workType)
    && (!groupFilter || groupFilter.projectPaths.has(e.projectPath) || groupFilter.projectNames.has(e.projectName.toLowerCase())));
  return { ok: true, value: { ...range.value, group: groupFilter?.name ?? null, entries } };
}

const NOT_CACHED = 'The Jarvis app has not cached any Ruddr hours yet (or runs an older version). Check ruddr_hours_status.';

// ── ruddr_hours ───────────────────────────────────────────────────────────────

export interface HoursSummary {
  range: { from: string; to: string };
  group: string | null;
  groupBy: HoursGroupBy[];
  rows: Array<Record<string, string | number | null>>;
  totals: { hours: number; billableHours: number; nonBillableHours: number; approvedHours: number; entries: number };
  coverage: HoursCoverage;
}

/** Hours over a date range, summed per the requested dimensions. */
export function queryRuddrHours(
  db: SqlJsDatabase,
  filters: HoursFilters & { groupBy?: HoursGroupBy[] },
  now: Date = new Date(),
): Resolved<HoursSummary> {
  if (!hasEntryCache(db)) return { ok: false, error: NOT_CACHED };
  const base = filteredEntries(db, filters, now);
  if (!base.ok) return base;
  const { from, to, group, entries } = base.value;
  const groupBy = filters.groupBy && filters.groupBy.length > 0 ? [...new Set(filters.groupBy)] : ['project' as const];

  // Group membership per project, only computed when asked for.
  const groupsOf = (() => {
    if (!groupBy.includes('group')) return () => [] as string[];
    const groups = listGroupsWithRuddr(db);
    return (e: EntryRow) => {
      const names = groups
        .filter((g) => g.ruddrProjectPaths.includes(e.projectPath) || g.ruddrProjectNames.some((n) => n.toLowerCase() === e.projectName.toLowerCase()))
        .map((g) => g.name);
      return names.length > 0 ? names : ['(no group)'];
    };
  })();

  const buckets = new Map<string, { key: Record<string, string | null>; minutes: number; entries: number }>();
  for (const e of entries) {
    // An entry counts once per group it belongs to when grouping by group.
    const groupNames = groupBy.includes('group') ? groupsOf(e) : [null];
    for (const groupName of groupNames) {
      const key: Record<string, string | null> = {};
      for (const dim of groupBy) {
        if (dim === 'day') key.date = e.date;
        else if (dim === 'week') key.week = e.weekStart;
        else if (dim === 'client') key.client = e.clientName;
        else if (dim === 'project') { key.client = key.client ?? e.clientName; key.project = e.projectName; }
        else if (dim === 'work_type') key.workType = e.workType ?? '(no work type)';
        else if (dim === 'note') key.note = e.notes ?? '(no note)';
        else if (dim === 'group') key.group = groupName;
      }
      const id = JSON.stringify(key);
      const b = buckets.get(id) ?? { key, minutes: 0, entries: 0 };
      b.minutes += e.minutes;
      b.entries += 1;
      buckets.set(id, b);
    }
  }

  const sum = (pick: (e: EntryRow) => boolean) => hours(entries.reduce((acc, e) => acc + (pick(e) ? e.minutes : 0), 0));
  return {
    ok: true,
    value: {
      range: { from, to },
      group,
      groupBy,
      rows: [...buckets.values()]
        .sort((a, b) => b.minutes - a.minutes)
        .map((b) => ({ ...b.key, hours: hours(b.minutes), entries: b.entries })),
      totals: {
        hours: sum(() => true),
        billableHours: sum((e) => e.isBillable === true),
        nonBillableHours: sum((e) => e.isBillable !== true),
        approvedHours: sum((e) => e.statusId === 'approved'),
        entries: entries.length,
      },
      coverage: coverage(db, from, to),
    },
  };
}

// ── ruddr_hours_entries ───────────────────────────────────────────────────────

export interface HoursEntries {
  range: { from: string; to: string };
  group: string | null;
  totalMatching: number;
  truncated: boolean;
  entries: Array<{
    date: string; client: string | null; project: string; workType: string | null;
    hours: number; note: string | null; status: string | null; billable: boolean | null;
  }>;
  coverage: HoursCoverage;
}

/** The individual entries (with notes) over a date range. */
export function listRuddrHourEntries(
  db: SqlJsDatabase,
  filters: HoursFilters & { note?: string; status?: string; limit?: number },
  now: Date = new Date(),
): Resolved<HoursEntries> {
  if (!hasEntryCache(db)) return { ok: false, error: NOT_CACHED };
  const base = filteredEntries(db, filters, now);
  if (!base.ok) return base;
  const { from, to, group } = base.value;
  const note = filters.note?.toLowerCase();
  const matching = base.value.entries.filter((e) =>
    (!note || (e.notes ?? '').toLowerCase().includes(note))
    && (!filters.status || e.statusId === filters.status));
  const limit = Math.max(1, Math.min(filters.limit ?? 200, 2000));
  return {
    ok: true,
    value: {
      range: { from, to },
      group,
      totalMatching: matching.length,
      truncated: matching.length > limit,
      entries: matching.slice(0, limit).map((e) => ({
        date: e.date,
        client: e.clientName,
        project: e.projectName,
        workType: e.workType,
        hours: hours(e.minutes),
        note: e.notes,
        status: e.statusId,
        billable: e.isBillable,
      })),
      coverage: coverage(db, from, to),
    },
  };
}

// ── ruddr_hours_status ────────────────────────────────────────────────────────

export interface HoursStatus {
  cacheAvailable: boolean;
  weeksCached: number;
  oldestWeek: string | null;
  newestWeek: string | null;
  /** Weeks between the oldest cached week and the current week that are not cached (yet). */
  gaps: string[];
  failedWeeks: Array<{ week: string; error: string | null; lastTriedAt: string }>;
  lastFetchedAt: string | null;
  entries: number;
  note: string;
}

/** How far back the hours cache reaches, and where it has holes. */
export function getRuddrHoursStatus(db: SqlJsDatabase, now: Date = new Date()): HoursStatus {
  const note = 'Hours are cached by the Jarvis app from Ruddr, a few weeks per run going back in time. '
    + 'The current week refreshes at most every 4 hours; older weeks become final once approved.';
  if (!hasEntryCache(db)) {
    return { cacheAvailable: false, weeksCached: 0, oldestWeek: null, newestWeek: null, gaps: [], failedWeeks: [], lastFetchedAt: null, entries: 0, note };
  }
  const weeks = (db.exec('SELECT week_start, status, error, fetched_at FROM ruddr_time_weeks ORDER BY week_start')[0]?.values ?? [])
    .map(([w, s, e, f]) => ({ week: String(w), status: String(s), error: e === null ? null : String(e), fetchedAt: String(f) }));
  const ok = weeks.filter((w) => w.status === 'ok').map((w) => w.week);
  const okSet = new Set(ok);
  const gaps: string[] = [];
  if (ok.length > 0) {
    for (let w = ok[0]; w <= mondayOf(localToday(now)); w = addDays(w, 7)) if (!okSet.has(w)) gaps.push(w);
  }
  const lastFetchedAt = weeks.reduce<string | null>((acc, w) => (acc === null || w.fetchedAt > acc ? w.fetchedAt : acc), null);
  const entries = Number(db.exec('SELECT COUNT(*) FROM ruddr_time_entries')[0]?.values[0]?.[0] ?? 0);
  return {
    cacheAvailable: true,
    weeksCached: ok.length,
    oldestWeek: ok[0] ?? null,
    newestWeek: ok[ok.length - 1] ?? null,
    gaps,
    failedWeeks: weeks.filter((w) => w.status !== 'ok').map((w) => ({ week: w.week, error: w.error, lastTriedAt: w.fetchedAt })),
    lastFetchedAt,
    entries,
    note,
  };
}
