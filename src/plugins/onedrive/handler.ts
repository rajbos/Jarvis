import { dialog, BrowserWindow, shell, app } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
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
import {
  cacheOneNoteFilesForGroup,
  getOneNoteCacheForGroup,
} from '../../services/onedrive-onenote-cache';
import { readUrlShortcut } from '../../services/url-shortcut';
import { getGroup } from '../../services/groups';
import { safeHandle } from '../ipc-utils';

function isPathWithinConfiguredRoot(db: SqlJsDatabase, filePath: string): boolean {
  const resolvedFile = path.resolve(filePath);
  return listOnedriveRoots(db).some((root) => {
    const relative = path.relative(path.resolve(root.path), resolvedFile);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

export function registerHandlers(db: SqlJsDatabase, getWindow: () => BrowserWindow | null): void {
  // Resolve PS1 script path relative to the compiled main JS, or resourcesPath when packaged.
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'read-onenote-section.ps1')
    : path.join(__dirname, '..', '..', '..', 'scripts', 'read-onenote-section.ps1');
  safeHandle('onedrive:list-roots', () => {
    return listOnedriveRoots(db);
  });

  safeHandle('onedrive:browse-folder', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      properties: ['openDirectory'],
      title: 'Select OneDrive root folder',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, folderPath: result.filePaths[0] };
  });

  safeHandle('onedrive:add-root', async (_event, label: string, folderPath?: string) => {
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

    const root = addOnedriveRoot(db, chosenPath, label.trim());
    saveDatabase();
    return { ok: true, root };
  });

  safeHandle('onedrive:remove-root', (_event, rootId: number) => {
    if (typeof rootId !== 'number') return { ok: false, error: 'Invalid rootId' };
    removeOnedriveRoot(db, rootId);
    saveDatabase();
    return { ok: true };
  });

  safeHandle('onedrive:discover-for-group', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
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
  });

  safeHandle('onedrive:rescan-files', (_event, folderId: number) => {
    if (typeof folderId !== 'number') return { ok: false, error: 'Invalid folderId' };
    const fileCount = scanFilesForFolder(db, folderId);
    saveDatabase();
    return { ok: true, fileCount };
  });

  safeHandle('onedrive:list-files-for-folder', (_event, folderId: number) => {
    if (typeof folderId !== 'number') return [];
    return listFilesForFolder(db, folderId);
  });

  safeHandle('onedrive:read-onenote-file', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      return { ok: false, error: 'filePath is required' };
    }
    if (!filePath.toLowerCase().endsWith('.one')) {
      return { ok: false, error: 'Only .one files are supported' };
    }
    if (!isPathWithinConfiguredRoot(db, filePath)) {
      return { ok: false, error: 'File must be inside a configured OneDrive root' };
    }
    const section = readOneNoteSection(filePath);
    return { ok: true, section };
  });

  safeHandle('onedrive:read-url-shortcut', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      return { ok: false, error: 'filePath is required' };
    }
    if (!filePath.toLowerCase().endsWith('.url')) {
      return { ok: false, error: 'Only .url files are supported' };
    }
    if (!isPathWithinConfiguredRoot(db, filePath)) {
      return { ok: false, error: 'File must be inside a configured OneDrive root' };
    }
    const info = readUrlShortcut(filePath);
    return { ok: true, ...info };
  });

  safeHandle('onedrive:cache-onenote-files-for-group', async (_event, groupId: number) => {
    if (typeof groupId !== 'number') return { ok: false, error: 'Invalid groupId' };
    const result = await cacheOneNoteFilesForGroup(db, groupId, scriptPath);
    saveDatabase();
    return { ok: true, ...result };
  });

  safeHandle('onedrive:get-onenote-cache-for-group', (_event, groupId: number) => {
    if (typeof groupId !== 'number') return { pages: [] };
    const pages = getOneNoteCacheForGroup(db, groupId);
    return { pages };
  });

  safeHandle('shell:open-url', (_event, url: string) => {
    if (typeof url !== 'string') return { ok: false, error: 'url is required' };
    const safe = url.startsWith('https://') || url.startsWith('http://') || url.startsWith('onenote:');
    if (!safe) return { ok: false, error: 'Unsupported URL scheme' };
    void shell.openExternal(url);
    return { ok: true };
  });
}
