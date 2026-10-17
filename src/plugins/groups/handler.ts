// ── Groups IPC handlers ───────────────────────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import { Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import { saveDatabase, getConfigValue, setConfigValue } from '../../storage/database';
import {
  listGroups,
  getGroup,
  createGroup,
  renameGroup,
  deleteGroup,
  addLocalRepoToGroup,
  removeLocalRepoFromGroup,
  removeGithubRepoFromGroup,
  parseRuddrNames,
  loadRuddrProjectsFromDb,
  saveRuddrProjectsToDb,
  updateRuddrProjectNote,
  updateRuddrProjectCloudFolderUrl,
  lookupRuddrProject,
  loadRuddrBudgetsFromDb,
  saveRuddrBudgetToDb,
  parseSqliteUtc,
} from '../../services/groups';
import type { RuddrProjectEntry } from '../../services/groups';
import { sendCommand, getBridgeStatus } from '../browser-companion/server';
import {
  createTabSession,
  keepSessionTabOpen,
  closeSessionTab,
} from '../browser-companion/tab-session';
import type { BrowserTabSession } from '../browser-companion/tab-session';
import type { RuddrProjectMatch } from '../types';
import { ruddrApiGet, projectKeysFromPath, projectPath } from './ruddr-api';
import { logger } from '../../services/logger';
import { safeHandle } from '../ipc-utils';
import { registerRuddrHoursHandlers } from './ruddr-hours-discovery';
import type { HoursDiscoveryDeps } from './ruddr-hours-discovery';

// ── Ruddr project list cache (in-memory, backed by DB for persistence) ──────────
let ruddrProjectsCache: RuddrProjectEntry[] | null = null;
let ruddrProjectsCacheTime = 0;
/** Re-fetch after 8 hours so a long-running session stays reasonably fresh. */
const RUDDR_CACHE_TTL_MS = 8 * 60 * 60 * 1000;
/** Config key holding the epoch ms of the last successful Ruddr project-list fetch, so the TTL survives app restarts. */
const RUDDR_LAST_CHECKED_KEY = 'ruddr_projects_last_checked_at';

// ── Ruddr budget cache (in-memory, backed by DB for persistence) ─────────────
interface CachedBudget {
  /** The budget payload as returned to the renderer (without cache metadata). */
  result: Record<string, unknown>;
  /** Epoch ms of the last successful scrape. */
  fetchedAtMs: number;
}
const ruddrBudgetCache = new Map<string, CachedBudget>();
/**
 * Budgets are re-scraped at most once every 4 hours. Every scrape navigates the
 * user's browser to Ruddr, so opening the Groups dashboard must reuse whatever
 * is cached instead of refreshing on each visit.
 */
export const RUDDR_BUDGET_TTL_MS = 4 * 60 * 60 * 1000;
let budgetCacheSeeded = false;

/** Convert a persisted budget row into the payload shape the renderer expects. */
function budgetRowToResult(entry: {
  actualBillableHours: string | null; actualNonBillableHours: string | null;
  actualTotalHours: string | null; budget: string | null; budgetLeft: string | null;
  projectUrl: string | null; note: string | null; cloudFolderUrl: string | null;
}): Record<string, unknown> {
  return {
    ok: true,
    actualBillableHours: entry.actualBillableHours,
    actualNonBillableHours: entry.actualNonBillableHours,
    actualTotalHours: entry.actualTotalHours,
    budget: entry.budget,
    budgetLeft: entry.budgetLeft,
    projectUrl: entry.projectUrl ?? undefined,
    note: entry.note,
    cloudFolderUrl: entry.cloudFolderUrl,
  };
}

/**
 * Seeds the in-memory budget cache from the DB once per app session so the
 * dashboard can render known figures right after a restart.
 */
function seedBudgetCacheFromDb(db: SqlJsDatabase): void {
  if (budgetCacheSeeded) return;
  budgetCacheSeeded = true;
  try {
    const rows = loadRuddrBudgetsFromDb(db);
    for (const row of rows) {
      if (ruddrBudgetCache.has(row.projectName)) continue;
      ruddrBudgetCache.set(row.projectName, {
        result: budgetRowToResult(row),
        fetchedAtMs: parseSqliteUtc(row.fetchedAt),
      });
    }
    if (rows.length > 0) logger.debug(`[Groups] Ruddr budget cache seeded from DB: ${rows.length} entries`);
  } catch (err) {
    // Table may not exist yet on a database that has not been migrated.
    logger.debug('[Groups] Ruddr budget cache seed skipped:', err instanceof Error ? err.message : String(err));
  }
}

/** True when a cached budget is still within the TTL window. */
function isBudgetFresh(cached: CachedBudget | undefined): cached is CachedBudget {
  return cached !== undefined && Date.now() - cached.fetchedAtMs < RUDDR_BUDGET_TTL_MS;
}

/** Adds cache metadata (age + staleness) to a budget payload for the renderer. */
function withCacheMeta(cached: CachedBudget, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...cached.result,
    cached: true,
    fetchedAt: cached.fetchedAtMs > 0 ? new Date(cached.fetchedAtMs).toISOString() : null,
    stale: !isBudgetFresh(cached),
    ...extra,
  };
}

/** Config key for the Ruddr workspace slug (e.g. "xebia-xms-benelux"). */
const RUDDR_WORKSPACE_KEY = 'ruddr_workspace';

// ── Ruddr API health ─────────────────────────────────────────────────────────

/**
 * Config key holding the epoch ms of the last "cannot read Ruddr budgets"
 * alert. Set when Ruddr's API answers with a shape Jarvis can't read,
 * cleared again as soon as a budget is found — so the end user is notified
 * once per outage instead of once per project.
 */
const RUDDR_BUDGET_ALERT_KEY = 'ruddr_budget_alert_at';

/** Formats Ruddr hours as the plain string the dashboard expects ("514", "-174", "340.5"). */
export function formatRuddrHours(hours: number): string {
  return String(Math.round(hours * 100) / 100);
}

/** Desktop notification for the "Ruddr budgets are unreadable" state. */
function notifyRuddrBudgetScrapeBroken(projectName: string): void {
  const body = `Ruddr's API answered in a format Jarvis doesn't recognise — no budget figures could be read for "${projectName}". Budgets keep their last known values until Jarvis is updated.`;
  logger.warn(`[Groups] Ruddr budget API unreadable for "${projectName}" — Ruddr may have changed its API.`);
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title: 'Jarvis cannot read Ruddr budgets', body }).show();
  } catch (err) {
    logger.warn('[Groups] Could not show Ruddr budget alert notification:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Raises or clears the persisted Ruddr budget-scrape alert. The desktop
 * notification fires once per outage (on the healthy → broken transition);
 * recovery clears the key so a future breakage alerts again.
 */
function updateRuddrBudgetScrapeAlert(db: SqlJsDatabase, broken: boolean, projectName: string): void {
  const alerted = getConfigValue(db, RUDDR_BUDGET_ALERT_KEY);
  if (broken && !alerted) {
    setConfigValue(db, RUDDR_BUDGET_ALERT_KEY, String(Date.now()));
    saveDatabase();
    notifyRuddrBudgetScrapeBroken(projectName);
  } else if (!broken && alerted) {
    db.run('DELETE FROM config WHERE key = ?', [RUDDR_BUDGET_ALERT_KEY]);
    saveDatabase();
    logger.info('[Groups] Ruddr budget scrape healthy again — alert cleared.');
  }
}

export function getRuddrWorkspace(db: SqlJsDatabase): string {
  return (getConfigValue(db, RUDDR_WORKSPACE_KEY) ?? '').trim();
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function scoreMatch(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1.0;
  if (c.includes(q) || q.includes(c)) return 0.9;
  const qTokens = q.split(' ').filter(Boolean);
  const cTokens = c.split(' ').filter(Boolean);
  const exact = qTokens.filter((t) => cTokens.includes(t)).length;
  if (exact > 0) return 0.5 + (exact / Math.max(qTokens.length, cTokens.length)) * 0.35;
  const partial = qTokens.some((qt) =>
    cTokens.some((ct) => ct.startsWith(qt) || qt.startsWith(ct)),
  );
  if (partial) return 0.2;
  return 0;
}

/** Projects per API page; Ruddr's own list asks for 25. */
const RUDDR_PROJECT_PAGE_SIZE = 100;
const RUDDR_PROJECT_MAX_PAGES = 20;

/**
 * The workspace's active projects from Ruddr's paged projects API — the call
 * behind the Portfolio → Projects list — instead of scrolling that list.
 */
async function fetchRuddrProjectList(
  session: BrowserTabSession,
  workspace: string,
): Promise<{ ok: true; projects: Array<{ name: string; path: string }> } | { ok: false; error: string }> {
  const projects: Array<{ name: string; path: string }> = [];
  for (let page = 0; page < RUDDR_PROJECT_MAX_PAGES; page++) {
    const res = await ruddrApiGet(session, workspace, [
      `projects?page=${page}&size=${RUDDR_PROJECT_PAGE_SIZE}&sort=name:asc&projectRecordStatusId=active`,
    ]);
    if (!res.ok) return { ok: false, error: res.reason === 'login_required' ? 'login_required' : res.error };
    const { status, body } = res.responses[0] ?? { status: 0, body: null };
    const data = body as { results?: Array<{ name?: string; key?: string; client?: { key?: string } }>; total?: number } | null;
    if (status !== 200 || !Array.isArray(data?.results)) return { ok: false, error: `Ruddr projects request failed (HTTP ${status})` };
    for (const p of data.results) {
      if (p.name && p.key && p.client?.key) projects.push({ name: p.name.trim(), path: projectPath(workspace, p.client.key, p.key) });
    }
    if (data.results.length < RUDDR_PROJECT_PAGE_SIZE || (typeof data.total === 'number' && projects.length >= data.total)) break;
  }
  logger.debug(`[Groups] Ruddr projects API returned ${projects.length} active projects`);
  return { ok: true, projects };
}

/**
 * Ensures ruddrProjectsCache is populated. Returns an error string on
 * failure, or null on success (cache is guaranteed non-null after null return).
 *
 * Pass a `session` to run the scrape in its own browser tab; the caller closes
 * that tab with closeSessionTab() once the whole run is finished.
 */
async function ensureRuddrCache(
  db: SqlJsDatabase,
  session?: BrowserTabSession,
): Promise<string | null> {
  const cacheExpired = Date.now() - ruddrProjectsCacheTime > RUDDR_CACHE_TTL_MS;
  if (ruddrProjectsCache !== null && ruddrProjectsCache.length > 0 && !cacheExpired) return null;

  const status = getBridgeStatus();
  if (!status.running || status.connectedClients === 0)
    return 'No browser extension connected. Open the Browser Companion tab and ensure the extension is active.';

  const workspace = getRuddrWorkspace(db);
  if (!workspace) return 'ruddr_workspace_not_configured';

  const oldLen = ruddrProjectsCache?.length ?? 0;
  const fetched = await fetchRuddrProjectList(session ?? createTabSession(), workspace);
  if (!fetched.ok) {
    if (fetched.error === 'login_required' && session?.tabId !== undefined) {
      // The user has to log in here — leave the tab open for them.
      keepSessionTabOpen(session);
      sendCommand({ type: 'focus-window', tabId: session.tabId, payload: {} }).catch(() => { /* non-fatal */ });
    }
    return fetched.error;
  }
  const freshProjects = fetched.projects;

  if (freshProjects.length === 0) {
    if (oldLen === 0) {
      logger.warn('[Groups] Ruddr returned 0 projects and the cache is empty.');
      return 'ruddr_no_projects_found';
    }
    logger.warn(`[Groups] Ruddr returned no projects — keeping old cache of ${oldLen}.`);
  } else {
    // Merge notes from old DB entries into the fresh list before saving
    const oldEntries = loadRuddrProjectsFromDb(db);
    const oldByPath = new Map(oldEntries.map((e) => [e.path, e]));
    const mergedProjects = freshProjects.map((p) => ({
      ...p,
      note: oldByPath.get(p.path)?.note ?? null,
      cloud_folder_url: oldByPath.get(p.path)?.cloud_folder_url ?? null,
    }));

    // Detect truly new projects (not in old DB cache)
    const oldNames = new Set(oldEntries.map((e) => e.name));
    const newProjects = mergedProjects.filter((p) => !oldNames.has(p.name));

    ruddrProjectsCache = mergedProjects;
    ruddrProjectsCacheTime = Date.now();
    logger.debug(`[Groups] Ruddr projects cached: ${ruddrProjectsCache.length} entries`);
    try {
      saveRuddrProjectsToDb(db, mergedProjects);
      setConfigValue(db, RUDDR_LAST_CHECKED_KEY, String(ruddrProjectsCacheTime));
      saveDatabase();
    } catch (err) {
      logger.warn('[Groups] Failed to persist Ruddr projects to DB:', err);
    }

    if (newProjects.length > 0) {
      logger.debug(`[Groups] ${newProjects.length} new Ruddr project(s) found:`, newProjects.map((p) => p.name).join(', '));
      _notifyNewProjects(newProjects);
    }
  }

  return null;
}

/**
 * Pre-warms the Ruddr projects cache at app startup.
 *
 * Always seeds the in-memory cache from the DB (cheap, no network). The live
 * Ruddr scrape is skipped unless the persisted last-checked timestamp is
 * older than RUDDR_CACHE_TTL_MS, so restarting the app doesn't trigger a
 * fresh browser scrape every time.
 */
export async function prewarmRuddrCache(db: SqlJsDatabase): Promise<void> {
  // Seed the persisted budget cache first so the Groups dashboard has data to
  // render the moment it is opened, even before any scrape runs.
  seedBudgetCacheFromDb(db);

  // Restore the real last-checked time from the DB so the TTL below reflects
  // when Ruddr was last actually checked, not just when this process booted.
  const persistedCheckedAt = Number(getConfigValue(db, RUDDR_LAST_CHECKED_KEY) ?? '');
  const lastCheckedAt = Number.isFinite(persistedCheckedAt) ? persistedCheckedAt : 0;
  ruddrProjectsCacheTime = lastCheckedAt;

  // Seed the in-memory cache from DB immediately — no browser extension needed.
  if (ruddrProjectsCache === null || ruddrProjectsCache.length === 0) {
    const persisted = loadRuddrProjectsFromDb(db);
    if (persisted.length > 0) {
      ruddrProjectsCache = persisted;
      logger.debug(`[Groups] Ruddr cache seeded from DB: ${persisted.length} projects`);
    }
  }

  // Skip the live scrape entirely if we checked Ruddr recently — no reason to
  // open a browser tab and hit the network on every app start.
  const dueForCheck = Date.now() - lastCheckedAt > RUDDR_CACHE_TTL_MS;
  if (!dueForCheck) {
    logger.debug(`[Groups] Ruddr check skipped — last checked ${new Date(lastCheckedAt).toISOString()}, within TTL`);
    return;
  }

  // Then try to refresh from browser if connected.
  const session = createTabSession();
  try {
    const err = await ensureRuddrCache(db, session);
    if (err) logger.debug(`[Groups] Ruddr pre-warm skipped: ${err}`);
  } finally {
    await closeSessionTab(session);
  }
}

// ── Hourly Ruddr project refresh ─────────────────────────────────────────────
// Holds the window getter so we can emit notifications to the renderer.
let _notifyNewProjects: (projects: RuddrProjectEntry[]) => void = () => { /* no-op until scheduled */ };
let _getWindowFn: () => BrowserWindow | null = () => null;

/**
 * After a successful project-list refresh, silently scrape the overview page
 * for each group-linked project that is still missing a note or cloud folder URL.
 * Emits 'groups:project-details-refreshed' when at least one project was updated.
 *
 * Shares the caller's browser tab session so every group is scraped in the same
 * tab; the caller closes it once all groups are done.
 */
async function refreshLinkedProjectDetails(
  db: SqlJsDatabase,
  session?: BrowserTabSession,
): Promise<void> {
  const status = getBridgeStatus();
  if (!status.running || status.connectedClients === 0) return;

  const groups = listGroups(db);
  const linkedNames = [...new Set(groups.flatMap((g) => g.ruddrProjectNames ?? []))];
  if (linkedNames.length === 0) return;

  // Collect cache entries that are missing note or cloud_folder_url
  const toRefresh = linkedNames.reduce<RuddrProjectEntry[]>((acc, name) => {
    const entry = ruddrProjectsCache?.find((e) => e.name === name)
      ?? ruddrProjectsCache?.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (entry?.path && (!entry.note || !entry.cloud_folder_url)) {
      acc.push(entry);
    }
    return acc;
  }, []);

  if (toRefresh.length === 0) return;

  const workspace = getRuddrWorkspace(db);
  if (!workspace) return;
  logger.debug(`[Groups] Auto-refreshing details for ${toRefresh.length} linked project(s) missing note/cloud folder`);
  let updated = false;

  // One API call for all of them: the project record holds the description
  // (shown as the note) and the cloud folder URL.
  const withKeys = toRefresh
    .map((entry) => ({ entry, keys: projectKeysFromPath(entry.path) }))
    .filter((x): x is { entry: RuddrProjectEntry; keys: { clientKey: string; projectKey: string } } => x.keys !== null)
    .slice(0, 25);
  if (withKeys.length === 0) return;
  const res = await ruddrApiGet(
    session ?? createTabSession(),
    workspace,
    withKeys.map(({ keys }) => `clients/${keys.clientKey}/projects/${keys.projectKey}`),
  );
  if (!res.ok) {
    logger.debug(`[Groups] Auto-refresh details skipped: ${res.error}`);
    if (res.reason === 'login_required') keepSessionTabOpen(session);
    return;
  }

  withKeys.forEach(({ entry }, i) => {
    const { status, body } = res.responses[i] ?? { status: 0, body: null };
    const project = body as { description?: unknown; cloudFolderUrl?: unknown } | null;
    if (status !== 200 || !project) {
      logger.warn(`[Groups]   project details for "${entry.name}" failed (HTTP ${status})`);
      return;
    }
    const note = typeof project.description === 'string' ? project.description : null;
    const cloudFolderUrl = typeof project.cloudFolderUrl === 'string' ? project.cloudFolderUrl : null;
    if (note === null && cloudFolderUrl === null) return;
    try {
      if (note !== null) updateRuddrProjectNote(db, entry.path, note);
      if (cloudFolderUrl !== null) updateRuddrProjectCloudFolderUrl(db, entry.path, cloudFolderUrl);
      if (ruddrProjectsCache) {
        const idx = ruddrProjectsCache.findIndex((e) => e.path === entry.path);
        if (idx !== -1) ruddrProjectsCache[idx] = {
          ...ruddrProjectsCache[idx],
          ...(note !== null ? { note } : {}),
          ...(cloudFolderUrl !== null ? { cloud_folder_url: cloudFolderUrl } : {}),
        };
      }
      updated = true;
    } catch { /* non-fatal */ }
  });
  if (updated) saveDatabase();

  if (updated) {
    const win = _getWindowFn();
    if (win && !win.isDestroyed()) {
      win.webContents.send('groups:project-details-refreshed');
    }
  }
}

/**
 * Dependencies for the hours discovery: projects it finds through logged hours
 * join the in-memory project cache and raise the same "new project" banner as
 * the project-list refresh.
 */
export function hoursDiscoveryDeps(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): HoursDiscoveryDeps {
  return {
    getWorkspace: () => getRuddrWorkspace(db),
    getWindow,
    onNewProjects: (projects) => {
      if (ruddrProjectsCache) {
        const known = new Set(ruddrProjectsCache.map((e) => e.path));
        ruddrProjectsCache = [...ruddrProjectsCache, ...projects.filter((p) => !known.has(p.path))];
      }
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('groups:new-ruddr-projects', projects);
    },
  };
}

/** Refreshes the Ruddr project list for the main-process task scheduler. */
export async function refreshRuddrProjectsInBackground(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
  forceFresh = false,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  _getWindowFn = getWindow;
  _notifyNewProjects = (projects: RuddrProjectEntry[]) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('groups:new-ruddr-projects', projects);
    }
  };

  if (forceFresh) ruddrProjectsCacheTime = 0;

  // One tab for the whole run: the project list plus every linked group. It is
  // closed below once all groups are done — but only if we opened it ourselves.
  const session = createTabSession();
  try {
    const err = await ensureRuddrCache(db, session).catch((e: unknown) => String(e));
    if (err) {
      logger.debug('[Groups] Scheduled Ruddr refresh skipped:', err);
      return { ok: true, skipped: true, error: err };
    }

    await refreshLinkedProjectDetails(db, session).catch((e: unknown) =>
      logger.warn('[Groups] Auto-refresh project details failed:', e instanceof Error ? e.message : String(e)),
    );
    return { ok: true };
  } finally {
    await closeSessionTab(session);
  }
}

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  registerRuddrHoursHandlers(db, hoursDiscoveryDeps(db, _getWindow));

  // Make persisted budgets available to the very first dashboard query.
  seedBudgetCacheFromDb(db);

  safeHandle('groups:list', () => {
    return listGroups(db);
  });

  safeHandle('groups:get', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return null;
    return getGroup(db, groupId);
  });

  safeHandle('groups:create', (_event, name: string) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: 'Name is required' };
    }
    const id = createGroup(db, name.trim());
    saveDatabase();
    return { ok: true, id };
  });

  safeHandle('groups:rename', (_event, groupId: number, newName: string) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof newName !== 'string' || newName.trim().length === 0) {
      return { ok: false, error: 'Name is required' };
    }
    renameGroup(db, groupId, newName.trim());
    saveDatabase();
    return { ok: true };
  });

  safeHandle('groups:delete', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    deleteGroup(db, groupId);
    saveDatabase();
    return { ok: true };
  });

  safeHandle('groups:add-local-repo', (_event, groupId: number, localRepoId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof localRepoId !== 'number') return { ok: false, error: 'Invalid localRepoId' };
    addLocalRepoToGroup(db, groupId, localRepoId);
    saveDatabase();
    return { ok: true };
  });

  safeHandle('groups:remove-local-repo', (_event, groupId: number, localRepoId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof localRepoId !== 'number') return { ok: false, error: 'Invalid localRepoId' };
    removeLocalRepoFromGroup(db, groupId, localRepoId);
    saveDatabase();
    return { ok: true };
  });

  safeHandle('groups:remove-github-repo', (_event, groupId: number, githubRepoId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof githubRepoId !== 'number') return { ok: false, error: 'Invalid githubRepoId' };
    removeGithubRepoFromGroup(db, groupId, githubRepoId);
    saveDatabase();
    return { ok: true };
  });

  // ── Ruddr project linking ─────────────────────────────────────────────────

  safeHandle('groups:find-ruddr-projects', async (_event, groupName: string) => {
    if (typeof groupName !== 'string' || !groupName.trim())
      return { ok: false, error: 'Invalid groupName' };

    const session = createTabSession();
    try {
      const err = await ensureRuddrCache(db, session);
      if (err) return { ok: false, error: err };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await closeSessionTab(session);
    }

    const cache = ruddrProjectsCache;
    if (!cache) return { ok: false, error: 'Cache not populated after refresh.' };
    const matches: RuddrProjectMatch[] = cache
      .map(({ name, path }) => ({ name, path, score: scoreMatch(groupName.trim(), name) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score);

    return { ok: true, allCount: cache.length, matches };
  });

  safeHandle('groups:set-ruddr-project', (_event, groupId: number, projectName: string | null) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (projectName === null || projectName === undefined) {
      // Clear all linked projects
      db.run(
        `UPDATE groups SET ruddr_project_name = NULL, updated_at = datetime('now') WHERE id = ?`,
        [groupId],
      );
    } else {
      // Append to existing array (no duplicates)
      const stmt = db.prepare('SELECT ruddr_project_name FROM groups WHERE id = ?');
      stmt.bind([groupId]);
      let current: string[] = [];
      if (stmt.step()) {
        const row = stmt.getAsObject() as { ruddr_project_name: string | null };
        current = parseRuddrNames(row.ruddr_project_name);
      }
      stmt.free();
      const name = String(projectName).trim();
      if (name && !current.includes(name)) current.push(name);
      db.run(
        `UPDATE groups SET ruddr_project_name = ?, updated_at = datetime('now') WHERE id = ?`,
        [JSON.stringify(current), groupId],
      );
    }
    saveDatabase();
    return { ok: true };
  });

  safeHandle('groups:remove-ruddr-project', (_event, groupId: number, projectName: string) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof projectName !== 'string') return { ok: false, error: 'Invalid projectName' };
    const stmt = db.prepare('SELECT ruddr_project_name FROM groups WHERE id = ?');
    stmt.bind([groupId]);
    let current: string[] = [];
    if (stmt.step()) {
      const row = stmt.getAsObject() as { ruddr_project_name: string | null };
      current = parseRuddrNames(row.ruddr_project_name);
    }
    stmt.free();
    const updated = current.filter((n) => n !== projectName.trim());
    db.run(
      `UPDATE groups SET ruddr_project_name = ?, updated_at = datetime('now') WHERE id = ?`,
      [updated.length ? JSON.stringify(updated) : null, groupId],
    );
    saveDatabase();
    return { ok: true };
  });

  safeHandle('groups:refresh-ruddr-cache', () => {
    ruddrProjectsCache = null;
    return { ok: true };
  });

  safeHandle('groups:get-ruddr-cache', () => {
    return { ok: true, projects: ruddrProjectsCache?.map((e) => e.name) ?? [] };
  });

  safeHandle('groups:get-ruddr-workspace', () => {
    return { ok: true, workspace: getRuddrWorkspace(db) };
  });

  safeHandle('groups:get-ruddr-budget', async (_event, projectName: string, options?: { force?: boolean }) => {
    if (typeof projectName !== 'string' || !projectName.trim())
      return { ok: false, error: 'Invalid projectName' };

    const trimmed = projectName.trim();
    const force = options?.force === true;

    // Serve the persisted cache while it is still inside the TTL window — a
    // scrape hijacks the user's browser, so only do it when the data is stale
    // or the user explicitly asked for a refresh.
    seedBudgetCacheFromDb(db);
    const cachedBudget = ruddrBudgetCache.get(trimmed);
    if (!force && isBudgetFresh(cachedBudget)) return withCacheMeta(cachedBudget);

    /** Falls back to stale cached data when a background refresh cannot run. */
    const cachedOr = (error: string) => {
      if (!force && cachedBudget) return withCacheMeta(cachedBudget, { refreshError: error });
      return { ok: false, error };
    };

    const status = getBridgeStatus();
    if (!status.running || status.connectedClients === 0)
      return cachedOr('No browser extension connected.');

    const workspace = getRuddrWorkspace(db);
    if (!workspace) return cachedOr('ruddr_workspace_not_configured');

    // Look up the project path from the in-memory cache or DB.
    // Do NOT refetch the whole project list just for a path lookup —
    // that would hit Ruddr for every project each time a budget is loaded.
    const findEntry = () =>
      ruddrProjectsCache?.find((e) => e.name === trimmed)
      ?? ruddrProjectsCache?.find((e) => e.name.toLowerCase() === trimmed.toLowerCase())
      ?? ruddrProjectsCache?.find((e) => normalize(e.name) === normalize(trimmed));

    let entry = findEntry();
    // Fallback: check DB directly (in case the in-memory cache was never populated
    // but the DB has the row, e.g. immediately after app restart).
    if (!entry?.path) {
      try {
        const dbEntry = lookupRuddrProject(db, trimmed);
        if (dbEntry?.path) {
          entry = dbEntry;
          // Also warm the in-memory cache with DB data so subsequent lookups are fast.
          if (ruddrProjectsCache === null) ruddrProjectsCache = [];
          if (!ruddrProjectsCache.find((e) => e.path === dbEntry.path)) {
            ruddrProjectsCache.push(dbEntry);
          }
        }
      } catch { /* table may not exist yet — handled below */ }
    }

    if (!entry?.path) {
      const cacheSize = ruddrProjectsCache?.length ?? 0;
      logger.warn(`[Groups] Budget: no cache entry for "${trimmed}". Cache has ${cacheSize} entries.`);
      return cachedOr(cacheSize > 0 ? 'project_not_in_ruddr' : 'project_url_unknown');
    }

    const overviewUrl = `https://www.ruddr.io${entry.path}/overview`;
    const keys = projectKeysFromPath(entry.path);
    if (!keys) return cachedOr('project_url_unknown');
    // Two API calls in one background tab: the project record (id, note,
    // cloud folder) and its hours KPI (actual and budgeted hours).
    const session = createTabSession();
    try {
      const projectRes = await ruddrApiGet(session, workspace, [`clients/${keys.clientKey}/projects/${keys.projectKey}`]);
      if (!projectRes.ok) {
        if (projectRes.reason === 'login_required' && session.tabId !== undefined) {
          // The user asked for this budget — leave the tab open so they can log in.
          keepSessionTabOpen(session);
          sendCommand({ type: 'focus-window', tabId: session.tabId, payload: {} }).catch(() => { /* non-fatal */ });
        }
        return cachedOr(projectRes.error);
      }
      const projectResp = projectRes.responses[0];
      if (projectResp?.status === 404) return cachedOr('project_not_in_ruddr');
      const project = projectResp?.body as { id?: unknown; description?: unknown; cloudFolderUrl?: unknown } | null;
      if (projectResp?.status !== 200 || typeof project?.id !== 'string') {
        updateRuddrBudgetScrapeAlert(db, true, trimmed);
        return cachedOr('ruddr_api_changed');
      }
      const note = typeof project.description === 'string' ? project.description : null;
      const cloudFolderUrl = typeof project.cloudFolderUrl === 'string' ? project.cloudFolderUrl : null;

      const kpiRes = await ruddrApiGet(session, workspace, [`projects/${encodeURIComponent(project.id)}/kpi/hours`]);
      if (!kpiRes.ok) return cachedOr(kpiRes.error);
      type HoursSplit = { billable?: unknown; nonBillable?: unknown; total?: unknown };
      const kpi = kpiRes.responses[0]?.body as { actual?: HoursSplit; budget?: HoursSplit } | null;
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const actualBillable = num(kpi?.actual?.billable);
      const actualNonBillable = num(kpi?.actual?.nonBillable);
      const actualTotal = num(kpi?.actual?.total);
      const budgetTotal = num(kpi?.budget?.total);
      if (kpiRes.responses[0]?.status !== 200 || actualTotal === null) {
        // Ruddr changed its API — keep the cached figures and tell the user once.
        updateRuddrBudgetScrapeAlert(db, true, trimmed);
        return cachedOr('ruddr_api_changed');
      }
      updateRuddrBudgetScrapeAlert(db, false, trimmed);

      const fmt = (h: number | null) => (h === null ? null : formatRuddrHours(h));
      const budgetResult = {
        ok: true,
        actualBillableHours: fmt(actualBillable),
        actualNonBillableHours: fmt(actualNonBillable),
        actualTotalHours: fmt(actualTotal),
        // A project without a budget reports 0, which the dashboard shows as "No budget set".
        budget: fmt(budgetTotal ?? 0),
        budgetLeft: fmt((budgetTotal ?? 0) - actualTotal),
        projectUrl: overviewUrl,
        note: note,
        cloudFolderUrl: cloudFolderUrl,
      };
      const fetchedAtMs = Date.now();
      ruddrBudgetCache.set(trimmed, { result: budgetResult, fetchedAtMs });
      // Persist the budget itself so the dashboard can render it instantly after
      // an app restart instead of re-scraping every project on open.
      try {
        saveRuddrBudgetToDb(db, {
          projectName: trimmed,
          actualBillableHours: budgetResult.actualBillableHours,
          actualNonBillableHours: budgetResult.actualNonBillableHours,
          actualTotalHours: budgetResult.actualTotalHours,
          budget: budgetResult.budget,
          budgetLeft: budgetResult.budgetLeft,
          projectUrl: budgetResult.projectUrl,
          note,
          cloudFolderUrl,
        });
        saveDatabase();
      } catch (err) {
        logger.warn('[Groups] Failed to persist Ruddr budget:', err instanceof Error ? err.message : String(err));
      }
      // Persist the note and cloud folder URL to the DB cache for display in group cards.
      if ((note !== null || cloudFolderUrl !== null) && entry.path) {
        try {
          if (note !== null) {
            updateRuddrProjectNote(db, entry.path, note);
          }
          if (cloudFolderUrl !== null) {
            updateRuddrProjectCloudFolderUrl(db, entry.path, cloudFolderUrl);
          }
          if (ruddrProjectsCache) {
            const idx = ruddrProjectsCache.findIndex((e) => e.path === entry.path);
            if (idx !== -1) ruddrProjectsCache[idx] = {
              ...ruddrProjectsCache[idx],
              ...(note !== null ? { note } : {}),
              ...(cloudFolderUrl !== null ? { cloud_folder_url: cloudFolderUrl } : {}),
            };
          }
          saveDatabase();
        } catch { /* non-fatal */ }
      }
      return { ...budgetResult, fetchedAt: new Date(fetchedAtMs).toISOString(), stale: false };
    } catch (err) {
      return cachedOr(err instanceof Error ? err.message : String(err));
    } finally {
      await closeSessionTab(session);
    }
  });

  safeHandle('groups:get-ruddr-budget-cache', () => {
    seedBudgetCacheFromDb(db);
    const budgets: Record<string, Record<string, unknown>> = {};
    ruddrBudgetCache.forEach((value, key) => { budgets[key] = withCacheMeta(value); });
    return { ok: true, budgets };
  });

  safeHandle('groups:set-ruddr-workspace', (_event, workspace: string) => {
    if (typeof workspace !== 'string') return { ok: false, error: 'Invalid workspace' };
    const trimmed = workspace.trim();
    if (trimmed) {
      setConfigValue(db, RUDDR_WORKSPACE_KEY, trimmed);
    } else {
      // Clearing the workspace — remove the key
      db.run(`DELETE FROM config WHERE key = ?`, [RUDDR_WORKSPACE_KEY]);
    }
    saveDatabase();
    // Invalidate the project cache so the next search re-scrapes under the new workspace
    ruddrProjectsCache = null;
    ruddrProjectsCacheTime = 0;
    return { ok: true };
  });

  // ── Ruddr: manual sync + project info ──────────────────────────────────────

  safeHandle('groups:sync-ruddr-cache-now', async () => {
    // Force re-fetch regardless of TTL
    ruddrProjectsCacheTime = 0;
    const session = createTabSession();
    let err: string | null;
    try {
      err = await ensureRuddrCache(db, session);
    } catch (e) {
      // Don't leave our tab behind when the scrape blows up.
      await closeSessionTab(session);
      throw e;
    }
    if (err) {
      await closeSessionTab(session);
      return { ok: false, error: err };
    }
    // Fire-and-forget: refresh note/cloud folder from the edit page for linked
    // projects, then close the tab once every group has been visited.
    void refreshLinkedProjectDetails(db, session)
      .catch((e: unknown) =>
        logger.warn('[Groups] Manual sync: project details refresh failed:', e instanceof Error ? e.message : String(e)),
      )
      .finally(() => closeSessionTab(session));
    return { ok: true, count: ruddrProjectsCache?.length ?? 0 };
  });

  safeHandle('groups:get-ruddr-project-info', (_event, projectName: string) => {
    if (typeof projectName !== 'string') return { ok: false, error: 'Invalid projectName' };
    // Try in-memory cache first, then DB
    const memEntry = ruddrProjectsCache?.find(
      (e) => e.name.toLowerCase() === projectName.trim().toLowerCase(),
    );
    if (memEntry) return { ok: true, name: memEntry.name, path: memEntry.path, note: memEntry.note ?? null, cloudFolderUrl: memEntry.cloud_folder_url ?? null };
    const dbEntry = lookupRuddrProject(db, projectName.trim());
    if (dbEntry) return { ok: true, name: dbEntry.name, path: dbEntry.path, note: dbEntry.note ?? null, cloudFolderUrl: dbEntry.cloud_folder_url ?? null };
    return { ok: false, error: 'Project not found in cache' };
  });

  safeHandle('groups:list-ruddr-projects', () => {
    const projects = loadRuddrProjectsFromDb(db);
    return {
      ok: true,
      projects: projects.map((p) => ({ name: p.name, path: p.path, discoveredAt: p.discovered_at ?? null })),
    };
  });
}
