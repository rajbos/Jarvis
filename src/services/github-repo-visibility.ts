// ── Which accounts can see which discovered repo ─────────────────────────────
// Kept free of heavy imports so discovery can record sightings cheaply.
import type { Database as SqlJsDatabase } from 'sql.js';

/** Remember that `account` can see the repo `repoRef` (a hostKey of `owner/repo`). */
export function recordRepoVisibility(db: SqlJsDatabase, repoRef: string, account: string): void {
  db.run(
    `INSERT INTO github_repo_accounts (repo_ref, account) VALUES (?, ?)
     ON CONFLICT(repo_ref, account) DO UPDATE SET seen_at = CURRENT_TIMESTAMP`,
    [repoRef.trim().toLowerCase(), account],
  );
}

/** Accounts that discovered the repo, oldest sighting first. */
export function listRepoViewers(db: SqlJsDatabase, repoRef: string): string[] {
  const stmt = db.prepare('SELECT account FROM github_repo_accounts WHERE repo_ref = ? ORDER BY rowid');
  stmt.bind([repoRef.trim().toLowerCase()]);
  const out: string[] = [];
  while (stmt.step()) out.push((stmt.getAsObject() as { account: string }).account);
  stmt.free();
  return out;
}
