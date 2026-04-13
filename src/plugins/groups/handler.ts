// ── Groups IPC handlers ───────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { saveDatabase } from '../../storage/database';
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
} from '../../services/groups';

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
}
