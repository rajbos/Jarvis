/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
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
} from '../../src/services/groups';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Insert a bare local_repo row and return its id. */
function insertLocalRepo(db: SqlJsDatabase, localPath: string): number {
  db.run("INSERT INTO local_repos (local_path, name) VALUES (?, ?)", [localPath, localPath.split('/').pop() ?? localPath]);
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  stmt.step();
  const { id } = stmt.getAsObject() as { id: number };
  stmt.free();
  return id as number;
}

/** Insert a bare github_repos row and return its id. */
function insertGithubRepo(db: SqlJsDatabase, fullName: string): number {
  db.run("INSERT INTO github_repos (full_name, name) VALUES (?, ?)", [fullName, fullName.split('/')[1] ?? fullName]);
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  stmt.step();
  const { id } = stmt.getAsObject() as { id: number };
  stmt.free();
  return id as number;
}

// ── setup ─────────────────────────────────────────────────────────────────────

describe('Groups service', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
  });

  // ── Schema ──────────────────────────────────────────────────────────────────

  it('creates groups tables in schema', () => {
    const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = result[0].values.map((row: unknown[]) => row[0] as string);
    expect(tableNames).toContain('groups');
    expect(tableNames).toContain('group_local_repos');
    expect(tableNames).toContain('group_github_repos');
  });

  // ── CRUD ────────────────────────────────────────────────────────────────────

  it('createGroup returns a numeric id', () => {
    const id = createGroup(db, 'My Project');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('listGroups returns created groups', () => {
    createGroup(db, 'Alpha');
    createGroup(db, 'Beta');
    const groups = listGroups(db);
    expect(groups).toHaveLength(2);
    const names = groups.map((g) => g.name);
    expect(names).toContain('Alpha');
    expect(names).toContain('Beta');
  });

  it('listGroups returns groups sorted case-insensitively by name', () => {
    createGroup(db, 'zebra');
    createGroup(db, 'Apple');
    createGroup(db, 'mango');
    const groups = listGroups(db);
    const names = groups.map((g) => g.name);
    expect(names).toEqual(['Apple', 'mango', 'zebra']);
  });

  it('listGroups initial counts are zero', () => {
    createGroup(db, 'Empty');
    const [g] = listGroups(db);
    expect(g.localRepoCount).toBe(0);
    expect(g.githubRepoCount).toBe(0);
  });

  it('getGroup returns null for unknown id', () => {
    expect(getGroup(db, 9999)).toBeNull();
  });

  it('getGroup returns group with empty member lists', () => {
    const id = createGroup(db, 'Solo');
    const detail = getGroup(db, id);
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('Solo');
    expect(detail!.localRepos).toHaveLength(0);
    expect(detail!.githubRepos).toHaveLength(0);
  });

  it('renameGroup changes the name', () => {
    const id = createGroup(db, 'Old Name');
    renameGroup(db, id, 'New Name');
    const detail = getGroup(db, id);
    expect(detail!.name).toBe('New Name');
  });

  it('deleteGroup removes the group', () => {
    const id = createGroup(db, 'Temp');
    deleteGroup(db, id);
    expect(getGroup(db, id)).toBeNull();
    expect(listGroups(db)).toHaveLength(0);
  });

  it('createGroup rejects duplicate names', () => {
    createGroup(db, 'Unique');
    expect(() => createGroup(db, 'Unique')).toThrow();
  });

  // ── Local repo membership ──────────────────────────────────────────────────

  it('addLocalRepoToGroup links a local repo', () => {
    const gid = createGroup(db, 'G1');
    const rid = insertLocalRepo(db, '/home/user/proj');
    addLocalRepoToGroup(db, gid, rid);

    const detail = getGroup(db, gid);
    expect(detail!.localRepos).toHaveLength(1);
    expect(detail!.localRepos[0].id).toBe(rid);
    expect(detail!.localRepos[0].localPath).toBe('/home/user/proj');
  });

  it('listGroups reflects localRepoCount after add', () => {
    const gid = createGroup(db, 'G2');
    const rid = insertLocalRepo(db, '/home/user/a');
    addLocalRepoToGroup(db, gid, rid);

    const [g] = listGroups(db);
    expect(g.localRepoCount).toBe(1);
  });

  it('addLocalRepoToGroup is idempotent', () => {
    const gid = createGroup(db, 'G3');
    const rid = insertLocalRepo(db, '/home/user/b');
    addLocalRepoToGroup(db, gid, rid);
    addLocalRepoToGroup(db, gid, rid); // second call should not throw or duplicate

    const detail = getGroup(db, gid);
    expect(detail!.localRepos).toHaveLength(1);
  });

  it('removeLocalRepoFromGroup unlinks a local repo', () => {
    const gid = createGroup(db, 'G4');
    const rid = insertLocalRepo(db, '/home/user/c');
    addLocalRepoToGroup(db, gid, rid);
    removeLocalRepoFromGroup(db, gid, rid);

    const detail = getGroup(db, gid);
    expect(detail!.localRepos).toHaveLength(0);
  });

  it('deleteGroup cascades to group_local_repos', () => {
    const gid = createGroup(db, 'Cascade');
    const rid = insertLocalRepo(db, '/tmp/cascade');
    addLocalRepoToGroup(db, gid, rid);
    deleteGroup(db, gid);

    const count = db.exec('SELECT COUNT(*) FROM group_local_repos')[0].values[0][0] as number;
    expect(count).toBe(0);
  });

  // ── GitHub repo membership ─────────────────────────────────────────────────

  it('addGithubRepoToGroup links a github repo', () => {
    const gid = createGroup(db, 'GH1');
    const rid = insertGithubRepo(db, 'org/my-repo');
    addGithubRepoToGroup(db, gid, rid);

    const detail = getGroup(db, gid);
    expect(detail!.githubRepos).toHaveLength(1);
    expect(detail!.githubRepos[0].fullName).toBe('org/my-repo');
  });

  it('listGroups reflects githubRepoCount after add', () => {
    const gid = createGroup(db, 'GH2');
    const rid = insertGithubRepo(db, 'org/repo2');
    addGithubRepoToGroup(db, gid, rid);

    const [g] = listGroups(db);
    expect(g.githubRepoCount).toBe(1);
  });

  it('removeGithubRepoFromGroup unlinks a github repo', () => {
    const gid = createGroup(db, 'GH3');
    const rid = insertGithubRepo(db, 'org/repo3');
    addGithubRepoToGroup(db, gid, rid);
    removeGithubRepoFromGroup(db, gid, rid);

    const detail = getGroup(db, gid);
    expect(detail!.githubRepos).toHaveLength(0);
  });

  it('deleteGroup cascades to group_github_repos', () => {
    const gid = createGroup(db, 'CascadeGH');
    const rid = insertGithubRepo(db, 'org/cascade');
    addGithubRepoToGroup(db, gid, rid);
    deleteGroup(db, gid);

    const count = db.exec('SELECT COUNT(*) FROM group_github_repos')[0].values[0][0] as number;
    expect(count).toBe(0);
  });

  // ── Mixed membership ───────────────────────────────────────────────────────

  it('a group can hold both local and github repos', () => {
    const gid = createGroup(db, 'Mixed');
    const lrid = insertLocalRepo(db, '/home/user/mixed');
    const ghrid = insertGithubRepo(db, 'org/mixed');
    addLocalRepoToGroup(db, gid, lrid);
    addGithubRepoToGroup(db, gid, ghrid);

    const detail = getGroup(db, gid);
    expect(detail!.localRepos).toHaveLength(1);
    expect(detail!.githubRepos).toHaveLength(1);

    const [g] = listGroups(db);
    expect(g.localRepoCount).toBe(1);
    expect(g.githubRepoCount).toBe(1);
  });

  it('the same repo can belong to multiple groups', () => {
    const g1 = createGroup(db, 'G-A');
    const g2 = createGroup(db, 'G-B');
    const rid = insertLocalRepo(db, '/shared/repo');
    addLocalRepoToGroup(db, g1, rid);
    addLocalRepoToGroup(db, g2, rid);

    const d1 = getGroup(db, g1);
    const d2 = getGroup(db, g2);
    expect(d1!.localRepos).toHaveLength(1);
    expect(d2!.localRepos).toHaveLength(1);
  });
});
