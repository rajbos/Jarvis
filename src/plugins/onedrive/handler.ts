// ── OneDrive IPC handlers ─────────────────────────────────────────────────────
import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../../storage/database';
import {
  listOnedriveRoots,
  addOnedriveRoot,
  removeOnedriveRoot,
  discoverCustomerFolderForGroup,
  getCustomerFolderInfo,
  scanFilesForFolder,
  listFilesForFolder,
} from '../../services/onedrive';
import { readOneNoteSection } from '../../services/onenote-reader';
import { getGroup } from '../../services/groups';

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('onedrive:list-roots', () => {
    return listOnedriveRoots(db);
  });

  ipcMain.handle('onedrive:add-root', async (_event, label: string, folderPath?: string) => {
    if (typeof label !== 'string' || label.trim().length === 0) {
      return { ok: false, error: 'Label is required' };
    }

    let chosenPath = folderPath;
    if (!chosenPath) {
      const win = getWindow();
      const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
        properties: ['openDirectory'],
        title: 'Select OneDrive root folder',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      chosenPath = result.filePaths[0];
    }

    try {
      const root = addOnedriveRoot(db, chosenPath, label.trim());
      saveDatabase();
      return { ok: true, root };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('onedrive:remove-root', (_event, rootId: number) => {
    if (typeof rootId !== 'number') return { ok: false, error: 'Invalid rootId' };
    try {
      removeOnedriveRoot(db, rootId);
      saveDatabase();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('onedrive:discover-for-group', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    try {
      const group = getGroup(db, groupId);
      if (!group) return { ok: false, error: 'Group not found' };

      const folders = discoverCustomerFolderForGroup(db, groupId, group.name);

      // Immediately scan files for any found folders
      for (const folder of folders) {
        if (folder.status === 'found') {
          try {
            scanFilesForFolder(db, folder.id);
          } catch {
            // Non-fatal — folder may have become inaccessible
          }
        }
      }

      // Return updated folder info (includes updated file counts)
      const updated = getCustomerFolderInfo(db, groupId);
      saveDatabase();
      return { ok: true, folders: updated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('onedrive:get-folder-info', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return [];
    return getCustomerFolderInfo(db, groupId);
  });

  ipcMain.handle('onedrive:rescan-files', (_event, folderId: number) => {
    if (typeof folderId !== 'number') return { ok: false, error: 'Invalid folderId' };
    try {
      const fileCount = scanFilesForFolder(db, folderId);
      saveDatabase();
      return { ok: true, fileCount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('onedrive:list-files-for-folder', (_event, folderId: number) => {
    if (typeof folderId !== 'number') return [];
    return listFilesForFolder(db, folderId);
  });

  ipcMain.handle('onedrive:read-onenote-file', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      return { ok: false, error: 'filePath is required' };
    }
    if (!filePath.toLowerCase().endsWith('.one')) {
      return { ok: false, error: 'Only .one files are supported' };
    }
    try {
      const section = readOneNoteSection(filePath);
      return { ok: true, section };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });
}
