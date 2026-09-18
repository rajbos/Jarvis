// ── GitHub tools for the Jarvis MCP server ────────────────────────────────────
// Every query here reads only what the Electron app has already cached in the
// Jarvis database: discovered GitHub repos, local clones on disk, notifications
// and workflow runs. The MCP server never holds GitHub credentials and never
// calls the GitHub API itself.
import type { Database as SqlJsDatabase } from 'sql.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitHubRepoHit {
  fullName: string;
  description: string | null;
  language: string | null;
  defaultBranch: string | null;
  archived: boolean;
  fork: boolean;
  private: boolean;
  starred: boolean;
  lastPushedAt: string | null;
  htmlUrl: string;
  /** Local clone paths of this repo known to Jarvis (empty if not cloned). */
  localPaths: string[];
}

export interface LocalRepoHit {
  id: number;
  name: string | null;
  localPath: string;
  /** GitHub full name (owner/repo) if the clone is linked to a discovered repo. */
  githubFullName: string | null;
  githubDescription: string | null;
  remotes: Array<{ name: string; url: string }>;
  discoveredAt: string | null;
  lastScanned: string | null;
}

export interface NotificationHit {
  id: string;
  repoFullName: string;
  subjectType: string | null;
  subjectTitle: string | null;
  subjectUrl: string | null;
  actorLogin: string | null;
  reason: string | null;
  unread: boolean;
  updatedAt: string | null;
}

export interface WorkflowRunHit {
  id: string;
  repoFullName: string;
  workflowName: string | null;
  headBranch: string | null;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  runNumber: number | null;
  runStartedAt: string | null;
  htmlUrl: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Split a free-text query into lowercase terms; every term must match (AND). */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Build `(col1 LIKE ? OR col2 LIKE ? ...) AND (...)` for every term so that all
 * terms must appear somewhere across the given columns. Returns the SQL
 * fragment plus the bound parameters in order.
 */
function buildTermFilter(columns: string[], terms: string[]): { sql: string; params: string[] } {
  if (terms.length === 0) return { sql: '1=1', params: [] };
  const clauses: string[] = [];
  const params: string[] = [];
  for (const term of terms) {
    clauses.push(`(${columns.map((c) => `LOWER(COALESCE(${c}, '')) LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < columns.length; i++) params.push(`%${term}%`);
  }
  return { sql: clauses.join(' AND '), params };
}

function readAll<T>(db: SqlJsDatabase, sql: string, params: Array<string | number> = []): T[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows: T[] = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
  } finally {
    stmt.free();
  }
  return rows;
}

/** Map github_repos.id → local clone paths, for the given repo ids. */
function localPathsByRepoId(db: SqlJsDatabase, repoIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (repoIds.length === 0) return map;
  const placeholders = repoIds.map(() => '?').join(',');
  const rows = readAll<{ github_repo_id: number; local_path: string }>(
    db,
    `SELECT github_repo_id, local_path FROM local_repos
     WHERE github_repo_id IN (${placeholders})
     UNION
     SELECT r.github_repo_id, l.local_path
     FROM local_repo_remotes r JOIN local_repos l ON l.id = r.local_repo_id
     WHERE r.github_repo_id IN (${placeholders})`,
    [...repoIds, ...repoIds],
  );
  for (const r of rows) {
    const list = map.get(r.github_repo_id) ?? [];
    if (!list.includes(r.local_path)) list.push(r.local_path);
    map.set(r.github_repo_id, list);
  }
  return map;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export interface SearchReposOptions {
  limit?: number;
  includeArchived?: boolean;
  /** Restrict to repos owned by this org/user login. */
  owner?: string;
}

/**
 * Search cached GitHub repos by free text over full name, description and
 * language. All terms must match. Results include known local clone paths.
 */
export function searchGitHubRepos(db: SqlJsDatabase, query: string, opts: SearchReposOptions = {}): GitHubRepoHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const terms = queryTerms(query);
  const filter = buildTermFilter(['full_name', 'description', 'language'], terms);
  const extra: string[] = [];
  const params: Array<string | number> = [...filter.params];
  if (!opts.includeArchived) extra.push('archived = 0');
  if (opts.owner) {
    extra.push('LOWER(full_name) LIKE ?');
    params.push(`${opts.owner.toLowerCase()}/%`);
  }
  params.push(limit);
  const where = [filter.sql, ...extra].join(' AND ');
  const rows = readAll<{
    id: number; full_name: string; description: string | null; language: string | null;
    default_branch: string | null; archived: number; fork: number; private: number; starred: number;
    last_pushed_at: string | null;
  }>(
    db,
    `SELECT id, full_name, description, language, default_branch, archived, fork, private, starred, last_pushed_at
     FROM github_repos
     WHERE ${where}
     ORDER BY last_pushed_at DESC NULLS LAST, full_name COLLATE NOCASE
     LIMIT ?`,
    params,
  );
  const localPaths = localPathsByRepoId(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    fullName: r.full_name,
    description: r.description,
    language: r.language,
    defaultBranch: r.default_branch,
    archived: r.archived === 1,
    fork: r.fork === 1,
    private: r.private === 1,
    starred: r.starred === 1,
    lastPushedAt: r.last_pushed_at,
    htmlUrl: `https://github.com/${r.full_name}`,
    localPaths: localPaths.get(r.id) ?? [],
  }));
}

/**
 * List local git clones Jarvis has discovered on disk. Optional free-text
 * filter over folder name, path, remote URLs and the linked GitHub repo's
 * name/description.
 */
export function searchLocalRepos(db: SqlJsDatabase, query?: string, limit = 50): LocalRepoHit[] {
  const cap = Math.min(Math.max(limit, 1), 500);
  const terms = queryTerms(query ?? '');
  const filter = buildTermFilter(
    ['l.name', 'l.local_path', 'l.remote_url', 'g.full_name', 'g.description', 'rm.url'],
    terms,
  );
  const rows = readAll<{
    id: number; name: string | null; local_path: string; discovered_at: string | null; last_scanned: string | null;
    gh_full_name: string | null; gh_description: string | null;
  }>(
    db,
    `SELECT DISTINCT l.id, l.name, l.local_path, l.discovered_at, l.last_scanned,
            g.full_name AS gh_full_name, g.description AS gh_description
     FROM local_repos l
     LEFT JOIN github_repos g ON g.id = l.github_repo_id
     LEFT JOIN local_repo_remotes rm ON rm.local_repo_id = l.id
     WHERE ${filter.sql}
     ORDER BY l.local_path COLLATE NOCASE
     LIMIT ?`,
    [...filter.params, cap],
  );
  if (rows.length === 0) return [];
  const remoteRows = readAll<{ local_repo_id: number; name: string; url: string }>(
    db,
    `SELECT local_repo_id, name, url FROM local_repo_remotes
     WHERE local_repo_id IN (${rows.map(() => '?').join(',')})
     ORDER BY name`,
    rows.map((r) => r.id),
  );
  const remotes = new Map<number, Array<{ name: string; url: string }>>();
  for (const r of remoteRows) {
    const list = remotes.get(r.local_repo_id) ?? [];
    list.push({ name: r.name, url: r.url });
    remotes.set(r.local_repo_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    localPath: r.local_path,
    githubFullName: r.gh_full_name,
    githubDescription: r.gh_description,
    remotes: remotes.get(r.id) ?? [],
    discoveredAt: r.discovered_at,
    lastScanned: r.last_scanned,
  }));
}

export interface NotificationOptions {
  /** Free text matched against subject title and repo name. */
  query?: string;
  /** Restrict to one repo (owner/repo) or one owner (owner). */
  repo?: string;
  unreadOnly?: boolean;
  /** ISO timestamp; only notifications updated at or after this moment. */
  since?: string;
  limit?: number;
}

/** List cached GitHub notifications, newest first. */
export function listNotifications(db: SqlJsDatabase, opts: NotificationOptions = {}): NotificationHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const terms = queryTerms(opts.query ?? '');
  const filter = buildTermFilter(['subject_title', 'repo_full_name', 'subject_actor_login'], terms);
  const where: string[] = [filter.sql];
  const params: Array<string | number> = [...filter.params];
  if (opts.repo) {
    const repo = opts.repo.toLowerCase();
    if (repo.includes('/')) {
      where.push('LOWER(repo_full_name) = ?');
      params.push(repo);
    } else {
      where.push('LOWER(repo_owner) = ?');
      params.push(repo);
    }
  }
  if (opts.unreadOnly) where.push('unread = 1');
  if (opts.since) {
    where.push('updated_at >= ?');
    params.push(opts.since);
  }
  params.push(limit);
  const rows = readAll<{
    id: string; repo_full_name: string; subject_type: string | null; subject_title: string | null;
    subject_url: string | null; subject_actor_login: string | null; reason: string | null;
    unread: number; updated_at: string | null;
  }>(
    db,
    `SELECT id, repo_full_name, subject_type, subject_title, subject_url, subject_actor_login, reason, unread, updated_at
     FROM github_notifications
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    repoFullName: r.repo_full_name,
    subjectType: r.subject_type,
    subjectTitle: r.subject_title,
    subjectUrl: r.subject_url,
    actorLogin: r.subject_actor_login,
    reason: r.reason,
    unread: r.unread === 1,
    updatedAt: r.updated_at,
  }));
}

export interface WorkflowRunOptions {
  repo?: string;
  /** e.g. "failure", "success" */
  conclusion?: string;
  limit?: number;
}

/** List cached GitHub Actions workflow runs, newest first. */
export function listWorkflowRuns(db: SqlJsDatabase, opts: WorkflowRunOptions = {}): WorkflowRunHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (opts.repo) {
    where.push('LOWER(repo_full_name) = ?');
    params.push(opts.repo.toLowerCase());
  }
  if (opts.conclusion) {
    where.push('LOWER(COALESCE(conclusion, \'\')) = ?');
    params.push(opts.conclusion.toLowerCase());
  }
  params.push(limit);
  const rows = readAll<{
    id: string; repo_full_name: string; workflow_name: string | null; head_branch: string | null;
    event: string | null; status: string | null; conclusion: string | null; run_number: number | null;
    run_started_at: string | null; html_url: string | null;
  }>(
    db,
    `SELECT id, repo_full_name, workflow_name, head_branch, event, status, conclusion, run_number, run_started_at, html_url
     FROM github_workflow_runs
     WHERE ${where.join(' AND ')}
     ORDER BY run_started_at DESC
     LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    repoFullName: r.repo_full_name,
    workflowName: r.workflow_name,
    headBranch: r.head_branch,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    runNumber: r.run_number,
    runStartedAt: r.run_started_at,
    htmlUrl: r.html_url,
  }));
}

/** Aggregate hit set for a single "find this anywhere" query. */
export interface FindAnywhereResult {
  query: string;
  repos: GitHubRepoHit[];
  localRepos: LocalRepoHit[];
  notifications: NotificationHit[];
}

/**
 * One-shot search across every cached GitHub surface: remote repos, local
 * clones and notifications. Useful when the caller does not know where
 * something lives.
 */
export function findAnywhere(db: SqlJsDatabase, query: string, limitPerSource = 10): FindAnywhereResult {
  return {
    query,
    repos: searchGitHubRepos(db, query, { limit: limitPerSource, includeArchived: true }),
    localRepos: searchLocalRepos(db, query, limitPerSource),
    notifications: listNotifications(db, { query, limit: limitPerSource }),
  };
}
