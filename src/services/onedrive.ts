// ── OneDrive customer folder service ─────────────────────────────────────────
// Discovers customer folders by matching group names against configured
// OneDrive root directories. Indexes file metadata only — no file downloads.
import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { OnedriveRoot, OnedriveFolderInfo, OnedriveFile } from '../plugins/types';

// ── Roots ─────────────────────────────────────────────────────────────────────

export function listOnedriveRoots(db: SqlJsDatabase): OnedriveRoot[] {
  const stmt = db.prepare('SELECT id, path, label, added_at FROM onedrive_roots ORDER BY label COLLATE NOCASE');
  const roots: OnedriveRoot[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as { id: number; path: string; label: string; added_at: string };
      roots.push({ id: r.id, path: r.path, label: r.label, addedAt: r.added_at });
    }
  } finally {
    stmt.free();
  }
  return roots;
}

export function addOnedriveRoot(db: SqlJsDatabase, folderPath: string, label: string): OnedriveRoot {
  db.run(
    `INSERT INTO onedrive_roots (path, label, added_at) VALUES (?, ?, datetime('now'))`,
    [folderPath, label],
  );
  const stmt = db.prepare('SELECT id, path, label, added_at FROM onedrive_roots WHERE path = ?');
  stmt.bind([folderPath]);
  stmt.step();
  const r = stmt.getAsObject() as { id: number; path: string; label: string; added_at: string };
  stmt.free();
  return { id: r.id, path: r.path, label: r.label, addedAt: r.added_at };
}

export function removeOnedriveRoot(db: SqlJsDatabase, rootId: number): void {
  // Manually cascade — sql.js does not enforce FK cascades without PRAGMA
  const folders = db.exec(`SELECT id FROM onedrive_customer_folders WHERE root_id = ${rootId}`);
  if (folders.length > 0 && folders[0].values.length > 0) {
    for (const row of folders[0].values) {
      const folderId = row[0] as number;
      db.run('DELETE FROM onedrive_files WHERE folder_id = ?', [folderId]);
    }
  }
  db.run('DELETE FROM onedrive_customer_folders WHERE root_id = ?', [rootId]);
  db.run('DELETE FROM onedrive_roots WHERE id = ?', [rootId]);
}

// ── Folder discovery ──────────────────────────────────────────────────────────

/**
 * Search all configured roots for a subfolder whose name matches groupName
 * (case-insensitive). Updates onedrive_customer_folders with status found/not_found.
 * Returns the updated folder info for all roots.
 */
export function discoverCustomerFolderForGroup(
  db: SqlJsDatabase,
  groupId: number,
  groupName: string,
): OnedriveFolderInfo[] {
  const roots = listOnedriveRoots(db);

  for (const root of roots) {
    let foundPath: string | null = null;

    try {
      if (fs.existsSync(root.path) && fs.statSync(root.path).isDirectory()) {
        const entries = fs.readdirSync(root.path, { withFileTypes: true });
        const match = entries.find(
          (e) => e.isDirectory() && e.name.toLowerCase() === groupName.toLowerCase(),
        );
        if (match) {
          foundPath = path.join(root.path, match.name);
        }
      }
    } catch {
      // Root not accessible — treat as not_found
    }

    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(group_id, root_id) DO UPDATE SET
         folder_path   = excluded.folder_path,
         status        = excluded.status,
         discovered_at = excluded.discovered_at`,
      [groupId, root.id, foundPath, foundPath ? 'found' : 'not_found'],
    );
  }

  return getCustomerFolderInfo(db, groupId);
}

// ── Folder info query ─────────────────────────────────────────────────────────

export function getCustomerFolderInfo(db: SqlJsDatabase, groupId: number): OnedriveFolderInfo[] {
  const stmt = db.prepare(`
    SELECT
      cf.id,
      cf.group_id,
      cf.root_id,
      r.label  AS root_label,
      r.path   AS root_path,
      cf.status,
      cf.folder_path,
      cf.discovered_at,
      cf.scanned_at,
      (SELECT COUNT(*) FROM onedrive_files f WHERE f.folder_id = cf.id) AS file_count
    FROM onedrive_customer_folders cf
    JOIN onedrive_roots r ON r.id = cf.root_id
    WHERE cf.group_id = ?
    ORDER BY r.label COLLATE NOCASE
  `);
  stmt.bind([groupId]);
  const results: OnedriveFolderInfo[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        id: number;
        group_id: number;
        root_id: number;
        root_label: string;
        root_path: string;
        status: string;
        folder_path: string | null;
        discovered_at: string;
        scanned_at: string | null;
        file_count: number;
      };
      results.push({
        id: r.id,
        groupId: r.group_id,
        rootId: r.root_id,
        rootLabel: r.root_label,
        rootPath: r.root_path,
        status: r.status as 'found' | 'not_found',
        folderPath: r.folder_path,
        fileCount: r.file_count,
        lastScanned: r.scanned_at,
        discoveredAt: r.discovered_at,
      });
    }
  } finally {
    stmt.free();
  }
  return results;
}

// ── File scanning ─────────────────────────────────────────────────────────────

const MAX_SCAN_DEPTH = 3;

/**
 * Scan files in a found customer folder, storing metadata only.
 * Replaces all existing file records for this folder.
 */
export function scanFilesForFolder(db: SqlJsDatabase, folderId: number): number {
  // Fetch the folder record
  const stmt = db.prepare('SELECT folder_path, status FROM onedrive_customer_folders WHERE id = ?');
  stmt.bind([folderId]);
  if (!stmt.step()) {
    stmt.free();
    throw new Error(`Folder record ${folderId} not found`);
  }
  const row = stmt.getAsObject() as { folder_path: string | null; status: string };
  stmt.free();

  if (row.status !== 'found' || !row.folder_path) {
    throw new Error('Cannot scan: folder not found on disk');
  }

  const folderPath = row.folder_path;

  // Collect file metadata
  const files: Array<{ name: string; ext: string | null; relPath: string; mtime: string | null; size: number | null }> = [];
  collectFiles(folderPath, folderPath, 0, MAX_SCAN_DEPTH, files);

  // Replace existing file records
  db.run('DELETE FROM onedrive_files WHERE folder_id = ?', [folderId]);

  for (const f of files) {
    db.run(
      `INSERT OR IGNORE INTO onedrive_files (folder_id, name, extension, relative_path, last_modified, size_bytes, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [folderId, f.name, f.ext, f.relPath, f.mtime, f.size],
    );
  }

  db.run(
    `UPDATE onedrive_customer_folders SET scanned_at = datetime('now') WHERE id = ?`,
    [folderId],
  );

  return files.length;
}

function collectFiles(
  rootDir: string,
  currentDir: string,
  depth: number,
  maxDepth: number,
  out: Array<{ name: string; ext: string | null; relPath: string; mtime: string | null; size: number | null }>,
): void {
  if (depth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isFile()) {
      let mtime: string | null = null;
      let size: number | null = null;
      try {
        const stat = fs.statSync(fullPath);
        mtime = stat.mtime.toISOString();
        size = stat.size;
      } catch {
        // stat failed — store without mtime/size
      }
      const ext = path.extname(entry.name).toLowerCase() || null;
      out.push({ name: entry.name, ext, relPath, mtime, size });
    } else if (entry.isDirectory() && depth < maxDepth) {
      collectFiles(rootDir, fullPath, depth + 1, maxDepth, out);
    }
  }
}

// ── File list query ───────────────────────────────────────────────────────────

export function listFilesForFolder(db: SqlJsDatabase, folderId: number): OnedriveFile[] {
  const stmt = db.prepare(`
    SELECT id, folder_id, name, extension, relative_path, last_modified, size_bytes, scanned_at
    FROM onedrive_files
    WHERE folder_id = ?
    ORDER BY relative_path COLLATE NOCASE
  `);
  stmt.bind([folderId]);
  const files: OnedriveFile[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        id: number;
        folder_id: number;
        name: string;
        extension: string | null;
        relative_path: string;
        last_modified: string | null;
        size_bytes: number | null;
        scanned_at: string;
      };
      files.push({
        id: r.id,
        folderId: r.folder_id,
        name: r.name,
        extension: r.extension,
        relativePath: r.relative_path,
        lastModified: r.last_modified,
        sizeBytes: r.size_bytes,
        scannedAt: r.scanned_at,
      });
    }
  } finally {
    stmt.free();
  }
  return files;
}
