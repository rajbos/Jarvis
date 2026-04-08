// ── Ruddr project link service ────────────────────────────────────────────────
// CRUD for associating Ruddr projects with Jarvis source groups.
import type { Database as SqlJsDatabase } from 'sql.js';
import type { RuddrProjectLink } from '../plugins/types';

// ── List ──────────────────────────────────────────────────────────────────────

/** Return all Ruddr project links, optionally filtered by group. */
export function listRuddrLinks(db: SqlJsDatabase, groupId?: number): RuddrProjectLink[] {
  const sql = groupId != null
    ? `SELECT rpl.id, rpl.group_id, g.name AS group_name,
              rpl.ruddr_workspace, rpl.ruddr_project_id, rpl.ruddr_project_name,
              rpl.ruddr_project_url, rpl.extract_selector, rpl.linked_at
       FROM ruddr_project_links rpl
       JOIN groups g ON g.id = rpl.group_id
       WHERE rpl.group_id = ?
       ORDER BY rpl.ruddr_project_name COLLATE NOCASE`
    : `SELECT rpl.id, rpl.group_id, g.name AS group_name,
              rpl.ruddr_workspace, rpl.ruddr_project_id, rpl.ruddr_project_name,
              rpl.ruddr_project_url, rpl.extract_selector, rpl.linked_at
       FROM ruddr_project_links rpl
       JOIN groups g ON g.id = rpl.group_id
       ORDER BY rpl.ruddr_project_name COLLATE NOCASE`;

  const stmt = db.prepare(sql);
  if (groupId != null) stmt.bind([groupId]);
  const links: RuddrProjectLink[] = [];
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: number; group_id: number; group_name: string;
        ruddr_workspace: string; ruddr_project_id: string;
        ruddr_project_name: string; ruddr_project_url: string;
        extract_selector: string; linked_at: string;
      };
      links.push({
        id: row.id,
        groupId: row.group_id,
        groupName: row.group_name,
        ruddrWorkspace: row.ruddr_workspace,
        ruddrProjectId: row.ruddr_project_id,
        ruddrProjectName: row.ruddr_project_name,
        ruddrProjectUrl: row.ruddr_project_url,
        extractSelector: row.extract_selector,
        linkedAt: row.linked_at,
      });
    }
  } finally {
    stmt.free();
  }
  return links;
}

// ── Add ───────────────────────────────────────────────────────────────────────

/** Link a Ruddr project to a group. Returns the new link id. */
export function addRuddrLink(
  db: SqlJsDatabase,
  groupId: number,
  workspace: string,
  projectId: string,
  projectName: string,
  projectUrl: string,
  extractSelector: string,
): number {
  db.run(
    `INSERT INTO ruddr_project_links
       (group_id, ruddr_workspace, ruddr_project_id, ruddr_project_name, ruddr_project_url, extract_selector, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [groupId, workspace, projectId, projectName, projectUrl, extractSelector],
  );
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  stmt.step();
  const row = stmt.getAsObject() as unknown as { id: number };
  stmt.free();
  return row.id;
}

// ── Update ────────────────────────────────────────────────────────────────────

/** Update the name, URL, and extract selector for an existing link. */
export function updateRuddrLink(
  db: SqlJsDatabase,
  id: number,
  projectName: string,
  projectUrl: string,
  extractSelector: string,
): void {
  db.run(
    `UPDATE ruddr_project_links
     SET ruddr_project_name = ?, ruddr_project_url = ?, extract_selector = ?
     WHERE id = ?`,
    [projectName, projectUrl, extractSelector, id],
  );
}

// ── Remove ────────────────────────────────────────────────────────────────────

/** Remove a Ruddr project link by id. */
export function removeRuddrLink(db: SqlJsDatabase, id: number): void {
  db.run('DELETE FROM ruddr_project_links WHERE id = ?', [id]);
}
