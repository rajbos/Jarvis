// ── Ruddr tools for the Jarvis MCP server ─────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';

export interface RuddrProject {
  name: string;
  path: string;
  note: string | null;
  cloudFolderUrl: string | null;
  discoveredAt: string | null;
}

export interface GroupWithRuddr {
  id: number;
  name: string;
  ruddrProjectNames: string[];
  ruddrProjectPaths: string[];
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
  } catch { /* legacy plain string */ }
  return [raw];
}

/** Return all cached Ruddr projects, newest first. */
export function listRuddrProjects(db: SqlJsDatabase): RuddrProject[] {
  const stmt = db.prepare(
    'SELECT name, path, note, cloud_folder_url, discovered_at FROM ruddr_projects ORDER BY name COLLATE NOCASE',
  );
  const results: RuddrProject[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        name: string; path: string; note: string | null;
        cloud_folder_url: string | null; discovered_at: string | null;
      };
      results.push({
        name: r.name,
        path: r.path,
        note: r.note,
        cloudFolderUrl: r.cloud_folder_url,
        discoveredAt: r.discovered_at,
      });
    }
  } finally {
    stmt.free();
  }
  return results;
}

/** Look up a project by its path (primary key). */
export function getRuddrProjectByPath(db: SqlJsDatabase, projectPath: string): RuddrProject | null {
  const stmt = db.prepare(
    'SELECT name, path, note, cloud_folder_url, discovered_at FROM ruddr_projects WHERE path = ?',
  );
  stmt.bind([projectPath]);
  try {
    if (!stmt.step()) return null;
    const r = stmt.getAsObject() as {
      name: string; path: string; note: string | null;
      cloud_folder_url: string | null; discovered_at: string | null;
    };
    return { name: r.name, path: r.path, note: r.note, cloudFolderUrl: r.cloud_folder_url, discoveredAt: r.discovered_at };
  } finally {
    stmt.free();
  }
}

/** Look up a project by name (case-insensitive). Returns first match. */
export function getRuddrProjectByName(db: SqlJsDatabase, name: string): RuddrProject | null {
  const stmt = db.prepare(
    'SELECT name, path, note, cloud_folder_url, discovered_at FROM ruddr_projects WHERE lower(name) = lower(?)',
  );
  stmt.bind([name]);
  try {
    if (!stmt.step()) return null;
    const r = stmt.getAsObject() as {
      name: string; path: string; note: string | null;
      cloud_folder_url: string | null; discovered_at: string | null;
    };
    return { name: r.name, path: r.path, note: r.note, cloudFolderUrl: r.cloud_folder_url, discoveredAt: r.discovered_at };
  } finally {
    stmt.free();
  }
}

/** Return all groups that have at least one Ruddr project association. */
export function listGroupsWithRuddr(db: SqlJsDatabase): GroupWithRuddr[] {
  const stmt = db.prepare(
    `SELECT id, name, ruddr_project_name, ruddr_project_paths
     FROM groups
     WHERE ruddr_project_name IS NOT NULL OR ruddr_project_paths IS NOT NULL
     ORDER BY name COLLATE NOCASE`,
  );
  const results: GroupWithRuddr[] = [];
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as {
        id: number; name: string;
        ruddr_project_name: string | null;
        ruddr_project_paths: string | null;
      };
      results.push({
        id: r.id,
        name: r.name,
        ruddrProjectNames: parseJsonArray(r.ruddr_project_name),
        ruddrProjectPaths: parseJsonArray(r.ruddr_project_paths),
      });
    }
  } finally {
    stmt.free();
  }
  return results;
}
