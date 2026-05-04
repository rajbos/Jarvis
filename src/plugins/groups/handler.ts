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
} from '../../services/groups';
import { sendCommand, getBridgeStatus } from '../browser-companion/server';
import type { RuddrProjectMatch } from '../types';

// ── Ruddr project list cache (in-memory, per app session) ─────────────────────
interface RuddrProjectEntry { name: string; path: string; }
let ruddrProjectsCache: RuddrProjectEntry[] | null = null;
let ruddrProjectsCacheTime = 0;
/** Re-fetch after 8 hours so a long-running session stays reasonably fresh. */
const RUDDR_CACHE_TTL_MS = 8 * 60 * 60 * 1000;

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

  /**
   * Ensures ruddrProjectsCache is populated. Returns an error string on
   * failure, or null on success (cache is guaranteed non-null after null return).
   */
  async function ensureRuddrCache(): Promise<string | null> {
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

    const extractResp = await sendCommand({
      type: 'scroll-extract',
      tabId: scrapeTabId,
      payload: { selector: RUDDR_PROJECT_SELECTOR, maxScrolls: 80, waitMs: 1500, includeHref: true },
    });
    if (!extractResp.ok) return `Extract failed: ${extractResp.error ?? 'unknown'}`;

    const items = extractResp.data as Array<{ text: string; href?: string }> | null;
    const freshProjects = (items ?? [])
      .map((i) => ({ name: (i.text ?? '').trim(), path: (i.href ?? '').split('?')[0].split('#')[0] }))
      .filter((e) => e.name);

    const oldLen = ruddrProjectsCache?.length ?? 0;
    // Only keep the old cache if the new scrape looks dramatically truncated
    // (less than 75% of what we had before). This handles both large workspaces
    // that need full scrolling AND small workspaces with fewer than 50 projects.
    if (freshProjects.length === 0 || (oldLen > 0 && freshProjects.length < oldLen * 0.75)) {
      console.warn(`[Groups] Ruddr scroll returned only ${freshProjects.length} projects — keeping old cache of ${oldLen}.`);
    } else {
      ruddrProjectsCache = freshProjects;
      ruddrProjectsCacheTime = Date.now();
      console.log(`[Groups] Ruddr projects cached: ${ruddrProjectsCache.length} entries`);
    }

    return null;
  }

  ipcMain.handle('groups:find-ruddr-projects', async (_event, groupName: string) => {
    if (typeof groupName !== 'string' || !groupName.trim())
      return { ok: false, error: 'Invalid groupName' };

    try {
      const err = await ensureRuddrCache();
      if (err) return { ok: false, error: err };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const cache = ruddrProjectsCache;
    if (!cache) return { ok: false, error: 'Cache not populated after refresh.' };
    const matches: RuddrProjectMatch[] = cache
      .map(({ name }) => ({ name, score: scoreMatch(groupName.trim(), name) }))
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

    // Auto-populate the cache if it's empty or stale
    try {
      const cacheErr = await ensureRuddrCache();
      if (cacheErr) return { ok: false, error: cacheErr };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const trimmed = projectName.trim();
    // Try exact match first, then case-insensitive, then normalized (strips punctuation/spaces).
    const entry = ruddrProjectsCache?.find((e) => e.name === trimmed)
      ?? ruddrProjectsCache?.find((e) => e.name.toLowerCase() === trimmed.toLowerCase())
      ?? ruddrProjectsCache?.find((e) => normalize(e.name) === normalize(trimmed));
    if (!entry?.path) {
      const cacheSize = ruddrProjectsCache?.length ?? 0;
      console.warn(`[Groups] Budget: no cache entry for "${trimmed}". Cache has: ${ruddrProjectsCache?.map((e) => e.name).join(', ')}`);
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
      return {
        ok: true,
        actualBillableHours: raw?.['Actual Billable Hours'] ?? null,
        actualNonBillableHours: raw?.['Actual Non-Billable Hours'] ?? null,
        actualTotalHours: raw?.['Actual Total Hours'] ?? null,
        budget: raw?.['Budget'] ?? null,
        budgetLeft: raw?.['Budget Left'] ?? null,
        projectUrl: overviewUrl,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
}
