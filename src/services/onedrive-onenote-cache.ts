// ── OneNote content cache service ─────────────────────────────────────────────
// Reads .one section files for all OneDrive folders belonging to a group and
// caches their page content in onedrive_onenote_cache.
//
// Cache key: (folder_id, relative_path) — stable across file rescans because
// onedrive_customer_folders rows are not deleted on rescan.
//
// Invalidation: compare file's current last_modified timestamp against the
// file_last_modified stored in the cache; re-read only when they differ.

import fs from 'fs';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { readOneNoteSectionAsync } from './onenote-reader';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OneNoteCachedPage {
  pageIndex: number;
  pageLevel: number;
  pageTitle: string;
  pageDate: string;
  /** ISO 8601 last-modified from OneNote metadata, or YYYY-MM-DD from title prefix. Empty string if unknown. */
  pageLastModified: string;
  pageContent: string;
  fileLastModified: string | null;
  readSource: 'com' | 'binary';
  cachedAt: string;
}

export interface OneNoteFileInfo {
  folderId: number;
  folderPath: string;
  name: string;
  relativePath: string;
  lastModified: string | null;
}

export interface CacheGroupResult {
  filesProcessed: number;
  pagesCached: number;
  filesSkipped: number;
  errors: Array<{ relativePath: string; error: string }>;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/** Return all .one files across all found folders for a group. */
export function getOneNoteFilesForGroup(
  db: SqlJsDatabase,
  groupId: number,
): OneNoteFileInfo[] {
  const stmt = db.prepare(`
    SELECT
      cf.id         AS folder_id,
      cf.folder_path,
      f.name,
      f.relative_path,
      f.last_modified
    FROM onedrive_files f
    JOIN onedrive_customer_folders cf ON cf.id = f.folder_id
    WHERE cf.group_id = ?
      AND cf.status = 'found'
      AND f.extension = '.one'
    ORDER BY cf.folder_path, f.relative_path
  `);
  stmt.bind([groupId]);

  const results: OneNoteFileInfo[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        folder_id: number;
        folder_path: string;
        name: string;
        relative_path: string;
        last_modified: string | null;
      };
      results.push({
        folderId: r.folder_id,
        folderPath: r.folder_path,
        name: r.name,
        relativePath: r.relative_path,
        lastModified: r.last_modified,
      });
    }
  } finally {
    stmt.free();
  }
  return results;
}

/** Return true if a valid cache entry exists for this file at the given mtime. */
export function isCacheValid(
  db: SqlJsDatabase,
  folderId: number,
  relativePath: string,
  lastModified: string | null,
): boolean {
  if (!lastModified) return false;

  const stmt = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM onedrive_onenote_cache
    WHERE folder_id = ? AND relative_path = ? AND file_last_modified = ?
  `);
  stmt.bind([folderId, relativePath, lastModified]);
  let count = 0;
  try {
    if (stmt.step()) {
      const r = stmt.getAsObject() as { cnt: number };
      count = r.cnt;
    }
  } finally {
    stmt.free();
  }
  return count > 0;
}

/** Return cached pages for a file, ordered by page_index. */
export function getCachedPages(
  db: SqlJsDatabase,
  folderId: number,
  relativePath: string,
): OneNoteCachedPage[] {
  const stmt = db.prepare(`
    SELECT
      page_index,
      page_level,
      page_title,
      page_date,
      page_last_modified,
      page_content,
      file_last_modified,
      read_source,
      cached_at
    FROM onedrive_onenote_cache
    WHERE folder_id = ? AND relative_path = ?
    ORDER BY page_index
  `);
  stmt.bind([folderId, relativePath]);

  const pages: OneNoteCachedPage[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        page_index: number;
        page_level: number;
        page_title: string | null;
        page_date: string | null;
        page_last_modified: string | null;
        page_content: string | null;
        file_last_modified: string | null;
        read_source: string;
        cached_at: string;
      };
      pages.push({
        pageIndex: r.page_index,
        pageLevel: r.page_level ?? 1,
        pageTitle: r.page_title ?? '',
        pageDate: r.page_date ?? '',
        pageLastModified: r.page_last_modified ?? '',
        pageContent: r.page_content ?? '',
        fileLastModified: r.file_last_modified,
        readSource: (r.read_source as 'com' | 'binary') ?? 'binary',
        cachedAt: r.cached_at,
      });
    }
  } finally {
    stmt.free();
  }
  return pages;
}

/**
 * Write (replace) cache entries for one file.
 * Deletes any existing rows for (folder_id, relative_path) before inserting,
 * wrapped in a transaction so a mid-write failure leaves the old cache intact.
 */
export function writeCacheForFile(
  db: SqlJsDatabase,
  folderId: number,
  relativePath: string,
  pages: Array<{ pageIndex: number; pageLevel: number; title: string; date: string; lastModified: string; content: string }>,
  lastModified: string | null,
  readSource: 'com' | 'binary',
): void {
  const sectionName = path.basename(relativePath, path.extname(relativePath));

  db.run('BEGIN');
  try {
    db.run(
      'DELETE FROM onedrive_onenote_cache WHERE folder_id = ? AND relative_path = ?',
      [folderId, relativePath],
    );
    for (const page of pages) {
      db.run(
        `INSERT INTO onedrive_onenote_cache
           (folder_id, relative_path, section_name, page_index, page_level,
            page_title, page_date, page_last_modified, page_content,
            file_last_modified, read_source, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          folderId,
          relativePath,
          sectionName,
          page.pageIndex,
          page.pageLevel,
          page.title,
          page.date,
          page.lastModified || null,
          page.content,
          lastModified,
          readSource,
        ],
      );
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/**
 * Delete all cache rows for a given folder (used when removing a root or folder).
 */
export function deleteCacheForFolder(db: SqlJsDatabase, folderId: number): void {
  db.run('DELETE FROM onedrive_onenote_cache WHERE folder_id = ?', [folderId]);
}

export interface OneNoteGroupCachePage {
  relativePath: string;
  sectionName: string;
  pageIndex: number;
  pageLevel: number;
  pageTitle: string;
  pageLastModified: string;
  pageDate: string;
  readSource: 'com' | 'binary';
  cachedAt: string;
}

/**
 * Return all cached pages for every .one file belonging to a group,
 * ordered by section file then page index. Used for the sanity-check UI.
 */
export function getOneNoteCacheForGroup(
  db: SqlJsDatabase,
  groupId: number,
): OneNoteGroupCachePage[] {
  const stmt = db.prepare(`
    SELECT
      c.relative_path,
      COALESCE(c.section_name, '') AS section_name,
      c.page_index,
      c.page_level,
      COALESCE(c.page_title, '')   AS page_title,
      COALESCE(c.page_last_modified, '') AS page_last_modified,
      COALESCE(c.page_date, '')    AS page_date,
      c.read_source,
      c.cached_at
    FROM onedrive_onenote_cache c
    JOIN onedrive_customer_folders cf ON cf.id = c.folder_id
    WHERE cf.group_id = ?
    ORDER BY c.relative_path, c.page_index
  `);
  stmt.bind([groupId]);

  type Row = {
    relative_path: string; section_name: string; page_index: number;
    page_level: number; page_title: string; page_last_modified: string;
    page_date: string; read_source: string; cached_at: string;
  };
  const pages: OneNoteGroupCachePage[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as unknown as Row;
      pages.push({
        relativePath: r.relative_path,
        sectionName: r.section_name,
        pageIndex: r.page_index,
        pageLevel: r.page_level,
        pageTitle: r.page_title,
        pageLastModified: r.page_last_modified,
        pageDate: r.page_date,
        readSource: r.read_source as 'com' | 'binary',
        cachedAt: r.cached_at,
      });
    }
  } finally {
    stmt.free();
  }
  return pages;
}

// ── Main orchestration ────────────────────────────────────────────────────────

/**
 * Cache the content of every .one file found for a group.
 * Files whose last_modified timestamp matches the cached value are skipped.
 * Uses OneNote COM (full fidelity) with automatic fallback to binary extraction.
 *
 * @param db         Live sql.js database instance.
 * @param groupId    ID of the group to process.
 * @param scriptPath Absolute path to `read-onenote-section.ps1`.
 */
export async function cacheOneNoteFilesForGroup(
  db: SqlJsDatabase,
  groupId: number,
  scriptPath: string,
): Promise<CacheGroupResult> {
  const files = getOneNoteFilesForGroup(db, groupId);
  const result: CacheGroupResult = {
    filesProcessed: 0,
    pagesCached: 0,
    filesSkipped: 0,
    errors: [],
  };

  for (const file of files) {
    if (isCacheValid(db, file.folderId, file.relativePath, file.lastModified)) {
      result.filesSkipped++;
      continue;
    }

    const absolutePath = path.join(file.folderPath, file.relativePath);
    if (!fs.existsSync(absolutePath)) {
      result.errors.push({ relativePath: file.relativePath, error: 'File not found on disk' });
      continue;
    }

    try {
      const section = await readOneNoteSectionAsync(absolutePath, scriptPath);
      writeCacheForFile(
        db,
        file.folderId,
        file.relativePath,
        section.pages,
        file.lastModified,
        section.source,
      );
      result.filesProcessed++;
      result.pagesCached += section.pages.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ relativePath: file.relativePath, error: msg });
    }
  }

  return result;
}
