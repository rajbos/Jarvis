// ── Groups service ─────────────────────────────────────────────────────────────
// CRUD operations and membership management for source groups.
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Group, GroupDetail, GroupLocalRepoMember, GroupGithubRepoMember } from '../plugins/types';
import { getCustomerFolderInfo } from './onedrive';

/** Parse ruddr_project_name column: JSON array, single string (legacy), or null → string[] */
export function parseRuddrNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
  } catch { /* legacy plain string */ }
  return [raw];
}

// ── Ruddr project cache (DB-persisted) ────────────────────────────────────────

export interface RuddrProjectEntry { name: string; path: string; note?: string | null; cloud_folder_url?: string | null; discovered_at?: string | null; }

/** Load all cached Ruddr projects from the database. */
export function loadRuddrProjectsFromDb(db: SqlJsDatabase): RuddrProjectEntry[] {
  const stmt = db.prepare('SELECT name, path, note, cloud_folder_url, discovered_at FROM ruddr_projects ORDER BY discovered_at DESC, name COLLATE NOCASE');
  const results: RuddrProjectEntry[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as { name: string; path: string; note: string | null; cloud_folder_url: string | null; discovered_at: string | null };
      results.push({ name: r.name, path: r.path, note: r.note, cloud_folder_url: r.cloud_folder_url, discovered_at: r.discovered_at });
    }
  } finally {
    stmt.free();
  }
  return results;
}

/** Persist the full Ruddr project list to the database (replaces all existing rows). */
export function saveRuddrProjectsToDb(db: SqlJsDatabase, projects: RuddrProjectEntry[]): void {
  // Upsert each project: preserve existing note, cloud_folder_url, and discovered_at on update.
  // discovered_at is only set on first INSERT (COALESCE keeps the existing value on conflict).
  for (const p of projects) {
    db.run(
      `INSERT INTO ruddr_projects (name, path, note, cloud_folder_url, cached_at, discovered_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         name             = excluded.name,
         cached_at        = excluded.cached_at,
         note             = COALESCE(ruddr_projects.note, excluded.note),
         cloud_folder_url = COALESCE(ruddr_projects.cloud_folder_url, excluded.cloud_folder_url),
         discovered_at    = COALESCE(ruddr_projects.discovered_at, excluded.discovered_at)`,
      [p.name, p.path, p.note ?? null, p.cloud_folder_url ?? null],
    );
  }
  // Remove projects that no longer exist in Ruddr
  if (projects.length > 0) {
    db.run(
      `DELETE FROM ruddr_projects WHERE path NOT IN (${projects.map(() => '?').join(',')})`,
      projects.map((p) => p.path),
    );
  }
}

/** Update (or clear) the note for a single project identified by its URL path. */
export function updateRuddrProjectNote(db: SqlJsDatabase, projectPath: string, note: string | null): void {
  db.run(
    `UPDATE ruddr_projects SET note = ? WHERE path = ?`,
    [note, projectPath],
  );
}

/** Update (or clear) the cloud folder URL for a single project identified by its URL path. */
export function updateRuddrProjectCloudFolderUrl(db: SqlJsDatabase, projectPath: string, cloudFolderUrl: string | null): void {
  db.run(
    `UPDATE ruddr_projects SET cloud_folder_url = ? WHERE path = ?`,
    [cloudFolderUrl, projectPath],
  );
}

/** Look up a single project entry by name (case-insensitive). */
export function lookupRuddrProject(db: SqlJsDatabase, name: string): RuddrProjectEntry | null {
  const stmt = db.prepare('SELECT name, path, note, cloud_folder_url FROM ruddr_projects WHERE lower(name) = lower(?)');
  stmt.bind([name]);
  try {
    if (!stmt.step()) return null;
    const r = stmt.getAsObject() as { name: string; path: string; note: string | null; cloud_folder_url: string | null };
    return { name: r.name, path: r.path, note: r.note, cloud_folder_url: r.cloud_folder_url };
  } finally {
    stmt.free();
  }
}

// ── List ──────────────────────────────────────────────────────────────────────

/** Return all groups with member counts. */
export function listGroups(db: SqlJsDatabase): Group[] {
  const stmt = db.prepare(`
    SELECT
      g.id,
      g.name,
      g.created_at,
      g.updated_at,
      g.ruddr_project_name,
      (SELECT COUNT(*) FROM group_local_repos  glr WHERE glr.group_id = g.id) AS local_repo_count,
      (SELECT COUNT(*) FROM group_github_repos ggr WHERE ggr.group_id = g.id) AS github_repo_count,
      (SELECT COUNT(*) FROM onedrive_files f
         INNER JOIN onedrive_customer_folders cf ON f.folder_id = cf.id
         WHERE cf.group_id = g.id) AS file_count
    FROM groups g
    ORDER BY g.name COLLATE NOCASE
  `);
  const groups: Group[] = [];
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: number; name: string; created_at: string; updated_at: string;
        ruddr_project_name: string | null;
        local_repo_count: number; github_repo_count: number; file_count: number;
      };
      groups.push({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        localRepoCount: row.local_repo_count,
        githubRepoCount: row.github_repo_count,
        fileCount: row.file_count,
        ruddrProjectNames: parseRuddrNames(row.ruddr_project_name)
      });
    }
  } finally {
    stmt.free();
  }
  return groups;
}

// ── Get detail ────────────────────────────────────────────────────────────────

/** Return a single group with its full member lists, or null if not found. */
export function getGroup(db: SqlJsDatabase, groupId: number): GroupDetail | null {
  const gStmt = db.prepare('SELECT id, name, created_at, updated_at FROM groups WHERE id = ?');
  gStmt.bind([groupId]);
  let groupRow: { id: number; name: string; created_at: string; updated_at: string } | null = null;
  if (gStmt.step()) {
    groupRow = gStmt.getAsObject() as unknown as { id: number; name: string; created_at: string; updated_at: string };
  }
  gStmt.free();
  if (!groupRow) return null;

  // Local repo members
  const lStmt = db.prepare(`
    SELECT lr.id, lr.local_path, lr.name, glr.added_at
    FROM group_local_repos glr
    JOIN local_repos lr ON lr.id = glr.local_repo_id
    WHERE glr.group_id = ?
    ORDER BY lr.name COLLATE NOCASE
  `);
  lStmt.bind([groupId]);
  const localRepos: GroupLocalRepoMember[] = [];
  try {
    while (lStmt.step()) {
      const r = lStmt.getAsObject() as { id: number; local_path: string; name: string | null; added_at: string };
      localRepos.push({ id: r.id, localPath: r.local_path, name: r.name ?? r.local_path, addedAt: r.added_at });
    }
  } finally {
    lStmt.free();
  }

  // GitHub repo members
  const ghrStmt = db.prepare(`
    SELECT gr.id, gr.full_name, gr.name, ggr.added_at
    FROM group_github_repos ggr
    JOIN github_repos gr ON gr.id = ggr.github_repo_id
    WHERE ggr.group_id = ?
    ORDER BY gr.full_name COLLATE NOCASE
  `);
  ghrStmt.bind([groupId]);
  const githubRepos: GroupGithubRepoMember[] = [];
  try {
    while (ghrStmt.step()) {
      const r = ghrStmt.getAsObject() as { id: number; full_name: string; name: string; added_at: string };
      githubRepos.push({ id: r.id, fullName: r.full_name, name: r.name, addedAt: r.added_at });
    }
  } finally {
    ghrStmt.free();
  }

  return {
    id: groupRow.id,
    name: groupRow.name,
    createdAt: groupRow.created_at,
    updatedAt: groupRow.updated_at,
    localRepos,
    githubRepos,
    onedriveFolders: getCustomerFolderInfo(db, groupRow.id),
  };
}

// ── Create ────────────────────────────────────────────────────────────────────

/** Create a new group.  Returns the new id, or throws if name is already taken. */
export function createGroup(db: SqlJsDatabase, name: string): number {
  db.run(
    `INSERT INTO groups (name, created_at, updated_at)
     VALUES (?, datetime('now'), datetime('now'))`,
    [name],
  );
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  stmt.step();
  const row = stmt.getAsObject() as unknown as { id: number };
  stmt.free();
  return row.id;
}

// ── Rename ────────────────────────────────────────────────────────────────────

/** Rename an existing group. */
export function renameGroup(db: SqlJsDatabase, groupId: number, newName: string): void {
  db.run(
    `UPDATE groups SET name = ?, updated_at = datetime('now') WHERE id = ?`,
    [newName, groupId],
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

/** Delete a group and its membership rows. */
export function deleteGroup(db: SqlJsDatabase, groupId: number): void {
  // Manually delete join rows — sql.js does not enforce ON DELETE CASCADE
  // unless PRAGMA foreign_keys is enabled, which the app does not set.
  db.run('DELETE FROM group_local_repos  WHERE group_id = ?', [groupId]);
  db.run('DELETE FROM group_github_repos WHERE group_id = ?', [groupId]);
  db.run('DELETE FROM groups WHERE id = ?', [groupId]);
}

// ── Local repo membership ─────────────────────────────────────────────────────

export function addLocalRepoToGroup(db: SqlJsDatabase, groupId: number, localRepoId: number): void {
  db.run(
    `INSERT OR IGNORE INTO group_local_repos (group_id, local_repo_id, added_at)
     VALUES (?, ?, datetime('now'))`,
    [groupId, localRepoId],
  );
  db.run(`UPDATE groups SET updated_at = datetime('now') WHERE id = ?`, [groupId]);
}

export function removeLocalRepoFromGroup(db: SqlJsDatabase, groupId: number, localRepoId: number): void {
  db.run(
    'DELETE FROM group_local_repos WHERE group_id = ? AND local_repo_id = ?',
    [groupId, localRepoId],
  );
  db.run(`UPDATE groups SET updated_at = datetime('now') WHERE id = ?`, [groupId]);
}

// ── GitHub repo membership ────────────────────────────────────────────────────

export function addGithubRepoToGroup(db: SqlJsDatabase, groupId: number, githubRepoId: number): void {
  db.run(
    `INSERT OR IGNORE INTO group_github_repos (group_id, github_repo_id, added_at)
     VALUES (?, ?, datetime('now'))`,
    [groupId, githubRepoId],
  );
  db.run(`UPDATE groups SET updated_at = datetime('now') WHERE id = ?`, [groupId]);
}

export function removeGithubRepoFromGroup(db: SqlJsDatabase, groupId: number, githubRepoId: number): void {
  db.run(
    'DELETE FROM group_github_repos WHERE group_id = ? AND github_repo_id = ?',
    [groupId, githubRepoId],
  );
  db.run(`UPDATE groups SET updated_at = datetime('now') WHERE id = ?`, [groupId]);
}

