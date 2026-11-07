/**
 * Central entry point for every GitHub API request Jarvis makes.
 *
 * `githubRequest()` wraps the rate-limit-aware `githubFetch()` and, on top of
 * it, records *what* was asked so the REST budget drain can be traced:
 *  - every call is logged (debug) with its URL pattern — path parameters such
 *    as owner/repo/number/sha replaced by placeholders, query values dropped —
 *    next to the concrete URL, so a log grep groups calls by shape while each
 *    line still names the repo / PR / task it was about;
 *  - an in-memory tally per purpose × pattern (plus a bounded ring of recent
 *    calls) backs `summarizeGitHubApiCalls()` for periodic summary log lines
 *    and the `github-api:stats` IPC.
 *
 * `purpose` is a short feature tag (`active-sessions`, `notifications-sync`,
 * …) chosen by the call site; it is what makes the summary actionable.
 */
import { githubFetch, type GithubFetchOptions, type RateLimitInfo } from './github-fetch';
import { logger } from './logger';

export interface GitHubRequestOptions extends GithubFetchOptions {
  /** Feature that issued the call; groups the stats and the log line. */
  purpose: string;
}

export interface GitHubApiCall {
  at: number;
  purpose: string;
  method: string;
  /** URL with path parameters replaced by placeholders and query values dropped. */
  pattern: string;
  /** Concrete URL (never carries a token; GitHub auth travels in headers). */
  url: string;
  status: number;
  durationMs: number;
  rateLimit: RateLimitInfo | null;
}

export interface GitHubApiPatternStats {
  purpose: string;
  method: string;
  pattern: string;
  count: number;
  lastAt: number;
  lastUrl: string;
}

export interface GitHubApiStats {
  /** Calls since the stats were last reset (app start). */
  total: number;
  since: number;
  byPurpose: Array<{ purpose: string; count: number }>;
  byPattern: GitHubApiPatternStats[];
  recent: GitHubApiCall[];
}

/** Recent calls kept in memory for the stats IPC. */
export const RECENT_CALLS_LIMIT = 2000;

const HEX_SHA_RE = /^[0-9a-f]{40}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
/** Path segments whose *next* segment is an identifier (owner/repo are handled separately). */
const ID_PARENTS: Record<string, string> = {
  users: '{user}',
  orgs: '{org}',
  repositories: '{id}',
  threads: '{id}',
  tasks: '{task}',
  runs: '{run}',
  jobs: '{job}',
  artifacts: '{id}',
  secrets: '{name}',
  branches: '{branch}',
  commits: '{sha}',
  'check-suites': '{id}',
  'check-runs': '{id}',
  pulls: '{n}',
  issues: '{n}',
  comments: '{id}',
  installations: '{id}',
  teams: '{team}',
  projects: '{id}',
  releases: '{id}',
  tags: '{tag}',
  workflows: '{workflow}',
};

/**
 * The shape of a GitHub API URL: `/repos/{owner}/{repo}/pulls/{n}?per_page`.
 * Pure; exported for tests.
 */
export function githubUrlPattern(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prev = i > 0 ? segments[i - 1] : '';
    const prev2 = i > 1 ? segments[i - 2] : '';
    if (prev === 'repos') out.push('{owner}');
    else if (prev2 === 'repos') out.push('{repo}');
    else if (Object.prototype.hasOwnProperty.call(ID_PARENTS, prev)) out.push(ID_PARENTS[prev]);
    else if (HEX_SHA_RE.test(seg)) out.push('{sha}');
    else if (UUID_RE.test(seg)) out.push('{id}');
    else if (NUMERIC_RE.test(seg)) out.push('{n}');
    else out.push(seg);
  }
  const keys = [...new Set([...parsed.searchParams.keys()])].sort();
  return `/${out.join('/')}${keys.length ? `?${keys.join('&')}` : ''}`;
}

const recent: GitHubApiCall[] = [];
const patterns = new Map<string, GitHubApiPatternStats>();
let total = 0;
let since = Date.now();

function record(call: GitHubApiCall): void {
  total++;
  recent.push(call);
  if (recent.length > RECENT_CALLS_LIMIT) recent.splice(0, recent.length - RECENT_CALLS_LIMIT);
  const key = `${call.purpose}\u0000${call.method}\u0000${call.pattern}`;
  const entry = patterns.get(key);
  if (entry) {
    entry.count++;
    entry.lastAt = call.at;
    entry.lastUrl = call.url;
  } else {
    patterns.set(key, { purpose: call.purpose, method: call.method, pattern: call.pattern, count: 1, lastAt: call.at, lastUrl: call.url });
  }
}

/** Exposed for tests. */
export function resetGitHubApiStats(now: number = Date.now()): void {
  recent.length = 0;
  patterns.clear();
  total = 0;
  since = now;
}

export function getGitHubApiStats(): GitHubApiStats {
  const byPurpose = new Map<string, number>();
  for (const p of patterns.values()) byPurpose.set(p.purpose, (byPurpose.get(p.purpose) ?? 0) + p.count);
  return {
    total,
    since,
    byPurpose: [...byPurpose].map(([purpose, count]) => ({ purpose, count })).sort((a, b) => b.count - a.count),
    byPattern: [...patterns.values()].sort((a, b) => b.count - a.count),
    recent: recent.slice(),
  };
}

/**
 * One line per purpose with its busiest patterns, for calls made after
 * `sinceMs`. Empty string when nothing was called — callers skip the log then.
 */
export function summarizeGitHubApiCalls(sinceMs: number, maxPatterns = 5): string {
  const calls = recent.filter((c) => c.at >= sinceMs);
  if (calls.length === 0) return '';
  const byPurpose = new Map<string, Map<string, number>>();
  for (const c of calls) {
    const key = `${c.method} ${c.pattern}`;
    const m = byPurpose.get(c.purpose) ?? new Map<string, number>();
    m.set(key, (m.get(key) ?? 0) + 1);
    byPurpose.set(c.purpose, m);
  }
  const lines = [...byPurpose]
    .map(([purpose, m]) => {
      const count = [...m.values()].reduce((a, b) => a + b, 0);
      const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, maxPatterns).map(([k, n]) => `${k}×${n}`).join(', ');
      return `${purpose}=${count} (${top})`;
    })
    .sort();
  return `${calls.length} call(s): ${lines.join('; ')}`;
}

function methodOf(init: RequestInit | undefined): string {
  return (init?.method ?? 'GET').toUpperCase();
}

/**
 * `fetch` for the GitHub API: rate-limit aware (see `githubFetch`) and
 * accounted for. Returns the response; the caller still checks `response.ok`.
 * Throws `GitHubRateLimitError` when the budget is exhausted and cannot be
 * waited out, and rethrows network errors after recording them (status 0).
 */
export async function githubRequest(
  url: string,
  init: RequestInit = {},
  options: GitHubRequestOptions,
): Promise<Response> {
  const { purpose, ...fetchOptions } = options;
  const method = methodOf(init);
  const pattern = githubUrlPattern(url);
  const startedAt = Date.now();
  const seen: { rateLimit: RateLimitInfo | null } = { rateLimit: null };
  const onRateLimit = (info: RateLimitInfo) => {
    seen.rateLimit = info;
    fetchOptions.onRateLimit?.(info);
  };
  let status = 0;
  try {
    const response = await githubFetch(url, init, { ...fetchOptions, onRateLimit });
    status = response.status;
    return response;
  } finally {
    const at = Date.now();
    const { rateLimit } = seen;
    const call: GitHubApiCall = { at, purpose, method, pattern, url, status, durationMs: at - startedAt, rateLimit };
    record(call);
    const budget = rateLimit ? ` ${rateLimit.resource ?? 'core'} ${rateLimit.remaining}/${rateLimit.limit}` : '';
    logger.debug(`[GitHubAPI] ${purpose} ${method} ${pattern} → ${status || 'ERR'} ${call.durationMs}ms${budget} ${url}`);
  }
}

/** Standard REST headers for a bearer token. */
export function githubHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}
