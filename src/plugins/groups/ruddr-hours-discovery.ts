// ── Ruddr hours discovery ─────────────────────────────────────────────────────
// Slowly crawls the logged-in member's Ruddr week pages (newest first, then
// backwards in time) and caches the hours per day, project and task.
//
// Load on Ruddr is kept low on purpose: a run fetches at most
// HOURS_WEEKS_PER_RUN weeks with a random pause between pages, and weeks that
// can no longer change are never fetched again (see isWeekFinal). Every run
// works in its own background tab and never focuses the browser — a login
// prompt just pauses discovery until the user has logged in themselves.
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { saveDatabase } from '../../storage/database';
import { sendCommand, getBridgeStatus } from '../browser-companion/server';
import {
  createTabSession,
  navigatePayload,
  recordNavigationTab,
  closeSessionTab,
} from '../browser-companion/tab-session';
import type { BrowserTabSession } from '../browser-companion/tab-session';
import {
  addDays,
  isWeekStart,
  loadWeekRecords,
  localToday,
  mondayOf,
  parseWeekScrape,
  planWeeks,
  projectDayRows,
  projectTotals,
  projectsWithHours,
  saveWeek,
  saveWeekError,
} from '../../services/ruddr-hours';
import type { RuddrWeekScrape } from '../../services/ruddr-hours';
import { listGroups, loadRuddrProjectsFromDb, upsertDiscoveredRuddrProjects } from '../../services/groups';
import type { RuddrHoursStatus, RuddrHoursSummary, RuddrHoursWeek, RuddrHoursGroupTotals } from '../types';
import { logger } from '../../services/logger';
import { safeHandle } from '../ipc-utils';

export const HOURS_WEEKS_PER_RUN = 3;
export const HOURS_PAUSE_MIN_MS = 15_000;
export const HOURS_PAUSE_MAX_MS = 30_000;
const RUDDR_BASE = 'https://www.ruddr.io/app';
const SCRAPE_TIMEOUT_MS = 30_000;

type WeekOutcome = 'ok' | 'error' | 'login_required' | 'extension_outdated' | 'navigation_failed';

let queue: Promise<unknown> = Promise.resolve();
let running = false;
let lastRunAt: string | null = null;
let lastError: string | null = null;
let loginRequired = false;
let extensionOutdated = false;

/** Runs are serialized: a manual week refresh waits for a scheduled run and vice versa. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

export interface HoursDiscoveryDeps {
  getWorkspace: () => string;
  getWindow: () => BrowserWindow | null;
  /** Called with projects newly added to ruddr_projects. */
  onNewProjects?: (projects: Array<{ name: string; path: string }>) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchOneWeek(
  db: SqlJsDatabase,
  session: BrowserTabSession,
  workspace: string,
  weekStart: string,
): Promise<WeekOutcome> {
  const url = `${RUDDR_BASE}/${workspace}/time/week?date=${weekStart}`;
  const nav = await sendCommand({
    type: 'navigate',
    tabId: session.tabId,
    payload: { url, ...navigatePayload(session) },
  });
  if (!nav.ok) {
    lastError = `Navigation failed: ${nav.error ?? 'unknown'}`;
    return 'navigation_failed';
  }
  recordNavigationTab(session, nav.data);
  const navData = nav.data as { url?: string; tabId?: number } | null;
  if ((navData?.url ?? '').includes('/login')) return 'login_required';

  const resp = await sendCommand(
    { type: 'scrape-ruddr-week', tabId: session.tabId ?? navData?.tabId, payload: { date: weekStart, waitMs: 15_000 } },
    SCRAPE_TIMEOUT_MS,
  );
  if (!resp.ok) {
    if ((resp.error ?? '').includes('Unknown command type')) return 'extension_outdated';
    saveWeekError(db, weekStart, resp.error ?? 'scrape_failed');
    lastError = `${weekStart}: ${resp.error ?? 'scrape failed'}`;
    return 'error';
  }

  const parsed = parseWeekScrape(weekStart, resp.data as RuddrWeekScrape);
  if (!parsed.ok) {
    logger.warn(`[RuddrHours] Week ${weekStart} rejected: ${parsed.error}`);
    saveWeekError(db, weekStart, parsed.error);
    lastError = `${weekStart}: ${parsed.error}`;
    return 'error';
  }
  saveWeek(db, parsed.week);
  logger.debug(`[RuddrHours] Week ${weekStart}: ${parsed.week.entries.length} entries, ${parsed.week.totalMinutes / 60}h`);
  return 'ok';
}

async function fetchWeeks(
  db: SqlJsDatabase,
  deps: HoursDiscoveryDeps,
  weeks: string[],
): Promise<Record<string, unknown>> {
  const workspace = deps.getWorkspace();
  if (!workspace) return { skipped: true, reason: 'Ruddr workspace not configured' };
  const bridge = getBridgeStatus();
  if (!bridge.running || bridge.connectedClients === 0) return { skipped: true, reason: 'No browser extension connected' };

  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const outcomes: Record<string, WeekOutcome> = {};
  const session = createTabSession();
  running = true;
  lastError = null;
  broadcast(db, deps);
  try {
    for (const [i, week] of weeks.entries()) {
      if (i > 0) await sleep(HOURS_PAUSE_MIN_MS + Math.floor(random() * (HOURS_PAUSE_MAX_MS - HOURS_PAUSE_MIN_MS)));
      let outcome: WeekOutcome;
      try {
        outcome = await fetchOneWeek(db, session, workspace, week);
      } catch (err) {
        lastError = `${week}: ${err instanceof Error ? err.message : String(err)}`;
        outcome = 'navigation_failed';
      }
      outcomes[week] = outcome;
      loginRequired = outcome === 'login_required';
      extensionOutdated = outcome === 'extension_outdated';
      if (outcome === 'login_required' || outcome === 'extension_outdated' || outcome === 'navigation_failed') break;
    }
  } finally {
    await closeSessionTab(session);
    running = false;
    lastRunAt = new Date().toISOString();
  }

  const added = upsertDiscoveredRuddrProjects(db, projectsWithHours(db));
  saveDatabase();
  if (added.length > 0) {
    logger.info(`[RuddrHours] ${added.length} project(s) found through logged hours: ${added.map((p) => p.name).join(', ')}`);
    deps.onNewProjects?.(added);
  }
  broadcast(db, deps);

  const values = Object.values(outcomes);
  if (loginRequired) return { skipped: true, reason: 'Ruddr login required', outcomes };
  if (extensionOutdated) return { skipped: true, reason: 'Browser extension needs reloading (scrape-ruddr-week unknown)', outcomes };
  if (values.length > 0 && values.every((o) => o !== 'ok')) throw new Error(lastError ?? 'Every week failed');
  return { fetched: values.filter((o) => o === 'ok').length, outcomes, newProjects: added.length };
}

function broadcast(db: SqlJsDatabase, deps: HoursDiscoveryDeps): void {
  const win = deps.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('ruddr-hours:updated', getHoursStatus(db));
}

/** One scheduled discovery step: refresh due weeks, then backfill older ones. */
export function runRuddrHoursDiscovery(db: SqlJsDatabase, deps: HoursDiscoveryDeps): Promise<Record<string, unknown>> {
  return enqueue(async () => {
    const plan = planWeeks(loadWeekRecords(db), localToday(), Date.now(), HOURS_WEEKS_PER_RUN);
    if (plan.weeks.length === 0) return { skipped: true, reason: 'All weeks up to date', backfillDone: plan.backfillDone };
    return fetchWeeks(db, deps, plan.weeks);
  });
}

/** Re-fetch one week now, whatever its cache state. */
export function refreshRuddrHoursWeek(
  db: SqlJsDatabase,
  deps: HoursDiscoveryDeps,
  weekStart: string,
): Promise<Record<string, unknown>> {
  return enqueue(() => fetchWeeks(db, deps, [weekStart]));
}

export function getHoursStatus(db: SqlJsDatabase): RuddrHoursStatus {
  const records = loadWeekRecords(db);
  const ok = [...records.values()].filter((r) => r.status === 'ok').map((r) => r.weekStart).sort();
  const plan = planWeeks(records, localToday(), Date.now(), 1);
  return {
    running,
    weeksCached: ok.length,
    oldestWeek: ok[0] ?? null,
    newestWeek: ok[ok.length - 1] ?? null,
    erroredWeeks: [...records.values()].filter((r) => r.status === 'error').length,
    backfillDone: plan.backfillDone,
    lastRunAt,
    lastError,
    loginRequired,
    extensionOutdated,
  };
}

export function getHoursWeek(db: SqlJsDatabase, weekStart: string): RuddrHoursWeek {
  const record = loadWeekRecords(db).get(weekStart) ?? null;
  return {
    weekStart,
    fetchedAt: record?.fetchedAt ?? null,
    status: record?.status ?? null,
    error: record?.error ?? null,
    totalMinutes: record?.totalMinutes ?? 0,
    approvedMinutes: record?.approvedMinutes ?? 0,
    rows: projectDayRows(db, weekStart, addDays(weekStart, 6)),
  };
}

/**
 * Hours rolled up per group. A group owns a logged project when the project's
 * name is linked to the group, either directly or through the ruddr_projects
 * row sharing its path.
 */
export function getHoursSummary(db: SqlJsDatabase): RuddrHoursSummary {
  const today = localToday();
  const weekStart = mondayOf(today);
  const fourWeeksStart = addDays(weekStart, -21);
  const nameByPath = new Map(loadRuddrProjectsFromDb(db).map((p) => [p.path, p.name.toLowerCase()]));
  const groups = listGroups(db);
  const groupsByName = new Map<string, number[]>();
  for (const g of groups) {
    for (const n of g.ruddrProjectNames ?? []) {
      const key = n.toLowerCase();
      groupsByName.set(key, [...(groupsByName.get(key) ?? []), g.id]);
    }
  }
  const groupsFor = (path: string, name: string): number[] => {
    const ids = new Set([...(groupsByName.get(name.toLowerCase()) ?? []), ...(groupsByName.get(nameByPath.get(path) ?? '') ?? [])]);
    return [...ids];
  };

  const totals: Record<number, RuddrHoursGroupTotals> = {};
  const bucket = (id: number) => (totals[id] ??= { weekMinutes: 0, last4WeeksMinutes: 0, totalMinutes: 0, lastDate: null });
  const unlinked: RuddrHoursSummary['unlinked'] = [];

  for (const p of projectTotals(db)) {
    const ids = groupsFor(p.projectPath, p.projectName);
    for (const id of ids) {
      const b = bucket(id);
      b.totalMinutes += p.minutes;
      if (!b.lastDate || p.lastDate > b.lastDate) b.lastDate = p.lastDate;
    }
    if (ids.length === 0 && !p.projectPath.startsWith('label:')) {
      unlinked.push({ projectName: p.projectName, projectPath: p.projectPath, clientName: p.clientName, totalMinutes: p.minutes, lastDate: p.lastDate });
    }
  }
  for (const p of projectTotals(db, fourWeeksStart, addDays(weekStart, 6))) {
    for (const id of groupsFor(p.projectPath, p.projectName)) bucket(id).last4WeeksMinutes += p.minutes;
  }
  for (const p of projectTotals(db, weekStart, addDays(weekStart, 6))) {
    for (const id of groupsFor(p.projectPath, p.projectName)) bucket(id).weekMinutes += p.minutes;
  }
  unlinked.sort((a, b) => b.lastDate.localeCompare(a.lastDate));

  return { ok: true, status: getHoursStatus(db), groups: totals, unlinked };
}

export function registerRuddrHoursHandlers(db: SqlJsDatabase, deps: HoursDiscoveryDeps): void {
  safeHandle('ruddr-hours:status', () => getHoursStatus(db));
  safeHandle('ruddr-hours:summary', () => getHoursSummary(db));
  safeHandle('ruddr-hours:week', (_event, weekStart: unknown) => {
    if (!isWeekStart(weekStart)) return { ok: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' };
    return { ok: true, week: getHoursWeek(db, weekStart) };
  });
  safeHandle('ruddr-hours:refresh-week', async (_event, weekStart: unknown) => {
    if (!isWeekStart(weekStart)) return { ok: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' };
    try {
      const result = await refreshRuddrHoursWeek(db, deps, weekStart);
      return { ok: true, result, week: getHoursWeek(db, weekStart) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Test hook: reset module state between tests. */
export function _resetHoursDiscoveryState(): void {
  queue = Promise.resolve();
  running = false;
  lastRunAt = null;
  lastError = null;
  loginRequired = false;
  extensionOutdated = false;
}
