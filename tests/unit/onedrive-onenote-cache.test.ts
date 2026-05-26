/// <reference path="../../src/types/sql.js.d.ts" />
// ── OneNote cache service tests ───────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  getOneNoteFilesForGroup,
  isCacheValid,
  getCachedPages,
  writeCacheForFile,
  deleteCacheForFolder,
  cacheOneNoteFilesForGroup,
} from '../../src/services/onedrive-onenote-cache';

// ── Mock onenote-reader async function ────────────────────────────────────────
vi.mock('../../src/services/onenote-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/onenote-reader')>();
  return {
    ...actual,
    readOneNoteSectionAsync: vi.fn().mockResolvedValue({
      sectionName: 'Test Section',
      filePath: '/fake/Test Section.one',
      pageCount: 2,
      source: 'binary' as const,
      pages: [
        { pageIndex: 1, pageLevel: 1, title: 'Page One', date: '2024-01-01', lastModified: '2024-01-01T10:00:00.000Z', content: 'Hello world' },
        { pageIndex: 2, pageLevel: 2, title: 'Page Two', date: '2024-01-02', lastModified: '2024-01-02T10:00:00.000Z', content: 'Second page' },
      ],
      textContent: 'Page One 2024-01-01 Hello world\n\nPage Two 2024-01-02 Second page',
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupDb(db: SqlJsDatabase): void {
  db.run(getSchema());
}

function insertGroup(db: SqlJsDatabase, name: string): number {
  db.run(
    `INSERT INTO groups (name, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))`,
    [name],
  );
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  stmt.step();
  const { id } = stmt.getAsObject() as { id: number };
  stmt.free();
  return id as number;
}

function insertRoot(db: SqlJsDatabase, p: string): number {
  db.run(`INSERT INTO onedrive_roots (path, label) VALUES (?, ?)`, [p, p]);
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  stmt.step();
  const { id } = stmt.getAsObject() as { id: number };
  stmt.free();
  return id as number;
}

function insertFolder(
  db: SqlJsDatabase,
  groupId: number,
  rootId: number,
  folderPath: string,
): number {
  db.run(
    `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status)
     VALUES (?, ?, ?, 'found')`,
    [groupId, rootId, folderPath],
  );
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  stmt.step();
  const { id } = stmt.getAsObject() as { id: number };
  stmt.free();
  return id as number;
}

function insertFile(
  db: SqlJsDatabase,
  folderId: number,
  name: string,
  relativePath: string,
  lastModified: string,
): void {
  db.run(
    `INSERT INTO onedrive_files (folder_id, name, extension, relative_path, last_modified, size_bytes)
     VALUES (?, ?, '.one', ?, ?, 0)`,
    [folderId, name, relativePath, lastModified],
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getOneNoteFilesForGroup()', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    setupDb(db);
  });

  it('returns .one files for a group', () => {
    const groupId = insertGroup(db, 'Acme');
    const rootId = insertRoot(db, 'C:\\OneDrive');
    const folderId = insertFolder(db, groupId, rootId, 'C:\\OneDrive\\Acme');
    insertFile(db, folderId, 'Notes.one', 'Notes.one', '2024-01-15T10:00:00.000Z');
    // Non-.one file should not appear
    db.run(
      `INSERT INTO onedrive_files (folder_id, name, extension, relative_path, last_modified, size_bytes)
       VALUES (?, 'doc.docx', '.docx', 'doc.docx', '2024-01-01T00:00:00.000Z', 0)`,
      [folderId],
    );

    const files = getOneNoteFilesForGroup(db, groupId);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('Notes.one');
    expect(files[0].folderId).toBe(folderId);
    expect(files[0].lastModified).toBe('2024-01-15T10:00:00.000Z');
  });

  it('returns empty array when group has no .one files', () => {
    const groupId = insertGroup(db, 'Empty');
    expect(getOneNoteFilesForGroup(db, groupId)).toHaveLength(0);
  });

  it('excludes files from not_found folders', () => {
    const groupId = insertGroup(db, 'Missing');
    const rootId = insertRoot(db, 'C:\\OneDrive');
    // Insert a folder with status 'not_found'
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status) VALUES (?, ?, NULL, 'not_found')`,
      [groupId, rootId],
    );
    expect(getOneNoteFilesForGroup(db, groupId)).toHaveLength(0);
  });
});

describe('isCacheValid()', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    setupDb(db);
  });

  it('returns false when no cache rows exist', () => {
    expect(isCacheValid(db, 1, 'Notes.one', '2024-01-01T00:00:00.000Z')).toBe(false);
  });

  it('returns false when lastModified is null', () => {
    expect(isCacheValid(db, 1, 'Notes.one', null)).toBe(false);
  });

  it('returns true when matching cache rows exist', () => {
    db.run(
      `INSERT INTO onedrive_onenote_cache
         (folder_id, relative_path, page_index, page_title, page_date, page_content, file_last_modified, read_source)
       VALUES (1, 'Notes.one', 1, 'A', '', 'content', '2024-01-01T00:00:00.000Z', 'binary')`,
    );
    expect(isCacheValid(db, 1, 'Notes.one', '2024-01-01T00:00:00.000Z')).toBe(true);
  });

  it('returns false when mtime does not match cached value', () => {
    db.run(
      `INSERT INTO onedrive_onenote_cache
         (folder_id, relative_path, page_index, page_title, page_date, page_content, file_last_modified, read_source)
       VALUES (1, 'Notes.one', 1, 'A', '', 'content', '2024-01-01T00:00:00.000Z', 'binary')`,
    );
    expect(isCacheValid(db, 1, 'Notes.one', '2025-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('writeCacheForFile() / getCachedPages()', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    setupDb(db);
  });

  it('writes pages and returns them ordered by pageIndex', () => {
    writeCacheForFile(
      db,
      1,
      'Notes.one',
      [
        { pageIndex: 2, pageLevel: 2, title: 'B', date: '', lastModified: '', content: 'second' },
        { pageIndex: 1, pageLevel: 1, title: 'A', date: '', lastModified: '2024-01-01', content: 'first' },
      ],
      '2024-01-01T00:00:00.000Z',
      'binary',
    );

    const pages = getCachedPages(db, 1, 'Notes.one');
    expect(pages).toHaveLength(2);
    expect(pages[0].pageIndex).toBe(1);
    expect(pages[0].pageLevel).toBe(1);
    expect(pages[0].pageTitle).toBe('A');
    expect(pages[0].pageLastModified).toBe('2024-01-01');
    expect(pages[1].pageIndex).toBe(2);
    expect(pages[1].pageLevel).toBe(2);
    expect(pages[1].pageTitle).toBe('B');
  });

  it('replaces existing cache on re-write', () => {
    writeCacheForFile(db, 1, 'Notes.one', [{ pageIndex: 1, pageLevel: 1, title: 'Old', date: '', lastModified: '', content: 'old' }], '2024-01-01T00:00:00.000Z', 'binary');
    writeCacheForFile(db, 1, 'Notes.one', [{ pageIndex: 1, pageLevel: 1, title: 'New', date: '', lastModified: '', content: 'new' }], '2024-02-01T00:00:00.000Z', 'com');

    const pages = getCachedPages(db, 1, 'Notes.one');
    expect(pages).toHaveLength(1);
    expect(pages[0].pageTitle).toBe('New');
    expect(pages[0].readSource).toBe('com');
    expect(pages[0].fileLastModified).toBe('2024-02-01T00:00:00.000Z');
  });

  it('returns empty array when no cache exists', () => {
    expect(getCachedPages(db, 99, 'nonexistent.one')).toEqual([]);
  });
});

describe('deleteCacheForFolder()', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    setupDb(db);
  });

  it('deletes all cache rows for a folder', () => {
    db.run(
      `INSERT INTO onedrive_onenote_cache
         (folder_id, relative_path, page_index, page_title, page_date, page_content, file_last_modified, read_source)
       VALUES (5, 'a.one', 1, 'X', '', '', null, 'binary'), (5, 'b.one', 1, 'Y', '', '', null, 'binary')`,
    );
    deleteCacheForFolder(db, 5);
    const rows = db.exec('SELECT COUNT(*) FROM onedrive_onenote_cache WHERE folder_id = 5');
    expect(rows[0].values[0][0]).toBe(0);
  });
});

describe('cacheOneNoteFilesForGroup()', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    setupDb(db);
  });

  it('skips files with valid cache', async () => {
    const groupId = insertGroup(db, 'G');
    const rootId = insertRoot(db, 'C:\\D');
    const folderId = insertFolder(db, groupId, rootId, 'C:\\D\\G');
    const mtime = '2024-01-15T10:00:00.000Z';
    insertFile(db, folderId, 'N.one', 'N.one', mtime);
    // Pre-populate cache with matching mtime
    writeCacheForFile(db, folderId, 'N.one', [{ pageIndex: 1, pageLevel: 1, title: 'T', date: '', lastModified: '', content: 'C' }], mtime, 'binary');

    const result = await cacheOneNoteFilesForGroup(db, groupId, 'fake.ps1');
    expect(result.filesSkipped).toBe(1);
    expect(result.filesProcessed).toBe(0);
  });

  it('records an error for missing files', async () => {
    const groupId = insertGroup(db, 'H');
    const rootId = insertRoot(db, 'C:\\D');
    const folderId = insertFolder(db, groupId, rootId, 'C:\\D\\H');
    insertFile(db, folderId, 'Missing.one', 'Missing.one', '2024-01-01T00:00:00.000Z');

    const result = await cacheOneNoteFilesForGroup(db, groupId, 'fake.ps1');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].relativePath).toBe('Missing.one');
  });
});
