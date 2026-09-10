/// <reference path="../../src/types/sql.js.d.ts" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  getRuddrProjectByName,
  getRuddrProjectByPath,
  listGroupsWithRuddr,
  listRuddrProjects,
} from '../../src/mcp-server/tools/ruddr';
import {
  getOneNotePageContent,
  listGroups,
  listOneNoteSections,
  searchOneNotePages,
} from '../../src/mcp-server/tools/onenote';

describe('MCP server database tools', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('lists and finds Ruddr projects', () => {
    db.run(
      `INSERT INTO ruddr_projects (name, path, note, cloud_folder_url, discovered_at)
       VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      [
        'Zulu', '/projects/zulu', null, null, '2026-01-02',
        'alpha', '/projects/alpha', 'Notes', 'https://example.test/alpha', '2026-01-01',
      ],
    );

    expect(listRuddrProjects(db)).toEqual([
      {
        name: 'alpha',
        path: '/projects/alpha',
        note: 'Notes',
        cloudFolderUrl: 'https://example.test/alpha',
        discoveredAt: '2026-01-01',
      },
      {
        name: 'Zulu',
        path: '/projects/zulu',
        note: null,
        cloudFolderUrl: null,
        discoveredAt: '2026-01-02',
      },
    ]);
    expect(getRuddrProjectByName(db, 'ALPHA')?.path).toBe('/projects/alpha');
    expect(getRuddrProjectByPath(db, '/projects/zulu')?.name).toBe('Zulu');
    expect(getRuddrProjectByName(db, 'missing')).toBeNull();
    expect(getRuddrProjectByPath(db, '/missing')).toBeNull();
  });

  it('parses group Ruddr associations and ignores groups without them', () => {
    db.run(
      `INSERT INTO groups (name, ruddr_project_name, ruddr_project_paths)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
      [
        'Array Group', '["Alpha", 4, "Beta"]', '["/a", "/b"]',
        'Legacy Group', 'Legacy Project', '/legacy',
        'Paths Only', null, '["/paths-only"]',
        'Empty Group', null, null,
      ],
    );

    expect(listGroups(db)).toEqual([
      { id: 1, name: 'Array Group', ruddrProjectNames: ['Alpha', 'Beta'] },
      { id: 4, name: 'Empty Group', ruddrProjectNames: [] },
      { id: 2, name: 'Legacy Group', ruddrProjectNames: ['Legacy Project'] },
      { id: 3, name: 'Paths Only', ruddrProjectNames: [] },
    ]);
    expect(listGroupsWithRuddr(db)).toEqual([
      {
        id: 1,
        name: 'Array Group',
        ruddrProjectNames: ['Alpha', 'Beta'],
        ruddrProjectPaths: ['/a', '/b'],
      },
      {
        id: 2,
        name: 'Legacy Group',
        ruddrProjectNames: ['Legacy Project'],
        ruddrProjectPaths: ['/legacy'],
      },
      {
        id: 3,
        name: 'Paths Only',
        ruddrProjectNames: [],
        ruddrProjectPaths: ['/paths-only'],
      },
    ]);
  });

  it('supports databases created before ruddr_project_paths was added', async () => {
    const SQL = await initSqlJs();
    const legacyDb = new SQL.Database();
    legacyDb.run(
      `CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ruddr_project_name TEXT
      );
      INSERT INTO groups (name, ruddr_project_name) VALUES ('Legacy', 'Old Project');`,
    );

    expect(listGroupsWithRuddr(legacyDb)).toEqual([
      {
        id: 1,
        name: 'Legacy',
        ruddrProjectNames: ['Old Project'],
        ruddrProjectPaths: [],
      },
    ]);
    legacyDb.close();
  });

  it('lists OneNote sections with optional group filtering', () => {
    seedOneNoteData(db);

    expect(listOneNoteSections(db)).toEqual([
      {
        groupId: 1,
        groupName: 'Alpha',
        relativePath: 'Planning.one',
        sectionName: 'Planning',
        pageCount: 2,
        latestModified: '2026-02-02',
      },
      {
        groupId: 2,
        groupName: 'Beta',
        relativePath: 'Notes.one',
        sectionName: '',
        pageCount: 1,
        latestModified: '2026-01-15',
      },
    ]);
    expect(listOneNoteSections(db, 2)).toEqual([
      expect.objectContaining({ groupId: 2, groupName: 'Beta', pageCount: 1 }),
    ]);
  });

  it('searches OneNote titles and content with snippets, filters, and limits', () => {
    seedOneNoteData(db);

    const results = searchOneNotePages(db, 'needle');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({
      groupId: 1,
      pageIndex: 1,
      pageTitle: 'Needle title',
    }));
    expect(results[0].snippet).toMatch(/^….*needle.*…$/i);
    expect(results[1].snippet).toBe('Short needle content');

    expect(searchOneNotePages(db, 'needle', 2)).toHaveLength(0);
    expect(searchOneNotePages(db, 'needle', undefined, 1)).toHaveLength(1);
    expect(searchOneNotePages(db, 'absent')).toEqual([]);
  });

  it('returns full, truncated, empty, and missing OneNote page content', () => {
    seedOneNoteData(db);

    expect(getOneNotePageContent(db, 1, 'Planning.one', 0, 500)).toEqual(
      expect.objectContaining({
        groupName: 'Alpha',
        content: 'Short needle content',
        truncated: false,
        totalChars: 20,
      }),
    );

    const truncated = getOneNotePageContent(db, 1, 'Planning.one', 1, 100);
    expect(truncated?.content).toHaveLength(100);
    expect(truncated?.truncated).toBe(true);
    expect(truncated?.totalChars).toBeGreaterThan(100);

    const empty = getOneNotePageContent(db, 2, 'Notes.one', 0);
    expect(empty).toEqual(expect.objectContaining({ content: '', totalChars: 0, truncated: false }));
    expect(getOneNotePageContent(db, 9, 'missing.one', 0)).toBeNull();
  });
});

function seedOneNoteData(db: SqlJsDatabase): void {
  db.run("INSERT INTO groups (id, name) VALUES (1, 'Alpha'), (2, 'Beta')");
  db.run("INSERT INTO onedrive_roots (id, path, label) VALUES (1, 'C:\\\\OneDrive', 'Root')");
  db.run(
    `INSERT INTO onedrive_customer_folders (id, group_id, root_id, folder_path, status)
     VALUES (10, 1, 1, 'C:\\OneDrive\\Alpha', 'found'),
            (20, 2, 1, 'C:\\OneDrive\\Beta', 'found')`,
  );

  const longContent = `${'x'.repeat(100)}needle${'y'.repeat(250)}`;
  db.run(
    `INSERT INTO onedrive_onenote_cache
      (folder_id, relative_path, section_name, page_index, page_level, page_title,
       page_date, page_last_modified, page_content, file_last_modified, read_source)
     VALUES
      (10, 'Planning.one', 'Planning', 0, 1, 'Overview', '2026-01-01', '2026-02-01', 'Short needle content', '2026-02-01', 'binary'),
      (10, 'Planning.one', 'Planning', 1, 2, 'Needle title', '2026-01-02', '2026-02-02', ?, '2026-02-02', 'binary'),
      (20, 'Notes.one', NULL, 0, 1, NULL, NULL, '2026-01-15', NULL, '2026-01-15', 'binary')`,
    [longContent],
  );
}
