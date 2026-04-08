// ── Groups service ─────────────────────────────────────────────────────────────
// CRUD operations and membership management for source groups.
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Group, GroupDetail, GroupLocalRepoMember, GroupGithubRepoMember } from '../plugins/types';
import { listRuddrLinks } from './ruddr';

// ── List ──────────────────────────────────────────────────────────────────────

/** Return all groups with member counts. */
export function listGroups(db: SqlJsDatabase): Group[] {
  const stmt = db.prepare(`
    SELECT
      g.id,
      g.name,
      g.created_at,
      g.updated_at,
      (SELECT COUNT(*) FROM group_local_repos  glr WHERE glr.group_id = g.id) AS local_repo_count,
      (SELECT COUNT(*) FROM group_github_repos ggr WHERE ggr.group_id = g.id) AS github_repo_count
    FROM groups g
    ORDER BY g.name COLLATE NOCASE
  `);
  const groups: Group[] = [];
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: number; name: string; created_at: string; updated_at: string;
        local_repo_count: number; github_repo_count: number;
      };
      groups.push({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        localRepoCount: row.local_repo_count,
        githubRepoCount: row.github_repo_count,
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
    ruddrLinks: listRuddrLinks(db, groupRow.id),
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
