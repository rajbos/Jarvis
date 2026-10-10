import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../storage/database';
import { logger } from './logger';
import {
  computeRateLimitWaitMs,
  isPrimaryRateLimited,
  isSecondaryRateLimited,
  parseRateLimit,
  rateLimitResourceForUrl,
  sleep,
  type RateLimitInfo,
} from './github-fetch';

import { currentApiBase, currentHostContext, hostKey } from './github-host';
import { recordRepoVisibility } from './github-repo-visibility';
const PER_PAGE = 100;
const CALLS_PER_BATCH = 500;
const BATCH_PAUSE_MS = 10_000; // 10 seconds between batches
const LOW_RATE_LIMIT_THRESHOLD = 5;
const MAX_SECONDARY_RATE_LIMIT_RETRIES = 2;
const PARALLEL_PAGE_CONCURRENCY = 10; // max simultaneous page requests
/** Orgs with more repos than this are skipped until the user explicitly approves them. */
export const MAX_ORG_REPOS = 500;

/** Thrown while listing an org's repos when the page count shows it exceeds the repo limit. */
export class OrgTooLargeError extends Error {
  constructor(readonly lastPage: number) {
    super(`Org has more than ${MAX_ORG_REPOS} repos (${lastPage} pages)`);
    this.name = 'OrgTooLargeError';
  }
}

export type { RateLimitInfo };

export interface DiscoveryState {
  callsSinceLastPause: number;
  aborted: boolean;
  /** Latest core-bucket info — what the UI shows as "the" rate limit. */
  lastRateLimit: RateLimitInfo | null;
  /**
   * Latest info per bucket (`x-ratelimit-resource`: core, search, graphql, …).
   * Search responses report the 30/min search bucket, so pauses must only look
   * at the bucket the next call will be billed against.
   */
  rateLimits?: Record<string, RateLimitInfo>;
}

function recordRateLimit(state: DiscoveryState, url: string, info: RateLimitInfo): string {
  const resource = info.resource ?? rateLimitResourceForUrl(url);
  state.rateLimits = { ...state.rateLimits, [resource]: info };
  if (resource === 'core') state.lastRateLimit = info;
  return resource;
}

export interface DiscoveryProgress {
  phase: 'orgs' | 'repos' | 'user-repos' | 'starred' | 'pat-repos' | 'done';
  orgsFound: number;
  reposFound: number;
  currentOrg?: string;
}

/** Options for running discovery as an additional (non-primary) account. */
export interface DiscoveryOptions {
  /** Stars belong to the primary account only — don't let another account overwrite them. */
  skipStarred?: boolean;
}

export interface OrgInfo {
  id: number;
  login: string;
  name: string | null;
  discoveryEnabled: boolean;
  indexedAt: string | null;
  repoCount: number;
  /** More than MAX_ORG_REPOS repos: not scanned until approved. */
  largeOrg: boolean;
  largeOrgApproved: boolean;
}

interface GitHubRepo {
  full_name: string;
  name: string;
  description?: string | null;
  default_branch?: string | null;
  language?: string | null;
  archived?: boolean;
  fork?: boolean;
  private?: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
  parent?: { full_name: string } | null;
  owner?: { login?: string; type?: string };
}

// ─── Rate-limit helpers ────────────────────────────────────────────

function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/** Extracts the page number from the `last` link in a GitHub Link header. */
function parseLinkLastPage(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Pause when we've consumed CALLS_PER_BATCH API calls, or when the
 * remaining budget of the bucket `resource` drops below the safety threshold.
 */
async function rateLimitAwarePause(state: DiscoveryState, resource: string): Promise<void> {
  if (state.aborted) return;

  state.callsSinceLastPause++;

  if (state.callsSinceLastPause >= CALLS_PER_BATCH) {
    logger.debug(`[Discovery] Pausing after ${state.callsSinceLastPause} API calls (batch cooldown)…`);
    await sleep(BATCH_PAUSE_MS);
    state.callsSinceLastPause = 0;
  }

  const info = resource === 'core' ? (state.rateLimits?.core ?? state.lastRateLimit) : state.rateLimits?.[resource];
  if (info && info.remaining < LOW_RATE_LIMIT_THRESHOLD) {
    const waitMs = info.reset * 1000 - Date.now() + 1000;
    if (waitMs > 0) {
      logger.debug(
        `[Discovery] Rate limit low (${resource}: ${info.remaining} remaining). ` +
          `Waiting ${Math.ceil(waitMs / 1000)}s until reset…`,
      );
      await sleep(waitMs);
    }
  }
}

// ─── Generic GitHub API fetch with rate-limit tracking ─────────────

async function githubGet<T>(
  accessToken: string,
  url: string,
  state: DiscoveryState,
  pageNum?: number,
  totalPages?: number,
  secondaryRetries = 0,
): Promise<{ data: T; nextUrl: string | null; lastPage: number | null }> {
  await rateLimitAwarePause(state, rateLimitResourceForUrl(url));

  if (state.aborted) {
    throw new Error('Discovery aborted');
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Jarvis-Agent/0.1.0',
    },
  });

  const info = parseRateLimit(response.headers);
  const resource = info ? recordRateLimit(state, url, info) : null;
  const pageInfo = pageNum !== undefined && totalPages !== undefined
    ? ` — ${pageNum}/${totalPages} pages`
    : '';
  logger.debug(
    `[Discovery] ${url.replace(currentApiBase(), '')}${pageInfo} — ` +
      (info ? `rate limit (${resource}): ${info.remaining}/${info.limit}` : 'rate limit: unknown'),
  );

  // Primary rate limit exceeded — wait until the bucket resets, then retry
  if (isPrimaryRateLimited(response, info)) {
    const waitMs = computeRateLimitWaitMs(response, info);
    if (waitMs > 0) {
      logger.debug(`[Discovery] Rate limit exceeded (${resource}). Waiting ${Math.ceil(waitMs / 1000)}s…`);
      await sleep(waitMs);
    }
    state.callsSinceLastPause = 0;
    return githubGet(accessToken, url, state, pageNum, totalPages, secondaryRetries);
  }

  // Secondary rate limit — the primary budget is fine, GitHub wants us to back off
  if (await isSecondaryRateLimited(response, info)) {
    const waitMs = computeRateLimitWaitMs(response, info);
    if (secondaryRetries >= MAX_SECONDARY_RATE_LIMIT_RETRIES) {
      throw new Error(`GitHub secondary rate limit for ${url} (retry in ${Math.ceil(waitMs / 1000)}s)`);
    }
    logger.debug(`[Discovery] Secondary rate limit hit. Waiting ${Math.ceil(waitMs / 1000)}s…`);
    await sleep(waitMs);
    return githubGet(accessToken, url, state, pageNum, totalPages, secondaryRetries + 1);
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} for ${url}`);
  }

  const data = (await response.json()) as T;
  const linkHeader = response.headers.get('link');
  const nextUrl = parseLinkNext(linkHeader);
  const lastPage = parseLinkLastPage(linkHeader);
  return { data, nextUrl, lastPage };
}

async function fetchAllPages<T>(
  accessToken: string,
  initialUrl: string,
  state: DiscoveryState,
  maxRepos?: number,
): Promise<T[]> {
  // ── Page 1: establishes total page count ──────────────────────
  const first = await githubGet<T[]>(accessToken, initialUrl, state, 1);
  const results: T[] = [...first.data];

  if (!first.nextUrl || state.aborted) return results;

  const totalPages = first.lastPage ?? null;

  // Page 1 already told us how big the list is — bail out before fetching the rest.
  if (maxRepos !== undefined && totalPages !== null && totalPages > Math.ceil(maxRepos / PER_PAGE)) {
    throw new OrgTooLargeError(totalPages);
  }

  // ── If total is known, fetch all remaining pages in parallel batches
  if (totalPages !== null) {
    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);

    for (let batchStart = 0; batchStart < remainingPages.length && !state.aborted; batchStart += PARALLEL_PAGE_CONCURRENCY) {
      const batch = remainingPages.slice(batchStart, batchStart + PARALLEL_PAGE_CONCURRENCY);

      const pageResults = await Promise.all(
        batch.map((page) => {
          const pageUrl = initialUrl.includes('?')
            ? `${initialUrl}&page=${page}`
            : `${initialUrl}?page=${page}`;
          return githubGet<T[]>(accessToken, pageUrl, state, page, totalPages);
        }),
      );

      for (const r of pageResults) {
        results.push(...r.data);
      }
    }
    return results;
  }

  // ── Fallback: no `last` link — paginate sequentially via next links
  let url: string | null = first.nextUrl;
  while (url && !state.aborted) {
    const result: { data: T[]; nextUrl: string | null; lastPage: number | null } = await githubGet<T[]>(accessToken, url, state);
    results.push(...result.data);
    url = result.nextUrl;
  }

  return results;
}

/**
 * Like fetchAllPages, but the URL must include `sort=updated&direction=desc`.
 * When a sinceDate is provided, pagination stops as soon as the oldest repo
 * on a page was last updated before that date — no older repos can appear on
 * subsequent pages, so fetching them would be wasteful.
 */
async function fetchPagesSortedSince(
  accessToken: string,
  initialUrl: string,
  state: DiscoveryState,
  sinceDate: Date | null,
): Promise<GitHubRepo[]> {
  const results: GitHubRepo[] = [];
  let url: string | null = initialUrl;
  let pagesFetched = 0;

  while (url && !state.aborted) {
    const result: { data: GitHubRepo[]; nextUrl: string | null } = await githubGet<GitHubRepo[]>(accessToken, url, state);
    results.push(...result.data);
    pagesFetched++;

    if (sinceDate && result.data.length > 0) {
      const oldestOnPage = result.data[result.data.length - 1];
      if (oldestOnPage.updated_at && new Date(oldestOnPage.updated_at) < sinceDate) {
        logger.debug(
          `[Discovery] Early-stop after ${pagesFetched} page(s): oldest updated_at ${oldestOnPage.updated_at} < cutoff ${sinceDate.toISOString()}`,
        );
        break;
      }
    }

    url = result.nextUrl;
  }

  return results;
}

// ─── DB upsert helpers ─────────────────────────────────────────────

export function upsertOrg(
  db: SqlJsDatabase,
  org: { login: string; name?: string | null; description?: string | null },
): number {
  db.run(
    `INSERT INTO github_orgs (login, name, indexed_at, metadata, host)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT(login) DO UPDATE SET
       name = excluded.name,
       indexed_at = excluded.indexed_at,
       metadata = excluded.metadata`,
    [
      org.login,
      org.name || null,
      org.description ? JSON.stringify({ description: org.description }) : null,
      currentHostContext().host,
    ],
  );

  const stmt = db.prepare('SELECT id FROM github_orgs WHERE login = ?');
  stmt.bind([org.login]);
  stmt.step();
  const row = stmt.getAsObject() as { id: number };
  stmt.free();
  return row.id;
}

export function listOrgs(db: SqlJsDatabase): { orgs: OrgInfo[]; directRepoCount: number; starredRepoCount: number } {
  const orgs: OrgInfo[] = [];
  const stmt = db.prepare(
    `SELECT o.id, o.login, o.name, o.discovery_enabled, o.indexed_at,
            (SELECT COUNT(*) FROM github_repos r WHERE r.org_id = o.id) AS repo_count,
            o.large_org, o.large_org_approved
     FROM github_orgs o
     ORDER BY o.login COLLATE NOCASE`,
  );
  while (stmt.step()) {
    const row = stmt.getAsObject() as { id: number; login: string; name: string | null; discovery_enabled: number; indexed_at: string | null; repo_count: number; large_org: number; large_org_approved: number };
    orgs.push({
      id: row.id,
      login: row.login,
      name: row.name,
      discoveryEnabled: row.discovery_enabled !== 0,
      indexedAt: row.indexed_at,
      repoCount: row.repo_count,
      largeOrg: row.large_org === 1,
      largeOrgApproved: row.large_org_approved === 1,
    });
  }
  stmt.free();

  const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM github_repos WHERE org_id IS NULL');
  countStmt.step();
  const directRepoCount = (countStmt.getAsObject() as { cnt: number }).cnt;
  countStmt.free();

  const starredStmt = db.prepare('SELECT COUNT(*) AS cnt FROM github_repos WHERE starred = 1');
  starredStmt.step();
  const starredRepoCount = (starredStmt.getAsObject() as { cnt: number }).cnt;
  starredStmt.free();

  return { orgs, directRepoCount, starredRepoCount };
}

export function markOrgLarge(db: SqlJsDatabase, orgLogin: string): void {
  db.run('UPDATE github_orgs SET large_org = 1 WHERE login = ?', [orgLogin]);
}

/** Explicit permission to scan an org that exceeds MAX_ORG_REPOS. */
export function approveLargeOrg(db: SqlJsDatabase, orgLogin: string, approved: boolean): void {
  db.run('UPDATE github_orgs SET large_org_approved = ? WHERE login = ?', [approved ? 1 : 0, orgLogin]);
}

/** Logins of large orgs that have not been approved: discovery must not scan them. */
export function listBlockedLargeOrgs(db: SqlJsDatabase): string[] {
  const stmt = db.prepare('SELECT login FROM github_orgs WHERE large_org = 1 AND large_org_approved = 0');
  const out: string[] = [];
  while (stmt.step()) out.push((stmt.getAsObject() as { login: string }).login);
  stmt.free();
  return out;
}

function isLargeOrgApproved(db: SqlJsDatabase, orgLogin: string): boolean {
  const stmt = db.prepare('SELECT large_org_approved AS a FROM github_orgs WHERE login = ?');
  stmt.bind([orgLogin]);
  const approved = stmt.step() && (stmt.getAsObject() as { a: number }).a === 1;
  stmt.free();
  return approved;
}

/**
 * Lists every repo of an org, unless it has more than MAX_ORG_REPOS and was not
 * approved: then the org is flagged (large_org) and null is returned.
 */
async function fetchOrgRepos(
  db: SqlJsDatabase,
  token: string,
  orgLogin: string,
  state: DiscoveryState,
): Promise<GitHubRepo[] | null> {
  const limit = isLargeOrgApproved(db, orgLogin) ? undefined : MAX_ORG_REPOS;
  try {
    return await fetchAllPages<GitHubRepo>(
      token,
      `${currentApiBase()}/orgs/${encodeURIComponent(orgLogin)}/repos?type=all&per_page=${PER_PAGE}`,
      state,
      limit,
    );
  } catch (err) {
    if (!(err instanceof OrgTooLargeError)) throw err;
    logger.warn(`[Discovery] Skipping ${orgLogin}: more than ${MAX_ORG_REPOS} repos — needs explicit approval`);
    markOrgLarge(db, orgLogin);
    saveDatabase();
    return null;
  }
}

export function setOrgDiscoveryEnabled(db: SqlJsDatabase, orgLogin: string, enabled: boolean): void {
  db.run('UPDATE github_orgs SET discovery_enabled = ? WHERE login = ?', [enabled ? 1 : 0, orgLogin]);
}

function getConfigValue(db: SqlJsDatabase, key: string): string | null {
  try {
    const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
    stmt.bind([key]);
    const found = stmt.step();
    const value = found ? (stmt.getAsObject() as { value: string }).value : null;
    stmt.free();
    return value;
  } catch {
    return null;
  }
}

function setConfigValue(db: SqlJsDatabase, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value]);
}

export function upsertRepo(
  db: SqlJsDatabase,
  repo: {
    full_name: string;
    name: string;
    description?: string | null;
    default_branch?: string | null;
    language?: string | null;
    archived?: boolean;
    fork?: boolean;
    private?: boolean;
    pushed_at?: string | null;
    updated_at?: string | null;
    parent?: { full_name: string } | null;
  },
  orgId: number | null,
  collaborationReason?: string | null,
): void {
  const ctx = currentHostContext();
  db.run(
    `INSERT INTO github_repos
       (org_id, full_name, name, description, default_branch, language,
        archived, fork, parent_full_name, private,
        last_pushed_at, last_updated_at, indexed_at, collaboration_reason, host)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
     ON CONFLICT(full_name) DO UPDATE SET
       org_id          = excluded.org_id,
       name            = excluded.name,
       description     = excluded.description,
       default_branch  = excluded.default_branch,
       language        = excluded.language,
       archived        = excluded.archived,
       fork            = excluded.fork,
       parent_full_name = excluded.parent_full_name,
       private         = excluded.private,
       last_pushed_at  = excluded.last_pushed_at,
       last_updated_at = excluded.last_updated_at,
       indexed_at      = excluded.indexed_at,
       collaboration_reason = COALESCE(excluded.collaboration_reason, github_repos.collaboration_reason)`,
    [
      orgId,
      repo.full_name,
      repo.name,
      repo.description || null,
      repo.default_branch || null,
      repo.language || null,
      repo.archived ? 1 : 0,
      repo.fork ? 1 : 0,
      repo.parent?.full_name || null,
      repo.private ? 1 : 0,
      repo.pushed_at || null,
      repo.updated_at || null,
      collaborationReason || null,
      ctx.host,
    ],
  );
  // Discovery runs as an account: remember it can see this repo, so work on the
  // repo can later pick an account that actually has access.
  if (ctx.account) recordRepoVisibility(db, hostKey(ctx.host, repo.full_name), ctx.account);
}

// ─── Org-id resolution for Phase 3 repos ───────────────────────────

/**
 * For a repo returned by /user/repos, determine the correct org_id.
 * If the repo owner is an Organization, look up or auto-create the org entry.
 * Returns null for user-owned repos.
 */
function resolveOrgId(
  db: SqlJsDatabase,
  repo: { owner?: { login?: string; type?: string } },
): number | null {
  const owner = repo.owner;
  if (!owner || owner.type !== 'Organization' || !owner.login) return null;

  // Look up existing org
  const stmt = db.prepare('SELECT id FROM github_orgs WHERE login = ?');
  stmt.bind([owner.login]);
  const found = stmt.step();
  if (found) {
    const row = stmt.getAsObject() as { id: number };
    stmt.free();
    return row.id;
  }
  stmt.free();

  // Auto-create the org (e.g. user has repo-level access but isn't a listed member)
  return upsertOrg(db, { login: owner.login });
}

// ─── Main discovery loop ───────────────────────────────────────────

export async function runDiscovery(
  db: SqlJsDatabase,
  accessToken: string,
  onProgress?: (progress: DiscoveryProgress) => void,
  pat?: string | null,
  userLogin?: string | null,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryState> {
  const state: DiscoveryState = {
    callsSinceLastPause: 0,
    aborted: false,
    lastRateLimit: null,
  };

  const progress: DiscoveryProgress = {
    phase: 'orgs',
    orgsFound: 0,
    reposFound: 0,
  };

  try {
    // ── Phase 1: Organizations ──────────────────────────────────────
    logger.debug('[Discovery] Starting — fetching organizations…');
    onProgress?.({ ...progress });

    const orgs = await fetchAllPages<{ login: string; description?: string | null }>(
      accessToken,
      `${currentApiBase()}/user/orgs?per_page=${PER_PAGE}`,
      state,
    );

    progress.orgsFound = orgs.length;
    logger.debug(`[Discovery] Found ${orgs.length} organization(s)`);
    onProgress?.({ ...progress });

    // Store orgs and map login → DB id
    const orgIdMap = new Map<string, number>();
    for (const org of orgs) {
      const dbId = upsertOrg(db, org);
      orgIdMap.set(org.login, dbId);
    }
    saveDatabase();

    // ── Phase 1.5: PAT org discovery (orgs blocked from OAuth) ──────
    // Fetch the PAT org list right after OAuth so we can include any newly
    // discovered orgs in the Phase 2 repo scan rather than deferring to Phase 5.
    const oauthOrgLogins = new Set(orgs.map((o) => o.login.toLowerCase()));
    let patOnlyOrgs: { login: string; description?: string | null }[] = [];
    if (!state.aborted && pat) {
      logger.debug('[Discovery] Checking for orgs visible only via PAT…');
      try {
        const patOrgs = await fetchAllPages<{ login: string; description?: string | null }>(
          pat,
          `${currentApiBase()}/user/orgs?per_page=${PER_PAGE}`,
          state,
        );
        patOnlyOrgs = patOrgs.filter((o) => !oauthOrgLogins.has(o.login.toLowerCase()));
        if (patOnlyOrgs.length > 0) {
          logger.debug(
            `[Discovery] Found ${patOnlyOrgs.length} org(s) only visible via PAT: ${patOnlyOrgs.map((o) => o.login).join(', ')}`,
          );
          for (const org of patOnlyOrgs) {
            const dbId = upsertOrg(db, org);
            orgIdMap.set(org.login, dbId);
          }
          progress.orgsFound += patOnlyOrgs.length;
          onProgress?.({ ...progress });
          saveDatabase();
        } else {
          logger.debug('[Discovery] No additional orgs found via PAT');
        }
      } catch (err) {
        logger.warn('[Discovery] PAT org check failed (non-fatal):', err);
      }
    }

    // ── Phase 2: Repos per org (skip disabled orgs) ─────────────────
    progress.phase = 'repos';
    // Disabled by the user, or too large (> MAX_ORG_REPOS) and not yet approved
    const disabledOrgs = new Set(
      listOrgs(db).orgs.filter((o) => !o.discoveryEnabled || (o.largeOrg && !o.largeOrgApproved)).map((o) => o.login),
    );

    for (const org of orgs) {
      if (state.aborted) break;

      if (disabledOrgs.has(org.login)) {
        logger.debug(`[Discovery] Skipping disabled org: ${org.login}`);
        continue;
      }

      progress.currentOrg = org.login;
      logger.debug(`[Discovery] Fetching repos for org: ${org.login}`);
      onProgress?.({ ...progress });

      const repos = await fetchOrgRepos(db, accessToken, org.login, state);
      if (!repos) {
        disabledOrgs.add(org.login);
        continue;
      }

      const orgDbId = orgIdMap.get(org.login)!;
      for (const repo of repos) {
        upsertRepo(db, repo, orgDbId);
      }

      progress.reposFound += repos.length;
      logger.debug(`[Discovery]   ${org.login}: ${repos.length} repos (total: ${progress.reposFound})`);
      onProgress?.({ ...progress });

      saveDatabase();
    }

    // Scan PAT-only orgs (OAuth was blocked) with the PAT token
    for (const org of patOnlyOrgs) {
      if (state.aborted) break;

      if (disabledOrgs.has(org.login)) {
        logger.debug(`[Discovery] Skipping disabled PAT-only org: ${org.login}`);
        continue;
      }

      progress.currentOrg = org.login;
      logger.debug(`[Discovery] Fetching repos for PAT-only org: ${org.login}`);
      onProgress?.({ ...progress });

      try {
        const repos = await fetchOrgRepos(db, pat!, org.login, state);
        if (!repos) {
          disabledOrgs.add(org.login);
          continue;
        }

        const orgDbId = orgIdMap.get(org.login)!;
        for (const repo of repos) {
          upsertRepo(db, repo, orgDbId);
        }

        progress.reposFound += repos.length;
        logger.debug(`[Discovery]   ${org.login} (PAT): ${repos.length} repos (total: ${progress.reposFound})`);
        onProgress?.({ ...progress });
        saveDatabase();
      } catch (err) {
        logger.warn(`[Discovery] Skipping PAT-only org ${org.login} — ${err instanceof Error ? err.message : err}`);
      }
    }

    progress.currentOrg = undefined;

    // ── Phase 3: User-owned + collaborator + org-member repos
    if (!state.aborted) {
      logger.debug('[Discovery] Fetching personal + collaborator + org-member repos…');
      progress.phase = 'user-repos';
      onProgress?.({ ...progress });

      const directRepos = await fetchAllPages<GitHubRepo>(
        accessToken,
        `${currentApiBase()}/user/repos?affiliation=owner,collaborator,organization_member&per_page=${PER_PAGE}`,
        state,
      );

      // Resolve collaboration reasons for repos where the user is not the owner
      let collabReasons: Map<string, string> | null = null;
      if (userLogin && !state.aborted) {
        const externalRepos = directRepos.filter((r) => {
          const ownerLogin = r.owner?.login;
          if (!ownerLogin) return false;
          if (disabledOrgs.has(ownerLogin)) return false;
          if (ownerLogin.toLowerCase() === userLogin.toLowerCase()) return false;
          if (r.owner?.type === 'Organization') return false;
          return true;
        });

        if (externalRepos.length > 0) {
          logger.debug(`[Discovery] Resolving collaboration reasons for ${externalRepos.length} external repos…`);
          collabReasons = await resolveCollaborationReasons(db, accessToken, userLogin, externalRepos, state);
        }
      }

      let skippedDisabledOrg = 0;
      for (const repo of directRepos) {
        const ownerLogin = repo.owner?.login;
        if (ownerLogin && disabledOrgs.has(ownerLogin)) {
          skippedDisabledOrg++;
          continue;
        }
        const orgId = resolveOrgId(db, repo);
        let reason: string | null = null;
        if (userLogin) {
          reason = collabReasons?.get(repo.full_name) ?? null;
          if (!reason) {
            if (ownerLogin && ownerLogin.toLowerCase() === userLogin.toLowerCase()) {
              reason = 'owner';
            } else if (orgId !== null) {
              reason = 'org_member';
            }
          }
        }
        upsertRepo(db, repo, orgId, reason);
      }

      if (skippedDisabledOrg > 0) {
        logger.debug(`[Discovery] Skipped ${skippedDisabledOrg} repos from disabled orgs in user-repos phase`);
      }

      progress.reposFound += directRepos.length - skippedDisabledOrg;
      logger.debug(`[Discovery] Personal + collaborator + org-member repos: ${directRepos.length} (total: ${progress.reposFound})`);
      onProgress?.({ ...progress });

      saveDatabase();
    }

    // ── Phase 4: Starred repos ────────────────────────────────────────
    if (!state.aborted && !opts.skipStarred) {
      await fetchStarredRepos(db, accessToken, state, progress, onProgress);
      await fetchWatchedReposSafe(db, accessToken, state);
    }

    // ── Phase 5: PAT supplemental pass (repos OAuth can't see) ──────
    if (!state.aborted && pat) {
      try {
        // Tell runPatDiscovery which orgs were already scanned in Phase 2
        // (both OAuth orgs and the PAT-only orgs we just scanned above) so
        // it skips them and only handles any remaining gaps.
        const allScannedOrgLogins = new Set([
          ...orgs.map((o) => o.login.toLowerCase()),
          ...patOnlyOrgs.map((o) => o.login.toLowerCase()),
        ]);
        await runPatDiscovery(db, pat, state, progress, onProgress, userLogin, allScannedOrgLogins);
      } catch (err) {
        logger.error('[Discovery] PAT supplemental pass failed (non-fatal):', err);
      }
    }

    progress.phase = 'done';
    onProgress?.({ ...progress });
    logger.debug(`[Discovery] Complete — ${progress.orgsFound} orgs, ${progress.reposFound} repos`);
  } catch (err) {
    if (!state.aborted) {
      logger.error('[Discovery] Error:', err);
    }
  }

  return state;
}

// ─── Lightweight refresh (orgs + collaborator repos only) ──────────

export async function runLightweightRefresh(
  db: SqlJsDatabase,
  accessToken: string,
  onProgress?: (progress: DiscoveryProgress) => void,
  pat?: string | null,
  userLogin?: string | null,
  opts: DiscoveryOptions = {},
): Promise<void> {
  const state: DiscoveryState = {
    callsSinceLastPause: 0,
    aborted: false,
    lastRateLimit: null,
  };

  const progress: DiscoveryProgress = {
    phase: 'orgs',
    orgsFound: 0,
    reposFound: 0,
  };

  try {
    // Fetch current orgs
    logger.debug('[LightRefresh] Checking for new organizations…');
    onProgress?.({ ...progress });

    const orgs = await fetchAllPages<{ login: string; description?: string | null }>(
      accessToken,
      `${currentApiBase()}/user/orgs?per_page=${PER_PAGE}`,
      state,
    );

    progress.orgsFound = orgs.length;
    for (const org of orgs) {
      upsertOrg(db, org);
    }
    saveDatabase();
    logger.debug(`[LightRefresh] ${orgs.length} org(s) synced`);
    onProgress?.({ ...progress });

    // Disabled by the user, or too large (> MAX_ORG_REPOS) and not yet approved
    const disabledOrgs = new Set(
      listOrgs(db).orgs.filter((o) => !o.discoveryEnabled || (o.largeOrg && !o.largeOrgApproved)).map((o) => o.login),
    );

    // Fetch personal + collaborator + org-member repos
    // Sort by updated desc so we can stop early once we've seen everything
    // newer than the last refresh — avoiding hundreds of pages of stale data.
    logger.debug('[LightRefresh] Updating personal + collaborator + org-member repos…');
    progress.phase = 'user-repos';
    onProgress?.({ ...progress });

    const lastRefreshRaw = getConfigValue(db, 'last_user_repos_refresh');
    // Subtract 5 minutes buffer to handle clock skew / in-flight updates
    const sinceDate = lastRefreshRaw
      ? new Date(new Date(lastRefreshRaw).getTime() - 5 * 60 * 1000)
      : null;

    const directRepos = await fetchPagesSortedSince(
      accessToken,
      `${currentApiBase()}/user/repos?affiliation=owner,collaborator,organization_member&per_page=${PER_PAGE}&sort=updated&direction=desc`,
      state,
      sinceDate,
    );

    // Resolve collaboration reasons for external repos
    let collabReasons: Map<string, string> | null = null;
    if (userLogin && !state.aborted) {
      const externalRepos = directRepos.filter((r) => {
        const ownerLogin = r.owner?.login;
        if (!ownerLogin) return false;
        if (disabledOrgs.has(ownerLogin)) return false;
        if (ownerLogin.toLowerCase() === userLogin.toLowerCase()) return false;
        if (r.owner?.type === 'Organization') return false;
        return true;
      });

      if (externalRepos.length > 0) {
        logger.debug(`[LightRefresh] Resolving collaboration reasons for ${externalRepos.length} external repos…`);
        collabReasons = await resolveCollaborationReasons(db, accessToken, userLogin, externalRepos, state);
      }
    }

    let skippedDisabledOrg = 0;
    for (const repo of directRepos) {
      const ownerLogin = repo.owner?.login;
      if (ownerLogin && disabledOrgs.has(ownerLogin)) {
        skippedDisabledOrg++;
        continue;
      }
      const orgId = resolveOrgId(db, repo);
      let reason: string | null = null;
      if (userLogin) {
        reason = collabReasons?.get(repo.full_name) ?? null;
        if (!reason) {
          if (ownerLogin && ownerLogin.toLowerCase() === userLogin.toLowerCase()) {
            reason = 'owner';
          } else if (orgId !== null) {
            reason = 'org_member';
          }
        }
      }
      upsertRepo(db, repo, orgId, reason);
    }

    if (skippedDisabledOrg > 0) {
      logger.debug(`[LightRefresh] Skipped ${skippedDisabledOrg} repos from disabled orgs in user-repos phase`);
    }

    progress.reposFound = directRepos.length - skippedDisabledOrg;
    setConfigValue(db, 'last_user_repos_refresh', new Date().toISOString());
    saveDatabase();
    logger.debug(`[LightRefresh] ${directRepos.length} personal + collaborator + org-member repo(s) synced`);

    // Fetch starred repos
    if (!opts.skipStarred) {
      await fetchStarredRepos(db, accessToken, state, progress, onProgress);
      await fetchWatchedReposSafe(db, accessToken, state);
    }

    // PAT supplemental pass
    if (pat) {
      try {
        const oauthOrgLogins = new Set(orgs.map((o) => o.login.toLowerCase()));
        await runPatDiscovery(db, pat, state, progress, onProgress, userLogin, oauthOrgLogins);
      } catch (err) {
        logger.error('[LightRefresh] PAT supplemental pass failed (non-fatal):', err);
      }
    }

    progress.phase = 'done';
    onProgress?.({ ...progress });
  } catch (err) {
    logger.error('[LightRefresh] Error:', err);
  }
}

// ─── Fetch starred repos ────────────────────────────────────────────

/**
 * Fetches repos the authenticated user has starred and marks them with
 * starred = 1 in the DB. Resets all existing star flags first so that
 * un-starred repos are cleared. Repos from orgs not previously indexed
 * are stored with org_id = null (no auto-create of foreign orgs).
 */
export async function fetchStarredRepos(
  db: SqlJsDatabase,
  accessToken: string,
  state: DiscoveryState,
  progress: DiscoveryProgress,
  onProgress?: (progress: DiscoveryProgress) => void,
): Promise<void> {
  logger.debug('[Discovery] Fetching starred repos…');
  progress.phase = 'starred';
  onProgress?.({ ...progress });

  // Clear stale star flags before re-fetching
  db.run('UPDATE github_repos SET starred = 0');

  const starred = await fetchAllPages<GitHubRepo>(
    accessToken,
    `${currentApiBase()}/user/starred?per_page=${PER_PAGE}`,
    state,
  );

  for (const repo of starred) {
    // Only link to an org if it's already indexed — don't auto-create foreign orgs
    const orgId = lookupExistingOrgId(db, repo);
    upsertRepo(db, repo, orgId);
    db.run('UPDATE github_repos SET starred = 1 WHERE full_name = ?', [repo.full_name]);
  }

  progress.reposFound += starred.length;
  logger.debug(`[Discovery] Starred repos: ${starred.length}`);
  onProgress?.({ ...progress });
  saveDatabase();
}

/** Watching is a nice-to-have role: a failure here must not abort discovery. */
async function fetchWatchedReposSafe(db: SqlJsDatabase, accessToken: string, state: DiscoveryState): Promise<void> {
  try {
    await fetchWatchedRepos(db, accessToken, state);
  } catch (err) {
    logger.warn('[Discovery] Watched repos failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

// ─── Fetch watched repos ────────────────────────────────────────────

/**
 * Marks repos the authenticated user watches (GET /user/subscriptions) with
 * watching = 1. Note GitHub auto-subscribes you to repos you can push to, so
 * "watching" overlaps heavily with owned/collaborator repos. Repos in unapproved
 * large orgs are not stored.
 */
export async function fetchWatchedRepos(
  db: SqlJsDatabase,
  accessToken: string,
  state: DiscoveryState,
): Promise<number> {
  logger.debug('[Discovery] Fetching watched repos…');
  const watched = await fetchAllPages<GitHubRepo>(
    accessToken,
    `${currentApiBase()}/user/subscriptions?per_page=${PER_PAGE}`,
    state,
  );
  if (state.aborted) return 0;

  const blocked = new Set(listBlockedLargeOrgs(db).map((l) => l.toLowerCase()));
  db.run('UPDATE github_repos SET watching = 0');
  let stored = 0;
  for (const repo of watched) {
    if (repo.owner?.login && blocked.has(repo.owner.login.toLowerCase())) continue;
    upsertRepo(db, repo, lookupExistingOrgId(db, repo));
    db.run('UPDATE github_repos SET watching = 1 WHERE full_name = ?', [repo.full_name]);
    stored++;
  }
  saveDatabase();
  logger.debug(`[Discovery] Watched repos: ${stored}`);
  return stored;
}

/**
 * Like resolveOrgId but never auto-creates an org entry.
 * Returns the existing org_id if the owning org is already indexed, else null.
 */
function lookupExistingOrgId(
  db: SqlJsDatabase,
  repo: { owner?: { login?: string; type?: string } },
): number | null {
  const owner = repo.owner;
  if (!owner || owner.type !== 'Organization' || !owner.login) return null;
  const stmt = db.prepare('SELECT id FROM github_orgs WHERE login = ?');
  stmt.bind([owner.login]);
  const found = stmt.step();
  const row = found ? (stmt.getAsObject() as { id: number }) : null;
  stmt.free();
  return row?.id ?? null;
}

// ─── Collaboration reason detection ────────────────────────────────

interface GitHubSearchResult {
  total_count: number;
  items: Array<{ pull_request?: unknown }>;
}

/**
 * Determines how the authenticated user collaborates with a repo.
 * Returns a comma-separated string of reasons, e.g. "issue", "pr", "issue,pr",
 * or "collaborator" as fallback when no issues/PRs are found.
 *
 * Uses the GitHub Search API: GET /search/issues?q=author:{user}+repo:{full_name}
 */
export async function resolveCollaborationReason(
  accessToken: string,
  userLogin: string,
  repoFullName: string,
  state: DiscoveryState,
): Promise<string> {
  try {
    const q = encodeURIComponent(`author:${userLogin} repo:${repoFullName}`);
    const { data } = await githubGet<GitHubSearchResult>(
      accessToken,
      `${currentApiBase()}/search/issues?q=${q}&per_page=30`,
      state,
    );

    if (data.total_count === 0) {
      return 'collaborator';
    }

    const hasIssue = data.items.some((item) => !item.pull_request);
    const hasPR = data.items.some((item) => !!item.pull_request);

    const reasons: string[] = [];
    if (hasPR) reasons.push('pr');
    if (hasIssue) reasons.push('issue');

    return reasons.length > 0 ? reasons.join(',') : 'collaborator';
  } catch {
    // Search API failure is non-fatal — fall back to generic reason
    return 'collaborator';
  }
}

/**
 * For a list of repos, determine collaboration reasons for repos where the
 * user is not the owner and the repo is not part of one of their orgs.
 *
 * Repos owned by the user get "owner", org-member repos get "org_member",
 * and external repos get checked via the Search API.
 */
export async function resolveCollaborationReasons(
  db: SqlJsDatabase,
  accessToken: string,
  userLogin: string,
  repos: GitHubRepo[],
  state: DiscoveryState,
): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  const memberOrgLogins = new Set(
    listOrgs(db).orgs.map((o) => o.login.toLowerCase()),
  );

  // Load already-known collaboration reasons from the DB to avoid redundant Search API calls
  const knownReasons = new Map<string, string>();
  try {
    const stmt = db.prepare('SELECT full_name, collaboration_reason FROM github_repos WHERE collaboration_reason IS NOT NULL');
    while (stmt.step()) {
      const row = stmt.getAsObject() as { full_name: string; collaboration_reason: string };
      knownReasons.set(row.full_name, row.collaboration_reason);
    }
    stmt.free();
  } catch {
    // Non-fatal: if the query fails we just skip the optimization
  }

  for (const repo of repos) {
    if (state.aborted) break;

    const ownerLogin = repo.owner?.login;

    if (ownerLogin && ownerLogin.toLowerCase() === userLogin.toLowerCase()) {
      reasons.set(repo.full_name, 'owner');
    } else if (
      ownerLogin &&
      repo.owner?.type === 'Organization' &&
      memberOrgLogins.has(ownerLogin.toLowerCase())
    ) {
      reasons.set(repo.full_name, 'org_member');
    } else if (knownReasons.has(repo.full_name)) {
      // Already resolved in a previous run — reuse the stored value
      reasons.set(repo.full_name, knownReasons.get(repo.full_name)!);
    } else {
      const reason = await resolveCollaborationReason(
        accessToken,
        userLogin,
        repo.full_name,
        state,
      );
      reasons.set(repo.full_name, reason);
    }
  }

  return reasons;
}

export function getLastOrgIndexedAt(db: SqlJsDatabase): string | null {
  const stmt = db.prepare("SELECT MAX(indexed_at) AS last_indexed FROM github_orgs");
  stmt.step();
  const row = stmt.getAsObject() as { last_indexed: string | null };
  stmt.free();
  return row.last_indexed || null;
}

export function abortDiscovery(state: DiscoveryState): void {
  state.aborted = true;
}

// ─── Standalone PAT discovery pass ─────────────────────────────────

/**
 * Smart PAT supplemental pass — only fetches what OAuth couldn't see:
 *
 * 1. PAT → /user/orgs: find orgs not in DB or with 0 repos (OAuth got 403)
 * 2. PAT → /orgs/{org}/repos for each new/empty org: targeted calls
 * 3. PAT → /user/repos?affiliation=collaborator: direct collaborator repos only
 *
 * This avoids re-paginating through thousands of repos already indexed via OAuth.
 */
export async function runPatDiscovery(
  db: SqlJsDatabase,
  pat: string,
  state?: DiscoveryState,
  progress?: DiscoveryProgress,
  onProgress?: (progress: DiscoveryProgress) => void,
  userLogin?: string | null,
  oauthOrgLogins?: ReadonlySet<string>,
): Promise<void> {
  const st: DiscoveryState = state ?? {
    callsSinceLastPause: 0,
    aborted: false,
    lastRateLimit: null,
  };

  const prog: DiscoveryProgress = progress ?? {
    phase: 'pat-repos',
    orgsFound: 0,
    reposFound: 0,
  };

  logger.debug('[PAT Discovery] Starting smart PAT pass…');
  prog.phase = 'pat-repos';
  onProgress?.({ ...prog });

  // ── Step 1: Discover orgs via PAT ──────────────────────────────
  const patOrgs = await fetchAllPages<{ login: string; description?: string | null }>(
    pat,
    `${currentApiBase()}/user/orgs?per_page=${PER_PAGE}`,
    st,
  );

  // Build a set of orgs already fully indexed (have repos in DB)
  const { orgs: existingOrgs } = listOrgs(db);
  const indexedOrgLogins = new Set(
    existingOrgs.filter((o) => o.repoCount > 0).map((o) => o.login.toLowerCase()),
  );

  // Find orgs that are new, had 0 repos (OAuth was blocked), or are visible
  // to the PAT but were NOT visible to OAuth (OAuth app blocked by org policy).
  const orgsToScan = patOrgs.filter((o) => {
    const login = o.login.toLowerCase();
    if (!indexedOrgLogins.has(login)) return true; // new or empty
    if (oauthOrgLogins && !oauthOrgLogins.has(login)) return true; // PAT sees it, OAuth didn't
    return false;
  });

  if (oauthOrgLogins) {
    const oauthBlocked = patOrgs.filter(
      (o) => !oauthOrgLogins.has(o.login.toLowerCase()),
    );
    if (oauthBlocked.length > 0) {
      logger.debug(
        `[PAT Discovery] Orgs blocked from OAuth (will rescan via PAT): ${oauthBlocked.map((o) => o.login).join(', ')}`,
      );
    }
  }

  logger.debug(
    `[PAT Discovery] ${patOrgs.length} org(s) via PAT, ` +
      `${existingOrgs.length} already indexed with repos, ` +
      `${orgsToScan.length} new/empty/OAuth-blocked org(s) to scan`,
  );

  // ── Step 2: Fetch repos for new/empty orgs ────────────────────
  for (const org of orgsToScan) {
    if (st.aborted) break;

    const orgDbId = upsertOrg(db, org);
    prog.currentOrg = org.login;
    onProgress?.({ ...prog });

    logger.debug(`[PAT Discovery] Fetching repos for org: ${org.login}`);
    try {
      const repos = await fetchOrgRepos(db, pat, org.login, st);
      if (!repos) continue;

      for (const repo of repos) {
        upsertRepo(db, repo, orgDbId);
      }

      prog.reposFound += repos.length;
      prog.orgsFound = (prog.orgsFound || 0) + 1;
      logger.debug(`[PAT Discovery]   ${org.login}: ${repos.length} repos`);
      onProgress?.({ ...prog });
      saveDatabase();
    } catch (err) {
      logger.warn(`[PAT Discovery] Skipping org ${org.login} — ${err instanceof Error ? err.message : err}`);
    }
  }
  prog.currentOrg = undefined;

  // ── Step 3: Fetch direct collaborator repos via PAT ───────────
  // affiliation=collaborator returns only repos where user is an
  // outside collaborator — much smaller than the full repo list.
  if (!st.aborted) {
    logger.debug('[PAT Discovery] Fetching direct collaborator repos…');
    onProgress?.({ ...prog });

    const collabRepos = await fetchAllPages<GitHubRepo>(
      pat,
      `${currentApiBase()}/user/repos?affiliation=collaborator&per_page=${PER_PAGE}`,
      st,
    );

    // Resolve collaboration reasons for PAT collaborator repos
    let collabReasons: Map<string, string> | null = null;
    if (userLogin && !st.aborted && collabRepos.length > 0) {
      logger.debug(`[PAT Discovery] Resolving collaboration reasons for ${collabRepos.length} collaborator repos…`);
      collabReasons = await resolveCollaborationReasons(db, pat, userLogin, collabRepos, st);
    }

    const blockedOrgs = new Set(listBlockedLargeOrgs(db).map((l) => l.toLowerCase()));
    for (const repo of collabRepos) {
      if (repo.owner?.login && blockedOrgs.has(repo.owner.login.toLowerCase())) continue;
      const orgId = resolveOrgId(db, repo);
      const reason = collabReasons?.get(repo.full_name) ?? 'collaborator';
      upsertRepo(db, repo, orgId, reason);
    }

    prog.reposFound += collabRepos.length;
    logger.debug(`[PAT Discovery] Collaborator repos: ${collabRepos.length}`);
    onProgress?.({ ...prog });
    saveDatabase();
  }

  logger.debug(`[PAT Discovery] Complete — ${prog.orgsFound} new orgs, ${prog.reposFound} repos`);
}
