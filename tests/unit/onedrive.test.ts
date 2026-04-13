/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSchema } from '../../src/storage/schema';
import {
  listOnedriveRoots,
  addOnedriveRoot,
  removeOnedriveRoot,
  discoverCustomerFolderForGroup,
  getCustomerFolderInfo,
  scanFilesForFolder,
  listFilesForFolder,
} from '../../src/services/onedrive';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-od-test-'));
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('OneDrive service', () => {
  let db: SqlJsDatabase;
  const tempDirs: string[] = [];

  const makeTempAndTrack = () => {
    const d = makeTempDir();
    tempDirs.push(d);
    return d;
  };

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    for (const d of tempDirs.splice(0)) {
      removeDir(d);
    }
  });

  // ── Schema ──────────────────────────────────────────────────────────────────

  it('creates onedrive tables in schema', () => {
    const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = result[0].values.map((r: unknown[]) => r[0] as string);
    expect(names).toContain('onedrive_roots');
    expect(names).toContain('onedrive_customer_folders');
    expect(names).toContain('onedrive_files');
  });

  // ── Roots CRUD ───────────────────────────────────────────────────────────────

  it('listOnedriveRoots returns empty list initially', () => {
    expect(listOnedriveRoots(db)).toHaveLength(0);
  });

  it('addOnedriveRoot creates and returns a root', () => {
    const root = addOnedriveRoot(db, 'C:\\OneDrive\\ClientA', 'Client A');
    expect(root.id).toBeGreaterThan(0);
    expect(root.path).toBe('C:\\OneDrive\\ClientA');
    expect(root.label).toBe('Client A');
    expect(root.addedAt).toBeTruthy();
  });

  it('listOnedriveRoots returns added roots sorted by label', () => {
    addOnedriveRoot(db, 'C:\\OD\\Beta', 'Beta Corp');
    addOnedriveRoot(db, 'C:\\OD\\Alpha', 'Alpha Corp');
    const roots = listOnedriveRoots(db);
    expect(roots).toHaveLength(2);
    expect(roots[0].label).toBe('Alpha Corp');
    expect(roots[1].label).toBe('Beta Corp');
  });

  it('addOnedriveRoot rejects duplicate paths', () => {
    addOnedriveRoot(db, 'C:\\OD\\Shared', 'Shared');
    expect(() => addOnedriveRoot(db, 'C:\\OD\\Shared', 'Duplicate')).toThrow();
  });

  it('removeOnedriveRoot deletes the root', () => {
    const root = addOnedriveRoot(db, 'C:\\OD\\Temp', 'Temp');
    removeOnedriveRoot(db, root.id);
    expect(listOnedriveRoots(db)).toHaveLength(0);
  });

  it('removeOnedriveRoot cascades to customer_folders and files', () => {
    const root = addOnedriveRoot(db, 'C:\\OD\\X', 'X');
    const gid = insertGroup(db, 'Customer X');
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, 'C:\\OD\\X\\Customer X', 'found', datetime('now'))`,
      [gid, root.id],
    );
    const cf = db.exec('SELECT id FROM onedrive_customer_folders')[0].values[0][0] as number;
    db.run(
      `INSERT INTO onedrive_files (folder_id, name, relative_path) VALUES (?, 'file.pdf', 'file.pdf')`,
      [cf],
    );

    removeOnedriveRoot(db, root.id);

    const cfCount = db.exec('SELECT COUNT(*) FROM onedrive_customer_folders')[0].values[0][0] as number;
    const fCount = db.exec('SELECT COUNT(*) FROM onedrive_files')[0].values[0][0] as number;
    expect(cfCount).toBe(0);
    expect(fCount).toBe(0);
  });

  // ── Folder discovery ─────────────────────────────────────────────────────────

  it('discoverCustomerFolderForGroup stores not_found when root does not exist', () => {
    const root = addOnedriveRoot(db, 'Z:\\NonExistent\\Path', 'Missing');
    const gid = insertGroup(db, 'Acme');
    const info = discoverCustomerFolderForGroup(db, gid, 'Acme');
    expect(info).toHaveLength(1);
    expect(info[0].status).toBe('not_found');
    expect(info[0].rootId).toBe(root.id);
    expect(info[0].folderPath).toBeNull();
  });

  it('discoverCustomerFolderForGroup finds matching subfolder case-insensitively', () => {
    // Create a real temp directory with a matching subfolder (different case)
    const rootDir = makeTempAndTrack();
    const subDir = path.join(rootDir, 'ACME Corp'); // upper-case
    fs.mkdirSync(subDir);

    const root = addOnedriveRoot(db, rootDir, 'Work');
    const gid = insertGroup(db, 'acme corp'); // lower-case

    const info = discoverCustomerFolderForGroup(db, gid, 'acme corp');
    expect(info).toHaveLength(1);
    expect(info[0].status).toBe('found');
    expect(info[0].folderPath).toContain('ACME Corp');
  });

  it('discoverCustomerFolderForGroup creates records for multiple roots', () => {
    addOnedriveRoot(db, 'Z:\\RootA', 'Root A');
    addOnedriveRoot(db, 'Z:\\RootB', 'Root B');
    const gid = insertGroup(db, 'CustomerZ');
    const info = discoverCustomerFolderForGroup(db, gid, 'CustomerZ');
    expect(info).toHaveLength(2);
    expect(info.every((f) => f.status === 'not_found')).toBe(true);
  });

  it('discoverCustomerFolderForGroup is idempotent (upsert)', () => {
    addOnedriveRoot(db, 'Z:\\R', 'R');
    const gid = insertGroup(db, 'Test');
    discoverCustomerFolderForGroup(db, gid, 'Test');
    discoverCustomerFolderForGroup(db, gid, 'Test');

    const count = db.exec('SELECT COUNT(*) FROM onedrive_customer_folders')[0].values[0][0] as number;
    expect(count).toBe(1);
  });

  // ── Folder info query ─────────────────────────────────────────────────────────

  it('getCustomerFolderInfo returns empty when no roots configured', () => {
    const gid = insertGroup(db, 'NoRoots');
    expect(getCustomerFolderInfo(db, gid)).toHaveLength(0);
  });

  it('getCustomerFolderInfo includes file_count', () => {
    const root = addOnedriveRoot(db, 'C:\\OD\\Y', 'Y');
    const gid = insertGroup(db, 'With Files');
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, 'C:\\OD\\Y\\With Files', 'found', datetime('now'))`,
      [gid, root.id],
    );
    const cf = db.exec('SELECT id FROM onedrive_customer_folders')[0].values[0][0] as number;
    db.run(`INSERT INTO onedrive_files (folder_id, name, relative_path) VALUES (?, 'a.pdf', 'a.pdf')`, [cf]);
    db.run(`INSERT INTO onedrive_files (folder_id, name, relative_path) VALUES (?, 'b.docx', 'b.docx')`, [cf]);

    const info = getCustomerFolderInfo(db, gid);
    expect(info).toHaveLength(1);
    expect(info[0].fileCount).toBe(2);
  });

  // ── File scanning ─────────────────────────────────────────────────────────────

  it('scanFilesForFolder throws when folder is not_found', () => {
    const root = addOnedriveRoot(db, 'Z:\\Missing', 'M');
    const gid = insertGroup(db, 'Nope');
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, NULL, 'not_found', datetime('now'))`,
      [gid, root.id],
    );
    const cf = db.exec('SELECT id FROM onedrive_customer_folders')[0].values[0][0] as number;
    expect(() => scanFilesForFolder(db, cf)).toThrow();
  });

  it('scanFilesForFolder indexes files from disk', () => {
    const customerDir = makeTempAndTrack();
    fs.writeFileSync(path.join(customerDir, 'report.pdf'), 'mock content');
    fs.writeFileSync(path.join(customerDir, 'notes.docx'), 'mock content');

    const root = addOnedriveRoot(db, path.dirname(customerDir), 'Z');
    const gid = insertGroup(db, 'FileTest');
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, ?, 'found', datetime('now'))`,
      [gid, root.id, customerDir],
    );
    const cf = db.exec('SELECT id FROM onedrive_customer_folders')[0].values[0][0] as number;

    const count = scanFilesForFolder(db, cf);
    expect(count).toBe(2);

    const files = listFilesForFolder(db, cf);
    expect(files).toHaveLength(2);
    const names = files.map((f) => f.name);
    expect(names).toContain('report.pdf');
    expect(names).toContain('notes.docx');
  });

  it('scanFilesForFolder stores last_modified and size', () => {
    const customerDir = makeTempAndTrack();
    fs.writeFileSync(path.join(customerDir, 'contract.pdf'), 'content here');

    const root = addOnedriveRoot(db, path.dirname(customerDir), 'ZZ');
    const gid = insertGroup(db, 'ModTest');
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, ?, 'found', datetime('now'))`,
      [gid, root.id, customerDir],
    );
    const cf = db.exec('SELECT id FROM onedrive_customer_folders')[0].values[0][0] as number;

    scanFilesForFolder(db, cf);
    const files = listFilesForFolder(db, cf);
    expect(files[0].lastModified).toBeTruthy();
    expect(files[0].sizeBytes).toBeGreaterThan(0);
  });

  it('scanFilesForFolder replaces existing file records', () => {
    const customerDir = makeTempAndTrack();
    fs.writeFileSync(path.join(customerDir, 'new.pdf'), 'new content');

    const root = addOnedriveRoot(db, path.dirname(customerDir), 'W');
    const gid = insertGroup(db, 'Rescan');
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, ?, 'found', datetime('now'))`,
      [gid, root.id, customerDir],
    );
    const cf = db.exec('SELECT id FROM onedrive_customer_folders')[0].values[0][0] as number;

    // Pre-populate with stale data
    db.run(`INSERT INTO onedrive_files (folder_id, name, relative_path) VALUES (?, 'old.pdf', 'old.pdf')`, [cf]);

    scanFilesForFolder(db, cf);
    const files = listFilesForFolder(db, cf);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('new.pdf');
  });

  // ── File list query ───────────────────────────────────────────────────────────

  it('listFilesForFolder returns empty array for unknown folderId', () => {
    expect(listFilesForFolder(db, 9999)).toHaveLength(0);
  });

  it('listFilesForFolder returns files sorted by relative_path', () => {
    const root = addOnedriveRoot(db, 'C:\\OD\\Sort', 'Sort');
    const gid = insertGroup(db, 'SortTest');
    db.run(
      `INSERT INTO onedrive_customer_folders (group_id, root_id, folder_path, status, discovered_at)
       VALUES (?, ?, 'C:\\OD\\Sort\\SortTest', 'found', datetime('now'))`,
      [gid, root.id],
    );
    const cf = db.exec('SELECT id FROM onedrive_customer_folders')[0].values[0][0] as number;
    db.run(`INSERT INTO onedrive_files (folder_id, name, relative_path) VALUES (?, 'z.pdf', 'z.pdf')`, [cf]);
    db.run(`INSERT INTO onedrive_files (folder_id, name, relative_path) VALUES (?, 'a.docx', 'a.docx')`, [cf]);

    const files = listFilesForFolder(db, cf);
    expect(files[0].name).toBe('a.docx');
    expect(files[1].name).toBe('z.pdf');
  });
});
