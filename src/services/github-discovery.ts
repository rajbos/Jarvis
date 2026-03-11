import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../storage/database';

const GITHUB_API_BASE = 'https://api.github.com';
const PER_PAGE = 100;
const CALLS_PER_BATCH = 500;
const BATCH_PAUSE_MS = 10_000; // 10 seconds between batches
const LOW_RATE_LIMIT_THRESHOLD = 50;

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  reset: number; // Unix timestamp (seconds)
}

export interface DiscoveryState {
  callsSinceLastPause: number;
  aborted: boolean;
  lastRateLimit: RateLimitInfo | null;
}

export interface DiscoveryProgress {
  phase: 'orgs' | 'repos' | 'user-repos' | 'starred' | 'pat-repos' | 'done';
  orgsFound: number;
  reposFound: number;
  currentOrg?: string;
}

export interface OrgInfo {
  id: number;
  login: string;
  name: string | null;
  discoveryEnabled: boolean;
  indexedAt: string | null;
  repoCount: number;
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

function parseRateLimit(headers: Headers): RateLimitInfo {
  return {
    remaining: parseInt(headers.get('x-ratelimit-remaining') || '5000', 10),
    limit: parseInt(headers.get('x-ratelimit-limit') || '5000', 10),
    reset: parseInt(headers.get('x-ratelimit-reset') || '0', 10),
  };
}

function parseLinkNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pause when we've consumed CALLS_PER_BATCH API calls, or when the
 * remaining rate-limit budget drops below the safety threshold.
 */
async function rateLimitAwarePause(state: DiscoveryState): Promise<void> {
  if (state.aborted) return;

  state.callsSinceLastPause++;

  if (state.callsSinceLastPause >= CALLS_PER_BATCH) {
    console.log(`[Discovery] Pausing after ${state.callsSinceLastPause} API calls (batch cooldown)…`);
    await sleep(BATCH_PAUSE_MS);
    state.callsSinceLastPause = 0;
  }

  if (state.lastRateLimit && state.lastRateLimit.remaining < LOW_RATE_LIMIT_THRESHOLD) {
    const waitMs = state.lastRateLimit.reset * 1000 - Date.now() + 1000;
    if (waitMs > 0) {
      console.log(
        `[Discovery] Rate limit low (${state.lastRateLimit.remaining} remaining). ` +
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
): Promise<{ data: T; nextUrl: string | null }> {
  await rateLimitAwarePause(state);

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

  state.lastRateLimit = parseRateLimit(response.headers);
  console.log(
    `[Discovery] ${url.replace(GITHUB_API_BASE, '')} — ` +
      `rate limit: ${state.lastRateLimit.remaining}/${state.lastRateLimit.limit}`,
  );

  // Rate-limit exceeded — wait until reset, then retry once
  if (response.status === 403 && state.lastRateLimit.remaining === 0) {
    const waitMs = state.lastRateLimit.reset * 1000 - Date.now() + 1000;
    if (waitMs > 0) {
      console.log(`[Discovery] Rate limit exceeded. Waiting ${Math.ceil(waitMs / 1000)}s…`);
      await sleep(waitMs);
    }
    state.callsSinceLastPause = 0;
    return githubGet(accessToken, url, state);
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} for ${url}`);
  }

  const data = (await response.json()) as T;
  const nextUrl = parseLinkNext(response.headers.get('link'));
  return { data, nextUrl };
}

async function fetchAllPages<T>(
  accessToken: string,
  initialUrl: string,
  state: DiscoveryState,
): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = initialUrl;

  while (url && !state.aborted) {
    const result: { data: T[]; nextUrl: string | null } = await githubGet<T[]>(accessToken, url, state);
    results.push(...result.data);
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
    `INSERT INTO github_orgs (login, name, indexed_at, metadata)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(login) DO UPDATE SET
       name = excluded.name,
       indexed_at = excluded.indexed_at,
       metadata = excluded.metadata`,
    [
      org.login,
      org.name || null,
      org.description ? JSON.stringify({ description: org.description }) : null,
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
            (SELECT COUNT(*) FROM github_repos r WHERE r.org_id = o.id) AS repo_count
     FROM github_orgs o
     ORDER BY o.login COLLATE NOCASE`,
  );
  while (stmt.step()) {
    const row = stmt.getAsObject() as { id: number; login: string; name: string | null; discovery_enabled: number; indexed_at: string | null; repo_count: number };
    orgs.push({
      id: row.id,
      login: row.login,
      name: row.name,
      discoveryEnabled: row.discovery_enabled !== 0,
      indexedAt: row.indexed_at,
      repoCount: row.repo_count,
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

export function setOrgDiscoveryEnabled(db: SqlJsDatabase, orgLogin: string, enabled: boolean): void {
  db.run('UPDATE github_orgs SET discovery_enabled = ? WHERE login = ?', [enabled ? 1 : 0, orgLogin]);
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
): void {
  db.run(
    `INSERT INTO github_repos
       (org_id, full_name, name, description, default_branch, language,
        archived, fork, parent_full_name, private,
        last_pushed_at, last_updated_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
       indexed_at      = excluded.indexed_at`,
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
    ],
  );
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
    console.log('[Discovery] Starting — fetching organizations…');
    onProgress?.({ ...progress });

    const orgs = await fetchAllPages<{ login: string; description?: string | null }>(
      accessToken,
      `${GITHUB_API_BASE}/user/orgs?per_page=${PER_PAGE}`,
      state,
    );

    progress.orgsFound = orgs.length;
    console.log(`[Discovery] Found ${orgs.length} organization(s)`);
    onProgress?.({ ...progress });

    // Store orgs and map login → DB id
    const orgIdMap = new Map<string, number>();
    for (const org of orgs) {
      const dbId = upsertOrg(db, org);
      orgIdMap.set(org.login, dbId);
    }
    saveDatabase();

    // ── Phase 2: Repos per org (skip disabled orgs) ─────────────────
    progress.phase = 'repos';
    const disabledOrgs = new Set(
      listOrgs(db).orgs.filter((o) => !o.discoveryEnabled).map((o) => o.login),
    );

    for (const org of orgs) {
      if (state.aborted) break;

      if (disabledOrgs.has(org.login)) {
        console.log(`[Discovery] Skipping disabled org: ${org.login}`);
        continue;
      }

      progress.currentOrg = org.login;
      console.log(`[Discovery] Fetching repos for org: ${org.login}`);
      onProgress?.({ ...progress });

      const repos = await fetchAllPages<GitHubRepo>(
        accessToken,
        `${GITHUB_API_BASE}/orgs/${encodeURIComponent(org.login)}/repos?type=all&per_page=${PER_PAGE}`,
        state,
      );

      const orgDbId = orgIdMap.get(org.login)!;
      for (const repo of repos) {
        upsertRepo(db, repo, orgDbId);
      }

      progress.reposFound += repos.length;
      console.log(`[Discovery]   ${org.login}: ${repos.length} repos (total: ${progress.reposFound})`);
      onProgress?.({ ...progress });

      saveDatabase();
    }
    progress.currentOrg = undefined;

    // ── Phase 3: User-owned + collaborator + org-member repos
    if (!state.aborted) {
      console.log('[Discovery] Fetching personal + collaborator + org-member repos…');
      progress.phase = 'user-repos';
      onProgress?.({ ...progress });

      const directRepos = await fetchAllPages<GitHubRepo>(
        accessToken,
        `${GITHUB_API_BASE}/user/repos?affiliation=owner,collaborator,organization_member&per_page=${PER_PAGE}`,
        state,
      );

      let skippedDisabledOrg = 0;
      for (const repo of directRepos) {
        const ownerLogin = repo.owner?.login;
        if (ownerLogin && disabledOrgs.has(ownerLogin)) {
          skippedDisabledOrg++;
          continue;
        }
        const orgId = resolveOrgId(db, repo);
        upsertRepo(db, repo, orgId);
      }

      if (skippedDisabledOrg > 0) {
        console.log(`[Discovery] Skipped ${skippedDisabledOrg} repos from disabled orgs in user-repos phase`);
      }

      progress.reposFound += directRepos.length - skippedDisabledOrg;
      console.log(`[Discovery] Personal + collaborator + org-member repos: ${directRepos.length} (total: ${progress.reposFound})`);
      onProgress?.({ ...progress });

      saveDatabase();
    }

    // ── Phase 4: Starred repos ────────────────────────────────────────
    if (!state.aborted) {
      await fetchStarredRepos(db, accessToken, state, progress, onProgress);
    }

    // ── Phase 5: PAT supplemental pass (repos OAuth can't see) ──────
    if (!state.aborted && pat) {
      try {
        await runPatDiscovery(db, pat, state, progress, onProgress);
      } catch (err) {
        console.error('[Discovery] PAT supplemental pass failed (non-fatal):', err);
      }
    }

    progress.phase = 'done';
    onProgress?.({ ...progress });
    console.log(`[Discovery] Complete — ${progress.orgsFound} orgs, ${progress.reposFound} repos`);
  } catch (err) {
    if (!state.aborted) {
      console.error('[Discovery] Error:', err);
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
    console.log('[LightRefresh] Checking for new organizations…');
    onProgress?.({ ...progress });

    const orgs = await fetchAllPages<{ login: string; description?: string | null }>(
      accessToken,
      `${GITHUB_API_BASE}/user/orgs?per_page=${PER_PAGE}`,
      state,
    );

    progress.orgsFound = orgs.length;
    for (const org of orgs) {
      upsertOrg(db, org);
    }
    saveDatabase();
    console.log(`[LightRefresh] ${orgs.length} org(s) synced`);
    onProgress?.({ ...progress });

    const disabledOrgs = new Set(
      listOrgs(db).orgs.filter((o) => !o.discoveryEnabled).map((o) => o.login),
    );

    // Fetch personal + collaborator + org-member repos
    console.log('[LightRefresh] Updating personal + collaborator + org-member repos…');
    progress.phase = 'user-repos';
    onProgress?.({ ...progress });

    const directRepos = await fetchAllPages<GitHubRepo>(
      accessToken,
      `${GITHUB_API_BASE}/user/repos?affiliation=owner,collaborator,organization_member&per_page=${PER_PAGE}`,
      state,
    );

    let skippedDisabledOrg = 0;
    for (const repo of directRepos) {
      const ownerLogin = repo.owner?.login;
      if (ownerLogin && disabledOrgs.has(ownerLogin)) {
        skippedDisabledOrg++;
        continue;
      }
      const orgId = resolveOrgId(db, repo);
      upsertRepo(db, repo, orgId);
    }

    if (skippedDisabledOrg > 0) {
      console.log(`[LightRefresh] Skipped ${skippedDisabledOrg} repos from disabled orgs in user-repos phase`);
    }

    progress.reposFound = directRepos.length - skippedDisabledOrg;
    saveDatabase();
    console.log(`[LightRefresh] ${directRepos.length} personal + collaborator + org-member repo(s) synced`);

    // Fetch starred repos
    await fetchStarredRepos(db, accessToken, state, progress, onProgress);

    // PAT supplemental pass
    if (pat) {
      try {
        await runPatDiscovery(db, pat, state, progress, onProgress);
      } catch (err) {
        console.error('[LightRefresh] PAT supplemental pass failed (non-fatal):', err);
      }
    }

    progress.phase = 'done';
    onProgress?.({ ...progress });
  } catch (err) {
    console.error('[LightRefresh] Error:', err);
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
  console.log('[Discovery] Fetching starred repos…');
  progress.phase = 'starred';
  onProgress?.({ ...progress });

  // Clear stale star flags before re-fetching
  db.run('UPDATE github_repos SET starred = 0');

  const starred = await fetchAllPages<GitHubRepo>(
    accessToken,
    `${GITHUB_API_BASE}/user/starred?per_page=${PER_PAGE}`,
    state,
  );

  for (const repo of starred) {
    // Only link to an org if it's already indexed — don't auto-create foreign orgs
    const orgId = lookupExistingOrgId(db, repo);
    upsertRepo(db, repo, orgId);
    db.run('UPDATE github_repos SET starred = 1 WHERE full_name = ?', [repo.full_name]);
  }

  progress.reposFound += starred.length;
  console.log(`[Discovery] Starred repos: ${starred.length}`);
  onProgress?.({ ...progress });
  saveDatabase();
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

  console.log('[PAT Discovery] Starting smart PAT pass…');
  prog.phase = 'pat-repos';
  onProgress?.({ ...prog });

  // ── Step 1: Discover orgs via PAT ──────────────────────────────
  const patOrgs = await fetchAllPages<{ login: string; description?: string | null }>(
    pat,
    `${GITHUB_API_BASE}/user/orgs?per_page=${PER_PAGE}`,
    st,
  );

  // Build a set of orgs already fully indexed (have repos in DB)
  const { orgs: existingOrgs } = listOrgs(db);
  const indexedOrgLogins = new Set(
    existingOrgs.filter((o) => o.repoCount > 0).map((o) => o.login.toLowerCase()),
  );

  // Find orgs that are new or had 0 repos (OAuth was blocked)
  const orgsToScan = patOrgs.filter(
    (o) => !indexedOrgLogins.has(o.login.toLowerCase()),
  );

  console.log(
    `[PAT Discovery] ${patOrgs.length} org(s) via PAT, ` +
      `${existingOrgs.length} already indexed with repos, ` +
      `${orgsToScan.length} new/empty org(s) to scan`,
  );

  // ── Step 2: Fetch repos for new/empty orgs ────────────────────
  for (const org of orgsToScan) {
    if (st.aborted) break;

    const orgDbId = upsertOrg(db, org);
    prog.currentOrg = org.login;
    onProgress?.({ ...prog });

    console.log(`[PAT Discovery] Fetching repos for org: ${org.login}`);
    try {
      const repos = await fetchAllPages<GitHubRepo>(
        pat,
        `${GITHUB_API_BASE}/orgs/${encodeURIComponent(org.login)}/repos?type=all&per_page=${PER_PAGE}`,
        st,
      );

      for (const repo of repos) {
        upsertRepo(db, repo, orgDbId);
      }

      prog.reposFound += repos.length;
      prog.orgsFound = (prog.orgsFound || 0) + 1;
      console.log(`[PAT Discovery]   ${org.login}: ${repos.length} repos`);
      onProgress?.({ ...prog });
      saveDatabase();
    } catch (err) {
      console.warn(`[PAT Discovery] Skipping org ${org.login} — ${err instanceof Error ? err.message : err}`);
    }
  }
  prog.currentOrg = undefined;

  // ── Step 3: Fetch direct collaborator repos via PAT ───────────
  // affiliation=collaborator returns only repos where user is an
  // outside collaborator — much smaller than the full repo list.
  if (!st.aborted) {
    console.log('[PAT Discovery] Fetching direct collaborator repos…');
    onProgress?.({ ...prog });

    const collabRepos = await fetchAllPages<GitHubRepo>(
      pat,
      `${GITHUB_API_BASE}/user/repos?affiliation=collaborator&per_page=${PER_PAGE}`,
      st,
    );

    for (const repo of collabRepos) {
      const orgId = resolveOrgId(db, repo);
      upsertRepo(db, repo, orgId);
    }

    prog.reposFound += collabRepos.length;
    console.log(`[PAT Discovery] Collaborator repos: ${collabRepos.length}`);
    onProgress?.({ ...prog });
    saveDatabase();
  }

  console.log(`[PAT Discovery] Complete — ${prog.orgsFound} new orgs, ${prog.reposFound} repos`);
}
