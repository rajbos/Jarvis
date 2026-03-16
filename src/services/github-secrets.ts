// ── GitHub Actions secrets scanning ──────────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../storage/database';

const GITHUB_API_BASE = 'https://api.github.com';

export interface SecretsScanResult {
  scanned: number;
  secretsFound: number;
  errors: string[];
}

export interface SecretFavoriteRow {
  id: number;
  target_type: 'org' | 'repo';
  target_name: string;
  added_at: string;
}

async function fetchRepoSecretNames(
  repoFullName: string,
  token: string,
): Promise<string[]> {
  const url = `${GITHUB_API_BASE}/repos/${repoFullName}/actions/secrets?per_page=100`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (resp.status === 403 || resp.status === 404) return [];
  if (!resp.ok) throw new Error(`GitHub API ${resp.status} for ${repoFullName}/actions/secrets`);
  const data = await resp.json() as { secrets?: Array<{ name: string }> };
  return (data.secrets ?? []).map((s) => s.name);
}

/**
 * Scan all personal repos (owned by userLogin) for their GitHub Actions secret names
 * and store results in the repo_secrets table.
 * Also scans repos from favorited orgs and favorited individual repos.
 */
export async function scanUserRepoSecrets(
  db: SqlJsDatabase,
  token: string,
  userLogin: string,
  onProgress?: (done: number, total: number, secretsFound: number) => void,
): Promise<SecretsScanResult> {
  // Collect repo IDs to scan, deduplicating via a Map<id, full_name>
  const repoMap = new Map<number, string>();

  // 1. Personal repos
  const personalStmt = db.prepare(
    `SELECT id, full_name FROM github_repos WHERE LOWER(full_name) LIKE LOWER(?) AND org_id IS NULL`,
  );
  personalStmt.bind([`${userLogin}/%`]);
  while (personalStmt.step()) {
    const r = personalStmt.getAsObject() as { id: number; full_name: string };
    repoMap.set(r.id, r.full_name);
  }
  personalStmt.free();

  // 2. Favorited orgs → all repos belonging to those orgs
  const favOrgStmt = db.prepare(
    `SELECT target_name FROM secret_scan_favorites WHERE target_type = 'org'`,
  );
  const favOrgLogins: string[] = [];
  while (favOrgStmt.step()) {
    favOrgLogins.push((favOrgStmt.getAsObject() as { target_name: string }).target_name);
  }
  favOrgStmt.free();

  for (const orgLogin of favOrgLogins) {
    const orgRepoStmt = db.prepare(
      `SELECT r.id, r.full_name
       FROM github_repos r
       JOIN github_orgs o ON o.id = r.org_id
       WHERE LOWER(o.login) = LOWER(?)`,
    );
    orgRepoStmt.bind([orgLogin]);
    while (orgRepoStmt.step()) {
      const r = orgRepoStmt.getAsObject() as { id: number; full_name: string };
      repoMap.set(r.id, r.full_name);
    }
    orgRepoStmt.free();
  }

  // 3. Favorited individual repos
  const favRepoStmt = db.prepare(
    `SELECT target_name FROM secret_scan_favorites WHERE target_type = 'repo'`,
  );
  const favRepoNames: string[] = [];
  while (favRepoStmt.step()) {
    favRepoNames.push((favRepoStmt.getAsObject() as { target_name: string }).target_name);
  }
  favRepoStmt.free();

  for (const fullName of favRepoNames) {
    const repoStmt = db.prepare(`SELECT id, full_name FROM github_repos WHERE full_name = ?`);
    repoStmt.bind([fullName]);
    if (repoStmt.step()) {
      const r = repoStmt.getAsObject() as { id: number; full_name: string };
      repoMap.set(r.id, r.full_name);
    }
    repoStmt.free();
  }

  const repos = Array.from(repoMap.entries()).map(([id, full_name]) => ({ id, full_name }));

  let secretsFound = 0;
  const errors: string[] = [];

  for (let i = 0; i < repos.length; i++) {
    onProgress?.(i, repos.length, secretsFound);
    const repo = repos[i];
    try {
      const names = await fetchRepoSecretNames(repo.full_name, token);
      db.run('DELETE FROM repo_secrets WHERE github_repo_id = ?', [repo.id]);
      for (const name of names) {
        db.run(
          `INSERT OR REPLACE INTO repo_secrets (github_repo_id, secret_name, scanned_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)`,
          [repo.id, name],
        );
        secretsFound++;
      }
    } catch (err) {
      errors.push(`${repo.full_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  saveDatabase();
  onProgress?.(repos.length, repos.length, secretsFound);
  return { scanned: repos.length, secretsFound, errors };
}

/**
 * Search secrets by name pattern, returning repo → secret-name pairs.
 */
export interface RepoSecretRow {
  full_name: string;
  secret_name: string;
  scanned_at: string;
}

export function searchSecrets(db: SqlJsDatabase, pattern: string): RepoSecretRow[] {
  const stmt = db.prepare(
    `SELECT r.full_name, s.secret_name, s.scanned_at
     FROM repo_secrets s
     JOIN github_repos r ON r.id = s.github_repo_id
     WHERE LOWER(s.secret_name) LIKE LOWER(?)
     ORDER BY r.full_name, s.secret_name`,
  );
  const rows: RepoSecretRow[] = [];
  try {
    stmt.bind([`%${pattern}%`]);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as RepoSecretRow);
  } finally {
    stmt.free();
  }
  return rows;
}

// ── Favorites CRUD ────────────────────────────────────────────────────────────

export function listSecretFavorites(db: SqlJsDatabase): SecretFavoriteRow[] {
  const stmt = db.prepare(
    `SELECT id, target_type, target_name, added_at FROM secret_scan_favorites ORDER BY target_type, target_name`,
  );
  const rows: SecretFavoriteRow[] = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as SecretFavoriteRow);
  } finally {
    stmt.free();
  }
  return rows;
}

export function addSecretFavorite(db: SqlJsDatabase, targetType: 'org' | 'repo', targetName: string): void {
  db.run(
    `INSERT OR IGNORE INTO secret_scan_favorites (target_type, target_name) VALUES (?, ?)`,
    [targetType, targetName],
  );
  saveDatabase();
}

export function removeSecretFavorite(db: SqlJsDatabase, targetName: string): void {
  db.run(`DELETE FROM secret_scan_favorites WHERE target_name = ?`, [targetName]);
  saveDatabase();
}

export function listSecretsForRepo(db: SqlJsDatabase, repoFullName: string): RepoSecretRow[] {
  const stmt = db.prepare(
    `SELECT r.full_name, s.secret_name, s.scanned_at
     FROM repo_secrets s
     JOIN github_repos r ON r.id = s.github_repo_id
     WHERE r.full_name = ?
     ORDER BY s.secret_name`,
  );
  const rows: RepoSecretRow[] = [];
  try {
    stmt.bind([repoFullName]);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as RepoSecretRow);
  } finally {
    stmt.free();
  }
  return rows;
}
