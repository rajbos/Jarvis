// ── Groups IPC handlers ───────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
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
  addGithubRepoToGroup,
  removeGithubRepoFromGroup,
  parseRuddrNames,
  loadRuddrProjectsFromDb,
  saveRuddrProjectsToDb,
  updateRuddrProjectNote,
  updateRuddrProjectCloudFolderUrl,
  lookupRuddrProject,
} from '../../services/groups';
import type { RuddrProjectEntry } from '../../services/groups';
import { sendCommand, getBridgeStatus } from '../browser-companion/server';
import type { RuddrProjectMatch } from '../types';

// ── Ruddr project list cache (in-memory, backed by DB for persistence) ──────────
let ruddrProjectsCache: RuddrProjectEntry[] | null = null;
let ruddrProjectsCacheTime = 0;
/** Re-fetch after 8 hours so a long-running session stays reasonably fresh. */
const RUDDR_CACHE_TTL_MS = 8 * 60 * 60 * 1000;

// ── Ruddr budget cache (in-memory, per app session) ──────────────────────────
const ruddrBudgetCache = new Map<string, Record<string, unknown>>();

const RUDDR_BASE = 'https://www.ruddr.io/app';
/** Config key for the Ruddr workspace slug (e.g. "xebia-xms-benelux"). */
const RUDDR_WORKSPACE_KEY = 'ruddr_workspace';

function getRuddrWorkspace(db: SqlJsDatabase): string {
  return (getConfigValue(db, RUDDR_WORKSPACE_KEY) ?? '').trim();
}

function getRuddrProjectsUrl(db: SqlJsDatabase): string {
  const ws = getRuddrWorkspace(db);
  return ws ? `${RUDDR_BASE}/${ws}/portfolio/projects` : '';
}

function getRuddrMyProjectsUrl(db: SqlJsDatabase): string {
  const ws = getRuddrWorkspace(db);
  return ws ? `${RUDDR_BASE}/${ws}/my-projects` : '';
}
// Project anchors — select the <a> tag directly so we also capture the href.
// 'cell-name' is a stable non-hashed class applied by Ruddr to the name column.
const RUDDR_PROJECT_SELECTOR = '.cell-name a';

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

/**
 * Ensures ruddrProjectsCache is populated. Returns an error string on
 * failure, or null on success (cache is guaranteed non-null after null return).
 */
async function ensureRuddrCache(db: SqlJsDatabase): Promise<string | null> {
  const cacheExpired = Date.now() - ruddrProjectsCacheTime > RUDDR_CACHE_TTL_MS;
  if (ruddrProjectsCache !== null && ruddrProjectsCache.length > 0 && !cacheExpired) return null;

  const status = getBridgeStatus();
  if (!status.running || status.connectedClients === 0)
    return 'No browser extension connected. Open the Browser Companion tab and ensure the extension is active.';

  const ruddrProjectsUrl = getRuddrProjectsUrl(db);
  if (!ruddrProjectsUrl) return 'ruddr_workspace_not_configured';

  const navResp = await sendCommand({ type: 'navigate', payload: { url: ruddrProjectsUrl } });
  if (!navResp.ok) return `Navigation failed: ${navResp.error ?? 'unknown'}`;

  const navData = navResp.data as { url?: string; tabId?: number } | null;
  let finalUrl = navData?.url ?? '';
  if (finalUrl.includes('/login')) {
    sendCommand({ type: 'focus-window', tabId: navData?.tabId, payload: {} }).catch(() => { /* non-fatal */ });
    return 'login_required';
  }

  let scrapeTabId: number | undefined = navData?.tabId;
  if (!finalUrl.includes('portfolio/projects')) {
    console.log(`[Groups] Portfolio URL redirected to ${finalUrl} — trying my-projects fallback`);
    const fallbackNav = await sendCommand({ type: 'navigate', payload: { url: getRuddrMyProjectsUrl(db) } });
    if (!fallbackNav.ok) return `Fallback navigation failed: ${fallbackNav.error ?? 'unknown'}`;
    const fallbackData = fallbackNav.data as { url?: string; tabId?: number } | null;
    finalUrl = fallbackData?.url ?? '';
    if (finalUrl.includes('/login')) {
      sendCommand({ type: 'focus-window', tabId: fallbackData?.tabId, payload: {} }).catch(() => { /* non-fatal */ });
      return 'login_required';
    }
    scrapeTabId = fallbackData?.tabId ?? scrapeTabId;
  }

  // Focus the tab before scraping — Chrome aggressively throttles background tabs
  // (setTimeout clamped to 1s+, IntersectionObservers paused), which breaks the
  // virtual list scroll-and-load mechanism on Ruddr.
  if (scrapeTabId !== undefined) {
    await sendCommand({ type: 'focus-window', tabId: scrapeTabId, payload: {} }).catch(() => { /* non-fatal */ });
  }

  const extractResp = await sendCommand({
    type: 'scroll-extract',
    tabId: scrapeTabId,
    payload: { selector: RUDDR_PROJECT_SELECTOR, maxScrolls: 80, waitMs: 1500, includeHref: true, debug: true },
  }, 180_000).catch((err) => {
    console.warn(`[Groups] scroll-extract failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as { ok: false; error: string };
  });
  if (!extractResp.ok) return `Extract failed: ${extractResp.error ?? 'unknown'}`;

  const rawData = extractResp.data as { items: Array<{ text: string; href?: string }>; debugLog?: string[] } | Array<{ text: string; href?: string }> | null;
  // Handle both old format (array) and new format (object with items + debugLog)
  const items = Array.isArray(rawData) ? rawData : (rawData?.items ?? []);
  const debugLog = Array.isArray(rawData) ? null : rawData?.debugLog;
  if (debugLog && debugLog.length > 0) {
    console.log(`[Groups] Ruddr scroll debug:\n  ${debugLog.join('\n  ')}`);
  }
  const freshProjects = (items ?? [])
    .map((i) => ({ name: (i.text ?? '').trim(), path: (i.href ?? '').split('?')[0].split('#')[0] }))
    .filter((e) => e.name);

  const oldLen = ruddrProjectsCache?.length ?? 0;
  if (freshProjects.length === 0) {
    if (oldLen === 0) {
      console.warn(`[Groups] Ruddr scroll returned 0 projects and cache is empty — scrape may have failed.`);
      return 'ruddr_no_projects_found';
    }
    console.warn(`[Groups] Ruddr scroll returned only ${freshProjects.length} projects — keeping old cache of ${oldLen}.`);
  } else if (oldLen > 0 && freshProjects.length < oldLen * 0.75) {
    console.warn(`[Groups] Ruddr scroll returned only ${freshProjects.length} projects — keeping old cache of ${oldLen}.`);
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
    console.log(`[Groups] Ruddr projects cached: ${ruddrProjectsCache.length} entries`);
    try {
      saveRuddrProjectsToDb(db, mergedProjects);
      saveDatabase();
    } catch (err) {
      console.warn('[Groups] Failed to persist Ruddr projects to DB:', err);
    }

    if (newProjects.length > 0) {
      console.log(`[Groups] ${newProjects.length} new Ruddr project(s) found:`, newProjects.map((p) => p.name).join(', '));
      _notifyNewProjects(newProjects);
    }
  }

  return null;
}

/** Pre-warms the Ruddr projects cache in the background at app startup. */
export async function prewarmRuddrCache(db: SqlJsDatabase): Promise<void> {
  // Seed the in-memory cache from DB immediately — no browser extension needed.
  if (ruddrProjectsCache === null || ruddrProjectsCache.length === 0) {
    const persisted = loadRuddrProjectsFromDb(db);
    if (persisted.length > 0) {
      ruddrProjectsCache = persisted;
      ruddrProjectsCacheTime = Date.now();
      console.log(`[Groups] Ruddr cache seeded from DB: ${persisted.length} projects`);
    }
  }
  // Then try to refresh from browser if connected.
  const err = await ensureRuddrCache(db);
  if (err) console.log(`[Groups] Ruddr pre-warm skipped: ${err}`);
}

// ── Hourly Ruddr project refresh ─────────────────────────────────────────────
// Holds the window getter so we can emit notifications to the renderer.
let _notifyNewProjects: (projects: RuddrProjectEntry[]) => void = () => { /* no-op until scheduled */ };
let _getWindowFn: () => BrowserWindow | null = () => null;

/**
 * After a successful project-list refresh, silently scrape the overview page
 * for each group-linked project that is still missing a note or cloud folder URL.
 * Emits 'groups:project-details-refreshed' when at least one project was updated.
 */
async function refreshLinkedProjectDetails(db: SqlJsDatabase): Promise<void> {
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

  console.log(`[Groups] Auto-refreshing details for ${toRefresh.length} linked project(s) missing note/cloud folder`);
  let updated = false;

  for (const entry of toRefresh) {
    try {
      // The edit page URL has 'edit/' inserted after '/portfolio/projects/'
      // e.g. /app/ws/portfolio/projects/client/project → /app/ws/portfolio/projects/edit/client/project
      const editPath = entry.path.includes('/portfolio/projects/')
        ? entry.path.replace('/portfolio/projects/', '/portfolio/projects/edit/')
        : entry.path;
      const editUrl = `https://www.ruddr.io${editPath}`;
      const navResp = await sendCommand({ type: 'navigate', payload: { url: editUrl } });
      if (!navResp.ok) continue;

      const navData = navResp.data as { url?: string; tabId?: number } | null;
      if ((navData?.url ?? '').includes('/login')) {
        console.log('[Groups] Auto-refresh: Ruddr login required — stopping detail refresh');
        break;
      }

      const fieldsResp = await sendCommand({
        type: 'read-form-fields',
        tabId: navData?.tabId,
        payload: {
          selectors: ['textarea[name="description"]', 'input[name="cloudFolderUrl"]'],
          waitMs: 4000,
        },
      });
      if (!fieldsResp.ok) continue;

      const raw = fieldsResp.data as Record<string, string | null> | null;
      const note = raw?.['textarea[name="description"]'] ?? null;
      const cloudFolderUrl = raw?.['input[name="cloudFolderUrl"]'] ?? null;

      if (note !== null || cloudFolderUrl !== null) {
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
          saveDatabase();
          updated = true;
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.warn(
        `[Groups] Auto-refresh detail failed for "${entry.name}":`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // Small delay between project scrapes to avoid hammering Ruddr
    await new Promise<void>((r) => setTimeout(r, 1000));
  }

  if (updated) {
    const win = _getWindowFn();
    if (win && !win.isDestroyed()) {
      win.webContents.send('groups:project-details-refreshed');
    }
  }
}

/** Schedules an hourly refresh of the Ruddr project list. Emits a renderer event when new projects are found. */
export function scheduleRuddrProjectsRefresh(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  _getWindowFn = getWindow;
  _notifyNewProjects = (projects: RuddrProjectEntry[]) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('groups:new-ruddr-projects', projects);
    }
  };

  const HOUR_MS = 60 * 60 * 1000;
  // First run after 30 seconds (let the app settle and browser extension connect).
  setTimeout(async () => {
    const err = await ensureRuddrCache(db).catch((e: unknown) => String(e));
    if (err) {
      console.log('[Groups] Hourly Ruddr refresh skipped:', err);
    } else {
      refreshLinkedProjectDetails(db).catch((e: unknown) =>
        console.warn('[Groups] Auto-refresh project details failed:', e instanceof Error ? e.message : String(e)),
      );
    }
    setInterval(async () => {
      // Force a fresh scrape by resetting the cache time so ensureRuddrCache re-fetches
      ruddrProjectsCacheTime = 0;
      const e = await ensureRuddrCache(db).catch((ex: unknown) => String(ex));
      if (e) {
        console.log('[Groups] Hourly Ruddr refresh skipped:', e);
      } else {
        refreshLinkedProjectDetails(db).catch((ex: unknown) =>
          console.warn('[Groups] Auto-refresh project details failed:', ex instanceof Error ? ex.message : String(ex)),
        );
      }
    }, HOUR_MS);
  }, 30_000);
}

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('groups:list', () => {
    return listGroups(db);
  });

  ipcMain.handle('groups:get', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return null;
    return getGroup(db, groupId);
  });

  ipcMain.handle('groups:create', (_event, name: string) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: 'Name is required' };
    }
    try {
      const id = createGroup(db, name.trim());
      saveDatabase();
      return { ok: true, id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('groups:rename', (_event, groupId: number, newName: string) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof newName !== 'string' || newName.trim().length === 0) {
      return { ok: false, error: 'Name is required' };
    }
    try {
      renameGroup(db, groupId, newName.trim());
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('groups:delete', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    try {
      deleteGroup(db, groupId);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('groups:add-local-repo', (_event, groupId: number, localRepoId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof localRepoId !== 'number') return { ok: false, error: 'Invalid localRepoId' };
    try {
      addLocalRepoToGroup(db, groupId, localRepoId);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('groups:remove-local-repo', (_event, groupId: number, localRepoId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof localRepoId !== 'number') return { ok: false, error: 'Invalid localRepoId' };
    try {
      removeLocalRepoFromGroup(db, groupId, localRepoId);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('groups:add-github-repo', (_event, groupId: number, githubRepoId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof githubRepoId !== 'number') return { ok: false, error: 'Invalid githubRepoId' };
    try {
      addGithubRepoToGroup(db, groupId, githubRepoId);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('groups:remove-github-repo', (_event, groupId: number, githubRepoId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof githubRepoId !== 'number') return { ok: false, error: 'Invalid githubRepoId' };
    try {
      removeGithubRepoFromGroup(db, groupId, githubRepoId);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  // ── Ruddr project linking ─────────────────────────────────────────────────

  ipcMain.handle('groups:find-ruddr-projects', async (_event, groupName: string) => {
    if (typeof groupName !== 'string' || !groupName.trim())
      return { ok: false, error: 'Invalid groupName' };

    try {
      const err = await ensureRuddrCache(db);
      if (err) return { ok: false, error: err };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const cache = ruddrProjectsCache;
    if (!cache) return { ok: false, error: 'Cache not populated after refresh.' };
    const matches: RuddrProjectMatch[] = cache
      .map(({ name, path }) => ({ name, path, score: scoreMatch(groupName.trim(), name) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score);

    return { ok: true, allCount: cache.length, matches };
  });

  ipcMain.handle('groups:set-ruddr-project', (_event, groupId: number, projectName: string | null) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    try {
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
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('groups:remove-ruddr-project', (_event, groupId: number, projectName: string) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    if (typeof projectName !== 'string') return { ok: false, error: 'Invalid projectName' };
    try {
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
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('groups:refresh-ruddr-cache', () => {
    ruddrProjectsCache = null;
    return { ok: true };
  });

  ipcMain.handle('groups:get-ruddr-cache', () => {
    return { ok: true, projects: ruddrProjectsCache?.map((e) => e.name) ?? [] };
  });

  ipcMain.handle('groups:get-ruddr-workspace', () => {
    return { ok: true, workspace: getRuddrWorkspace(db) };
  });

  ipcMain.handle('groups:get-ruddr-budget', async (_event, projectName: string) => {
    if (typeof projectName !== 'string' || !projectName.trim())
      return { ok: false, error: 'Invalid projectName' };

    const status = getBridgeStatus();
    if (!status.running || status.connectedClients === 0)
      return { ok: false, error: 'No browser extension connected.' };

    const workspace = getRuddrWorkspace(db);
    if (!workspace) return { ok: false, error: 'ruddr_workspace_not_configured' };

    // Look up the project path from the in-memory cache or DB.
    // Do NOT trigger a full scroll-extract scrape just for a path lookup —
    // that causes the browser to loop over all projects every time a budget is loaded.
    const trimmed = projectName.trim();
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
      console.warn(`[Groups] Budget: no cache entry for "${trimmed}". Cache has ${cacheSize} entries.`);
      return {
        ok: false,
        error: cacheSize > 0 ? 'project_not_in_ruddr' : 'project_url_unknown',
      };
    }

    const overviewUrl = `https://www.ruddr.io${entry.path}/overview`;
    try {
      const navResp = await sendCommand({ type: 'navigate', payload: { url: overviewUrl } });
      if (!navResp.ok) return { ok: false, error: `Navigation failed: ${navResp.error ?? 'unknown'}` };

      const navData = navResp.data as { url?: string; tabId?: number } | null;
      if ((navData?.url ?? '').includes('/login')) {
        sendCommand({ type: 'focus-window', tabId: navData?.tabId, payload: {} }).catch(() => { /* non-fatal */ });
        return { ok: false, error: 'login_required' };
      }

      const statsResp = await sendCommand({
        type: 'scrape-stats',
        tabId: navData?.tabId,
        payload: { waitMs: 3000 },
      });
      if (!statsResp.ok) return { ok: false, error: `Scrape failed: ${statsResp.error ?? 'unknown'}` };

      const raw = statsResp.data as Record<string, string> | null;
      const note = raw?.['Notes'] ?? raw?.['Note'] ?? raw?.['Description'] ?? null;
      const cloudFolderUrl = raw?.['_cloud_folder_url'] ?? null;
      const budgetResult = {
        ok: true,
        actualBillableHours: raw?.['Actual Billable Hours'] ?? null,
        actualNonBillableHours: raw?.['Actual Non-Billable Hours'] ?? null,
        actualTotalHours: raw?.['Actual Total Hours'] ?? null,
        budget: raw?.['Budget'] ?? null,
        budgetLeft: raw?.['Budget Left'] ?? null,
        projectUrl: overviewUrl,
        note: note,
        cloudFolderUrl: cloudFolderUrl,
      };
      ruddrBudgetCache.set(trimmed, budgetResult);
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
      return budgetResult;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('groups:get-ruddr-budget-cache', () => {
    const budgets: Record<string, Record<string, unknown>> = {};
    ruddrBudgetCache.forEach((value, key) => { budgets[key] = value; });
    return { ok: true, budgets };
  });

  ipcMain.handle('groups:set-ruddr-workspace', (_event, workspace: string) => {
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

  ipcMain.handle('groups:sync-ruddr-cache-now', async () => {
    // Force re-fetch regardless of TTL
    ruddrProjectsCacheTime = 0;
    const err = await ensureRuddrCache(db);
    if (err) return { ok: false, error: err };
    // Fire-and-forget: refresh note/cloud folder from the edit page for linked projects.
    refreshLinkedProjectDetails(db).catch((e: unknown) =>
      console.warn('[Groups] Manual sync: project details refresh failed:', e instanceof Error ? e.message : String(e)),
    );
    return { ok: true, count: ruddrProjectsCache?.length ?? 0 };
  });

  ipcMain.handle('groups:get-ruddr-project-info', (_event, projectName: string) => {
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
}
