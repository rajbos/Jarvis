// ── Repos IPC handlers ────────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('github:search-repos', (_event, query: string) => {
    if (!query || query.trim().length < 2) return [];

    try {
      const words = query.trim().split(/\s+/).filter((w) => w.length > 0);
      const bindParams: string[] = [];

      const conditions = words.map((w) => {
        bindParams.push(`%${w}%`, `%${w}%`);
        return `(r.full_name LIKE ? OR r.name LIKE ?)`;
      }).join(' AND ');

      const firstPattern = `%${words[0]}%`;
      bindParams.push(firstPattern);

      const sql = `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived, r.collaboration_reason
         FROM github_repos r
         LEFT JOIN github_orgs o ON o.id = r.org_id
         WHERE (${conditions})
           AND (r.org_id IS NULL OR o.discovery_enabled = 1)
         ORDER BY
           CASE WHEN r.name LIKE ? THEN 0 ELSE 1 END,
           r.last_pushed_at DESC
         LIMIT 50`;

      const stmt = db.prepare(sql);
      const rows: { full_name: string; name: string; description: string | null; language: string | null; private: number; fork: number; archived: number; collaboration_reason: string | null }[] = [];
      try {
        stmt.bind(bindParams);
        while (stmt.step()) rows.push(stmt.getAsObject() as typeof rows[0]);
      } finally {
        stmt.free();
      }
      return rows;
    } catch (err) {
      console.error('[repos] github:search-repos error:', err);
      return [];
    }
  });

  ipcMain.handle('github:list-repos-for-org', (_event, orgLogin: string | null) => {
    if (orgLogin !== null && (typeof orgLogin !== 'string' || orgLogin.length === 0)) {
      return { ok: false, error: 'Invalid orgLogin' };
    }

    try {
      let stmt;
      if (orgLogin === null) {
        stmt = db.prepare(
          `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived,
                  r.default_branch, r.parent_full_name, r.last_pushed_at, r.last_updated_at,
                  r.collaboration_reason
           FROM github_repos r
           WHERE r.org_id IS NULL
           ORDER BY r.last_pushed_at DESC`,
        );
        stmt.bind([]);
      } else {
        stmt = db.prepare(
          `SELECT r.full_name, r.name, r.description, r.language, r.private, r.fork, r.archived,
                  r.default_branch, r.parent_full_name, r.last_pushed_at, r.last_updated_at,
                  r.collaboration_reason
           FROM github_repos r
           JOIN github_orgs o ON o.id = r.org_id
           WHERE o.login = ?
           ORDER BY r.last_pushed_at DESC`,
        );
        stmt.bind([orgLogin]);
      }
      const rows: Record<string, unknown>[] = [];
      try {
        while (stmt.step()) rows.push(stmt.getAsObject());
      } finally {
        stmt.free();
      }
      return rows;
    } catch (err) {
      console.error('[repos] github:list-repos-for-org error:', err);
      return [];
    }
  });

  ipcMain.handle('github:list-starred', () => {
    try {
      const stmt = db.prepare(
        `SELECT full_name, name, description, language, private, fork, archived,
                default_branch, parent_full_name, last_pushed_at, collaboration_reason
         FROM github_repos
         WHERE starred = 1
         ORDER BY last_pushed_at DESC`,
      );
      const rows: Record<string, unknown>[] = [];
      try {
        while (stmt.step()) rows.push(stmt.getAsObject());
      } finally {
        stmt.free();
      }
      return rows;
    } catch (err) {
      console.error('[repos] github:list-starred error:', err);
      return [];
    }
  });
}
