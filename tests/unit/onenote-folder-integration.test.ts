/// <reference path="../../src/types/sql.js.d.ts" />
// ── OneNote folder integration ─────────────────────────────────────────────────
// Proves the full pipeline from group/OneDrive folder discovery through
// file scanning to OneNote content extraction.
//
// Uses the real `.one` fixture files shipped in the @joplin/onenote-converter
// package so the test runs on any machine without needing actual OneDrive files.
// The fixture directory structure mirrors a real OneDrive layout:
//
//   test-data/              ← OneDrive root
//     single-page/          ← customer folder (= "group" in Jarvis)
//       Untitled Section.one
//     onenote-2016/
//       OneWithFileData.one
//
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as path from 'path';
import { getSchema } from '../../src/storage/schema';
import {
  addOnedriveRoot,
  discoverCustomerFolderForGroup,
  scanFilesForFolder,
  listFilesForFolder,
} from '../../src/services/onedrive';
import { readOneNoteSection } from '../../src/services/onenote-reader';
import type { OnedriveFolderInfo, OnedriveFile } from '../../src/plugins/types';

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

/** Full path to the Joplin test fixture tree — used as a stand-in OneDrive root. */
const FIXTURE_ROOT = path.join(
  __dirname,
  '../../node_modules/@joplin/onenote-converter/test-data',
);

/** Set up an OneDrive root at FIXTURE_ROOT, create a group with the given name,
 *  discover its matching subfolder, and return both the folder record and its files. */
function setupAndScan(
  db: SqlJsDatabase,
  groupName: string,
): { folder: OnedriveFolderInfo; files: OnedriveFile[]; oneFiles: OnedriveFile[] } {
  addOnedriveRoot(db, FIXTURE_ROOT, 'Fixtures');
  const gid = insertGroup(db, groupName);
  const folders = discoverCustomerFolderForGroup(db, gid, groupName);
  const folder = folders[0];
  scanFilesForFolder(db, folder.id);
  const files = listFilesForFolder(db, folder.id);
  const oneFiles = files.filter(f => f.extension === '.one');
  return { folder, files, oneFiles };
}

/** Format a readable summary of an extracted section for test output. */
function formatSectionReport(section: ReturnType<typeof readOneNoteSection>): string {
  const lines: string[] = [
    `  Section: "${section.sectionName}"  (${section.pageCount} page(s))`,
  ];
  for (const page of section.pages) {
    const heading = page.title ? `"${page.title}"` : '(no title)';
    const dateTag = page.date ? `  [${page.date}]` : '';
    lines.push(`    Page ${page.pageIndex}: ${heading}${dateTag}`);
    if (page.content.trim()) {
      const preview = page.content.replace(/\s+/g, ' ').trim().slice(0, 120);
      lines.push(`      ↳ ${preview}${page.content.length > 120 ? '…' : ''}`);
    }
  }
  return lines.join('\n');
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('OneNote folder integration — full pipeline', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
  });

  // ── single-page fixture group ─────────────────────────────────────────────

  describe('group "single-page"', () => {
    it('discovers the folder matching the group name', () => {
      const { folder } = setupAndScan(db, 'single-page');
      expect(folder.status).toBe('found');
      expect(folder.folderPath).toBeTruthy();
    });

    it('finds at least one .one file after scanning', () => {
      const { oneFiles } = setupAndScan(db, 'single-page');
      expect(oneFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('reads each .one file and returns a named section with pages', () => {
      const { folder, oneFiles } = setupAndScan(db, 'single-page');

      for (const file of oneFiles) {
        const fullPath = path.join(folder.folderPath!, file.relativePath);
        const section = readOneNoteSection(fullPath);

        // Section name matches the filename (minus extension)
        expect(section.sectionName).toBe(path.basename(file.name, '.one'));
        // At least one page per section
        expect(section.pageCount).toBeGreaterThanOrEqual(1);
        expect(section.pages.length).toEqual(section.pageCount);
        // All pages have a 1-based index
        section.pages.forEach((p, i) => expect(p.pageIndex).toBe(i + 1));
        // Combined text is non-empty
        expect(section.textContent.trim().length).toBeGreaterThan(0);

        console.log(formatSectionReport(section));
      }
    });

    it('extracts "test" body text from the Untitled Section fixture', () => {
      const { folder, oneFiles } = setupAndScan(db, 'single-page');
      const untitled = oneFiles.find(f => f.name === 'Untitled Section.one');
      expect(untitled).toBeDefined();

      const fullPath = path.join(folder.folderPath!, untitled!.relativePath);
      const section = readOneNoteSection(fullPath);
      expect(section.textContent.toLowerCase()).toContain('test');
    });
  });

  // ── onenote-2016 fixture group ────────────────────────────────────────────

  describe('group "onenote-2016"', () => {
    it('discovers the folder matching the group name', () => {
      const { folder } = setupAndScan(db, 'onenote-2016');
      expect(folder.status).toBe('found');
    });

    it('finds at least one .one file after scanning', () => {
      const { oneFiles } = setupAndScan(db, 'onenote-2016');
      expect(oneFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('reads each .one file and returns pages with content', () => {
      const { folder, oneFiles } = setupAndScan(db, 'onenote-2016');

      for (const file of oneFiles) {
        const fullPath = path.join(folder.folderPath!, file.relativePath);
        const section = readOneNoteSection(fullPath);

        expect(section.pageCount).toBeGreaterThanOrEqual(1);
        expect(typeof section.sectionName).toBe('string');
        expect(section.sectionName.length).toBeGreaterThan(0);

        console.log(formatSectionReport(section));
      }
    });
  });

  // ── cross-group summary ───────────────────────────────────────────────────

  it('can scan both groups and produce a combined section summary', () => {
    const groupNames = ['single-page', 'onenote-2016'];
    const summary: string[] = ['\n── OneNote section summary ──────────────────────────────'];

    // Single root shared by both groups — path must be unique in the DB
    addOnedriveRoot(db, FIXTURE_ROOT, 'Fixtures');

    for (const groupName of groupNames) {
      const gid = insertGroup(db, groupName);
      const [folder] = discoverCustomerFolderForGroup(db, gid, groupName);
      scanFilesForFolder(db, folder.id);

      const files = listFilesForFolder(db, folder.id);
      const oneFiles = files.filter(f => f.extension === '.one');

      summary.push(`\nGroup: "${groupName}"  (${oneFiles.length} .one file(s) found)`);

      for (const file of oneFiles) {
        const fullPath = path.join(folder.folderPath!, file.relativePath);
        const section = readOneNoteSection(fullPath);
        summary.push(formatSectionReport(section));
      }

      expect(folder.status).toBe('found');
      expect(oneFiles.length).toBeGreaterThanOrEqual(1);
    }

    summary.push('\n─────────────────────────────────────────────────────────');
    console.log(summary.join('\n'));
  });
});
