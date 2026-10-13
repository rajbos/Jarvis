// ── GitHub Actions secrets scanning ──────────────────────────────────────────
// Secret names are trickle-loaded a batch at a time (a background task plus the
// "Scan Now" button), so scanning many org repos never runs for ages or eats
// the rate limit. What gets scanned:
//  - personal repos and individually favorited repos, always
//  - org repos when the org is switched on: automatically for orgs with up to
//    SECRET_SCAN_MAX_AUTO_ORG_REPOS cached repos, explicitly for bigger ones
// A repo is only rescanned when it changed since the last scan (pushed or
// updated, per the discovery cache) or the last scan is SECRETS_TTL_DAYS old:
// adding a secret does not bump a repo's timestamps, so the TTL is the safety net.
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../storage/database';
import { apiBaseForHost } from './github-host';
import { accessForRepo } from './github-repo-access';
import { logger } from './logger';

/** Orgs with more cached repos than this are only scanned when switched on explicitly. */
export const SECRET_SCAN_MAX_AUTO_ORG_REPOS = 200;
const SECRETS_TTL_DAYS = 30;
const SECRETS_RETRY_AFTER_ERROR_DAYS = 1;
const DEFAULT_BATCH_SIZE = 25;
/** Leave this much of the hourly budget to the rest of the app. */
const MIN_REMAINING_RATE_LIMIT = 1000;

export type SecretsScanStatus = 'ok' | 'no-access' | 'error';

export interface SecretsScanResult {
  scanned: number;
  secretsFound: number;
  errors: string[];
  /** Repos in scope for secrets scanning. */
  eligible: number;
  /** Eligible repos still waiting for a (re)scan after this batch. */
  pending: number;
  stoppedReason?: 'rate-limit' | 'done';
}

export interface SecretsBatchOptions {
  batchSize?: number;
  minRemaining?: number;
  /** Login whose `login/*` repos count as personal (besides repos discovery marked as owned). */
  ownerLogin?: string | null;
  /** Retried when the repo's account gets a 403/404 (e.g. an org that blocks the OAuth app). */
  patToken?: string | null;
  onProgress?: (done: number, total: number, secretsFound: number) => void;
}

export interface SecretFavoriteRow {
  id: number;
  target_type: 'org' | 'repo';
  target_name: string;
  added_at: string;
}

/** Whether an org's repos are secrets-scanned: its explicit setting, else only small, enabled orgs. */
export function isOrgSecretScanOn(org: {
  secretScanSetting: boolean | null;
  discoveryEnabled: boolean;
  largeOrg: boolean;
  repoCount: number;
}): boolean {
  if (org.secretScanSetting !== null) return org.secretScanSetting;
  return org.discoveryEnabled && !org.largeOrg && org.repoCount <= SECRET_SCAN_MAX_AUTO_ORG_REPOS;
}

/** true = always scan, false = never, null = automatic (by repo count). */
export function setOrgSecretScan(db: SqlJsDatabase, orgLogin: string, enabled: boolean | null): void {
  db.run('UPDATE github_orgs SET secret_scan_enabled = ? WHERE LOWER(login) = LOWER(?)', [
    enabled === null ? null : enabled ? 1 : 0,
    orgLogin,
  ]);
  // Legacy org favorites meant "always"; the org setting replaces them.
  db.run(`DELETE FROM secret_scan_favorites WHERE target_type = 'org' AND LOWER(target_name) = LOWER(?)`, [orgLogin]);
  saveDatabase();
}

// Repos in scope. Binds: [owner prefix]
const ELIGIBLE_WHERE = `(
  (r.org_id IS NULL AND (r.collaboration_reason = 'owner' OR LOWER(r.full_name) LIKE LOWER(?)))
  OR r.full_name IN (SELECT target_name FROM secret_scan_favorites WHERE target_type = 'repo')
  OR (o.id IS NOT NULL AND (
    o.secret_scan_enabled = 1
    OR LOWER(o.login) IN (SELECT LOWER(target_name) FROM secret_scan_favorites WHERE target_type = 'org')
    OR (o.secret_scan_enabled IS NULL AND o.discovery_enabled = 1 AND o.large_org = 0
        AND (SELECT COUNT(*) FROM github_repos x WHERE x.org_id = o.id) <= ${SECRET_SCAN_MAX_AUTO_ORG_REPOS})
  ))
)`;

// Eligible repos whose stored secret names may be outdated. Repos we have no
// access to are not retried on every push, only after the TTL.
const NEEDS_SCAN_WHERE = `(
  r.secrets_scanned_at IS NULL
  OR r.secrets_scanned_at < datetime('now', CASE WHEN r.secrets_scan_status = 'error' THEN '-${SECRETS_RETRY_AFTER_ERROR_DAYS} day' ELSE '-${SECRETS_TTL_DAYS} day' END)
  OR (r.secrets_scan_status = 'ok' AND (
    datetime(r.last_pushed_at) > datetime(r.secrets_scanned_at)
    OR datetime(r.last_updated_at) > datetime(r.secrets_scanned_at)
  ))
)`;

const FROM_REPOS = 'FROM github_repos r LEFT JOIN github_orgs o ON o.id = r.org_id';

function ownerPrefix(ownerLogin: string | null | undefined): string {
  // An empty pattern matches no repo name.
  return ownerLogin ? `${ownerLogin}/%` : '';
}

function countRepos(db: SqlJsDatabase, where: string, ownerLogin: string | null | undefined): number {
  const stmt = db.prepare(`SELECT COUNT(*) AS n ${FROM_REPOS} WHERE ${where}`);
  try {
    stmt.bind([ownerPrefix(ownerLogin)]);
    stmt.step();
    return (stmt.getAsObject() as { n: number }).n;
  } finally {
    stmt.free();
  }
}

export function countReposNeedingSecretsScan(db: SqlJsDatabase, ownerLogin?: string | null): number {
  return countRepos(db, `${ELIGIBLE_WHERE} AND ${NEEDS_SCAN_WHERE}`, ownerLogin);
}

interface Candidate {
  id: number;
  full_name: string;
  host: string;
}

// Personal and favorited repos first, then never-scanned ones, then most recently pushed.
function pickCandidates(db: SqlJsDatabase, ownerLogin: string | null | undefined, limit: number): Candidate[] {
  const stmt = db.prepare(
    `SELECT r.id, r.full_name, r.host ${FROM_REPOS}
     WHERE ${ELIGIBLE_WHERE} AND ${NEEDS_SCAN_WHERE}
     ORDER BY r.org_id IS NOT NULL, r.secrets_scanned_at IS NOT NULL, r.last_pushed_at DESC
     LIMIT ?`,
  );
  const rows: Candidate[] = [];
  try {
    stmt.bind([ownerPrefix(ownerLogin), limit]);
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as Candidate);
  } finally {
    stmt.free();
  }
  return rows;
}

interface SecretsFetch {
  /** HTTP status; 429 also stands for a 403 with an exhausted rate limit. */
  status: number;
  names: string[];
  /** x-ratelimit-remaining of the response, NaN when absent. */
  remaining: number;
}

async function fetchRepoSecretNames(
  repoFullName: string,
  host: string,
  token: string | null,
  patToken?: string | null,
): Promise<SecretsFetch> {
  const url = `${apiBaseForHost(host)}/repos/${repoFullName}/actions/secrets?per_page=100`;

  const tryFetch = async (t: string): Promise<SecretsFetch> => {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const remaining = parseInt(resp.headers.get('x-ratelimit-remaining') ?? '', 10);
    if (resp.status === 429 || (resp.status === 403 && remaining === 0)) return { status: 429, names: [], remaining };
    if (resp.status === 403 || resp.status === 404) return { status: resp.status, names: [], remaining };
    if (!resp.ok) throw new Error(`GitHub API ${resp.status} for ${repoFullName}/actions/secrets`);
    const data = await resp.json() as { secrets?: Array<{ name: string }> };
    return { status: 200, names: (data.secrets ?? []).map((s) => s.name), remaining };
  };

  const first = token ? await tryFetch(token) : null;
  // If the account was blocked (403/404) and a PAT is available, retry with the PAT
  if ((!first || first.status === 403 || first.status === 404) && patToken && patToken !== token) {
    return tryFetch(patToken);
  }
  return first ?? { status: 401, names: [], remaining: NaN };
}

function markScanned(db: SqlJsDatabase, repoId: number, status: SecretsScanStatus): void {
  db.run(`UPDATE github_repos SET secrets_scanned_at = datetime('now'), secrets_scan_status = ? WHERE id = ?`, [status, repoId]);
}

// Batches never overlap: the background task and "Scan Now" take turns.
let queue: Promise<unknown> = Promise.resolve();

/** Fetch secret names for the next batch of repos that need a (re)scan. Safe to call on a timer. */
export function runSecretsBatch(db: SqlJsDatabase, opts: SecretsBatchOptions = {}): Promise<SecretsScanResult> {
  const run = queue.then(() => scanBatch(db, opts));
  queue = run.catch(() => undefined);
  return run;
}

async function scanBatch(db: SqlJsDatabase, opts: SecretsBatchOptions): Promise<SecretsScanResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const minRemaining = opts.minRemaining ?? MIN_REMAINING_RATE_LIMIT;
  const repos = pickCandidates(db, opts.ownerLogin, batchSize);

  let scanned = 0;
  let secretsFound = 0;
  const errors: string[] = [];
  let stoppedReason: SecretsScanResult['stoppedReason'];

  for (const repo of repos) {
    opts.onProgress?.(scanned, repos.length, secretsFound);
    try {
      const access = await accessForRepo(db, repo.full_name, repo.host);
      const result = await fetchRepoSecretNames(repo.full_name, repo.host, access?.token ?? null, opts.patToken);
      if (result.status === 429) {
        stoppedReason = 'rate-limit';
        break;
      }
      // Also on a 403/404: without access the names we had may be stale.
      db.run('DELETE FROM repo_secrets WHERE github_repo_id = ?', [repo.id]);
      for (const name of result.names) {
        db.run(
          `INSERT OR REPLACE INTO repo_secrets (github_repo_id, secret_name, scanned_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)`,
          [repo.id, name],
        );
        secretsFound++;
      }
      markScanned(db, repo.id, result.status === 200 ? 'ok' : 'no-access');
      scanned++;
      if (!Number.isNaN(result.remaining) && result.remaining < minRemaining) {
        stoppedReason = 'rate-limit';
        break;
      }
    } catch (err) {
      markScanned(db, repo.id, 'error');
      scanned++;
      errors.push(`${repo.full_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  saveDatabase();
  opts.onProgress?.(scanned, repos.length, secretsFound);
  const pending = countReposNeedingSecretsScan(db, opts.ownerLogin);
  const eligible = countRepos(db, ELIGIBLE_WHERE, opts.ownerLogin);
  if (!stoppedReason && pending === 0) stoppedReason = 'done';
  logger.debug(`[Secrets] Batch: ${scanned} scanned, ${secretsFound} secrets, ${errors.length} errors, ${pending}/${eligible} pending`);
  return { scanned, secretsFound, errors, eligible, pending, stoppedReason };
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
