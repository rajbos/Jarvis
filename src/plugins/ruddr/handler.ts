// ── Ruddr project link IPC handlers ──────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { saveDatabase } from '../../storage/database';
import { listRuddrLinks, addRuddrLink, updateRuddrLink, removeRuddrLink } from '../../services/ruddr';
import { sendCommand } from '../browser-companion/server';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {

  ipcMain.handle('ruddr:list-links', (_event, groupId?: number) => {
    return listRuddrLinks(db, typeof groupId === 'number' ? groupId : undefined);
  });

  ipcMain.handle(
    'ruddr:add-link',
    (_event, groupId: number, workspace: string, projectId: string, projectName: string, projectUrl: string, extractSelector: string) => {
      if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
      if (!workspace?.trim()) return { ok: false, error: 'workspace is required' };
      if (!projectId?.trim()) return { ok: false, error: 'projectId is required' };
      if (!projectName?.trim()) return { ok: false, error: 'projectName is required' };
      if (!projectUrl?.trim()) return { ok: false, error: 'projectUrl is required' };
      try {
        const id = addRuddrLink(db, groupId, workspace.trim(), projectId.trim(), projectName.trim(), projectUrl.trim(), (extractSelector ?? '').trim());
        saveDatabase();
        return { ok: true, id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'ruddr:update-link',
    (_event, id: number, projectName: string, projectUrl: string, extractSelector: string) => {
      if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
      try {
        updateRuddrLink(db, id, projectName.trim(), projectUrl.trim(), (extractSelector ?? '').trim());
        saveDatabase();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('ruddr:remove-link', (_event, id: number) => {
    if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
    try {
      removeRuddrLink(db, id);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Navigate to the project URL and extract state data via the browser extension
  ipcMain.handle('ruddr:fetch-project-state', async (_event, linkId: number) => {
    if (typeof linkId !== 'number') return { ok: false, error: 'Invalid linkId' };
    const links = listRuddrLinks(db);
    const link = links.find((l) => l.id === linkId);
    if (!link) return { ok: false, error: 'Link not found' };
    if (!link.ruddrProjectUrl) return { ok: false, error: 'No project URL configured' };

    try {
      // Navigate to the project page
      await sendCommand({ type: 'navigate', payload: { url: link.ruddrProjectUrl } });

      // Extract data — use configured selector or fall back to full page content
      if (link.extractSelector) {
        const result = await sendCommand({
          type: 'extract',
          payload: { selector: link.extractSelector },
        });
        return { ok: true, data: result.data };
      } else {
        const result = await sendCommand({
          type: 'get-page-content',
          payload: {},
        });
        return { ok: true, data: result.data };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
