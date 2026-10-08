// ── Searchable repo catalog: trickle-loaded README excerpts ───────────────────
// Discovery (github-discovery.ts) lists the repos the user can see, with their
// description, role (owner / collaborator / contributor / org member) and
// stars / watches. This module fills in the one thing a listing does not
// carry — the README — a few repos at a time, so the cache converges without
// ever hammering the API. Everything is cached heavily:
//  - a README is only refetched after README_TTL_DAYS (failures after a day)
//  - refetches are conditional (If-None-Match), and a 304 costs no rate limit
//  - repos in unapproved large orgs or disabled orgs are never touched
//  - the batch stops as soon as the remaining rate limit drops too low
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../storage/database';
import { apiBaseForHost } from './github-host';
import { accessForRepo } from './github-repo-access';
import { logger } from './logger';

export const README_MAX_LINES = 200;
/** Hard cap on stored characters, so a README with enormous lines cannot bloat the DB. */
export const README_MAX_CHARS = 20_000;
const README_TTL_DAYS = 14;
const README_RETRY_AFTER_ERROR_DAYS = 1;
const DEFAULT_BATCH_SIZE = 20;
/** Leave this much of the hourly budget to the rest of the app. */
const MIN_REMAINING_RATE_LIMIT = 1000;

export type ReadmeStatus = 'ok' | 'none' | 'error';

export interface ReadmeBatchResult {
  attempted: number;
  fetched: number;
  notModified: number;
  missing: number;
  failed: number;
  /** Repos still waiting for their first (or a stale) README after this batch. */
  pending: number;
  stoppedReason?: 'rate-limit' | 'no-token' | 'done';
}

export interface ReadmeBatchOptions {
  batchSize?: number;
  minRemaining?: number;
}

/** First README_MAX_LINES lines (and README_MAX_CHARS characters) of a README. */
export function truncateReadme(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const head = lines.slice(0, README_MAX_LINES).join('\n').trimEnd();
  return head.length > README_MAX_CHARS ? head.slice(0, README_MAX_CHARS) : head;
}

// Repos that need a README (re)fetch, most personally relevant first:
// external collaborator/contributor repos, then stars, then watched, then the rest.
const CANDIDATES_WHERE = `
  (o.id IS NULL OR (o.discovery_enabled = 1 AND (o.large_org = 0 OR o.large_org_approved = 1)))
  AND (r.readme_fetched_at IS NULL
       OR r.readme_fetched_at < datetime('now', CASE WHEN r.readme_status = 'error' THEN '-${README_RETRY_AFTER_ERROR_DAYS} day' ELSE '-${README_TTL_DAYS} day' END))`;

export function countReposNeedingReadme(db: SqlJsDatabase): number {
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n FROM github_repos r LEFT JOIN github_orgs o ON o.id = r.org_id WHERE ${CANDIDATES_WHERE}`,
  );
  stmt.step();
  const n = (stmt.getAsObject() as { n: number }).n;
  stmt.free();
  return n;
}

interface Candidate {
  full_name: string;
  host: string;
  readme_etag: string | null;
}

function pickCandidates(db: SqlJsDatabase, limit: number): Candidate[] {
  const stmt = db.prepare(
    `SELECT r.full_name, r.host, r.readme_etag
     FROM github_repos r LEFT JOIN github_orgs o ON o.id = r.org_id
     WHERE ${CANDIDATES_WHERE}
     ORDER BY
       CASE
         WHEN r.collaboration_reason IS NOT NULL AND r.collaboration_reason NOT IN ('owner', 'org_member') THEN 0
         WHEN r.starred = 1 THEN 1
         WHEN r.watching = 1 THEN 2
         ELSE 3
       END,
       r.readme_fetched_at IS NOT NULL,
       r.last_pushed_at DESC
     LIMIT ?`,
  );
  stmt.bind([limit]);
  const rows: Candidate[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as Candidate);
  stmt.free();
  return rows;
}

function storeReadme(
  db: SqlJsDatabase,
  fullName: string,
  status: ReadmeStatus,
  excerpt?: string | null,
  etag?: string | null,
): void {
  if (status === 'ok') {
    db.run(
      `UPDATE github_repos SET readme_excerpt = ?, readme_etag = ?, readme_status = 'ok', readme_fetched_at = datetime('now') WHERE full_name = ?`,
      [excerpt ?? null, etag ?? null, fullName],
    );
  } else if (status === 'none') {
    db.run(
      `UPDATE github_repos SET readme_excerpt = NULL, readme_etag = NULL, readme_status = 'none', readme_fetched_at = datetime('now') WHERE full_name = ?`,
      [fullName],
    );
  } else {
    // Keep whatever excerpt we had; only remember that we tried.
    db.run(`UPDATE github_repos SET readme_status = 'error', readme_fetched_at = datetime('now') WHERE full_name = ?`, [fullName]);
  }
}

/** Fetch and cache READMEs for the next few repos that need one. Safe to call on a timer. */
export async function runReadmeBatch(db: SqlJsDatabase, opts: ReadmeBatchOptions = {}): Promise<ReadmeBatchResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const minRemaining = opts.minRemaining ?? MIN_REMAINING_RATE_LIMIT;
  const result: ReadmeBatchResult = { attempted: 0, fetched: 0, notModified: 0, missing: 0, failed: 0, pending: 0 };

  const candidates = pickCandidates(db, batchSize);
  if (candidates.length === 0) {
    result.stoppedReason = 'done';
    return result;
  }

  for (const repo of candidates) {
    const access = await accessForRepo(db, repo.full_name, repo.host);
    if (!access) {
      // No credential for this repo's host/account: retry on the normal schedule.
      storeReadme(db, repo.full_name, 'error');
      result.failed++;
      result.attempted++;
      continue;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${access.token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Jarvis-Agent/0.1.0',
    };
    if (repo.readme_etag) headers['If-None-Match'] = repo.readme_etag;

    result.attempted++;
    try {
      const res = await fetch(`${apiBaseForHost(repo.host)}/repos/${repo.full_name}/readme`, { headers });
      const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '', 10);

      if (res.status === 304) {
        db.run(`UPDATE github_repos SET readme_fetched_at = datetime('now'), readme_status = 'ok' WHERE full_name = ?`, [repo.full_name]);
        result.notModified++;
      } else if (res.status === 404) {
        storeReadme(db, repo.full_name, 'none');
        result.missing++;
      } else if (res.ok) {
        storeReadme(db, repo.full_name, 'ok', truncateReadme(await res.text()), res.headers.get('etag'));
        result.fetched++;
      } else {
        storeReadme(db, repo.full_name, 'error');
        result.failed++;
        if (res.status === 429 || (res.status === 403 && remaining === 0)) {
          result.stoppedReason = 'rate-limit';
          break;
        }
      }

      if (!Number.isNaN(remaining) && remaining < minRemaining) {
        result.stoppedReason = 'rate-limit';
        break;
      }
    } catch (err) {
      storeReadme(db, repo.full_name, 'error');
      result.failed++;
      logger.warn(`[Catalog] README fetch failed for ${repo.full_name}:`, err instanceof Error ? err.message : String(err));
    }
  }

  saveDatabase();
  result.pending = countReposNeedingReadme(db);
  logger.debug(
    `[Catalog] README batch: ${result.fetched} new, ${result.notModified} unchanged, ${result.missing} missing, ` +
      `${result.failed} failed, ${result.pending} pending`,
  );
  return result;
}
