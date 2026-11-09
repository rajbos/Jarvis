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
  /** Which credential made the call: `oauth` / `pat` (the primary account's, as shown in the status bar), `<source>:<account>` for others, `other` when unlabelled, `none` when unauthenticated. */
  token: string;
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
  token: string;
  method: string;
  pattern: string;
  count: number;
  lastAt: number;
  lastUrl: string;
}

export interface GitHubApiStats {
  /** Calls in the window. */
  total: number;
  /** Start of the window (epoch ms); the app start when that is later. */
  since: number;
  windowMs: number;
  byPurpose: Array<{ purpose: string; count: number }>;
  byToken: Array<{ token: string; count: number }>;
  byPattern: GitHubApiPatternStats[];
  recent: GitHubApiCall[];
}

// ── Token attribution ────────────────────────────────────────────────────────
// Calls are attributed to the credential in their Authorization header. The
// rate-limit handler / account resolver register a label per credential; the
// map lives only in this process' memory (the credentials are already held in
// memory by the auth services) and only the label ever reaches the stats,
// the log or the renderer.

const tokenLabels = new Map<string, string>();

/**
 * Name a credential for the call stats. `override` replaces an existing label
 * (the status-bar tokens win over the per-account `<source>:<id>` labels).
 */
export function registerGitHubToken(token: string | null | undefined, label: string, override = false): void {
  if (!token) return;
  if (override || !tokenLabels.has(token)) tokenLabels.set(token, label);
}

function bearerOf(init: RequestInit | undefined): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  let value: string | null | undefined;
  if (typeof (headers as Headers).get === 'function') value = (headers as Headers).get('authorization');
  else if (Array.isArray(headers)) value = headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  else value = Object.entries(headers as Record<string, string>).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  if (!value) return null;
  const m = value.match(/^(?:bearer|token)\s+(.+)$/i);
  return m ? m[1].trim() : value.trim();
}

/** Label for a credential: registered name, `other` when none yet, `none` when unauthenticated. */
function labelFor(credential: string | null): string {
  if (!credential) return 'none';
  return tokenLabels.get(credential) ?? 'other';
}

/** Label for the credential a request carries. Exported for tests. */
export function tokenLabelOf(init: RequestInit | undefined): string {
  return labelFor(bearerOf(init));
}

/** Recent calls kept in memory for the stats IPC. */
export const RECENT_CALLS_LIMIT = 50_000;

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

// Records keep the credential itself (private to this module) and resolve its
// label when read, so a token named after its first calls — the badge poll runs
// a while after sign-in — relabels those calls too instead of leaving them "other".
interface CallRecord extends Omit<GitHubApiCall, 'token'> {
  credential: string | null;
}

/** Calls older than this are dropped from the ring; stats are windows over it. */
export const CALL_RETENTION_MS = 24 * 60 * 60 * 1000;

const recent: CallRecord[] = [];
let since = Date.now();

function record(call: CallRecord): void {
  recent.push(call);
  const cutoff = call.at - CALL_RETENTION_MS;
  let drop = 0;
  while (drop < recent.length && recent[drop].at < cutoff) drop++;
  if (recent.length - drop > RECENT_CALLS_LIMIT) drop = recent.length - RECENT_CALLS_LIMIT;
  if (drop > 0) recent.splice(0, drop);
}

function publicCall({ credential, ...call }: CallRecord): GitHubApiCall {
  return { ...call, token: labelFor(credential) };
}

/** Exposed for tests. */
export function resetGitHubApiStats(now: number = Date.now()): void {
  recent.length = 0;
  tokenLabels.clear();
  etagCache.clear();
  since = now;
}

/** Calls after `sinceMs`, counted per credential label and per purpose. */
export function countGitHubApiCalls(sinceMs: number): { total: number; byToken: Record<string, number>; byPurpose: Record<string, number> } {
  const byToken: Record<string, number> = {};
  const byPurpose: Record<string, number> = {};
  let count = 0;
  for (const c of recent) {
    if (c.at < sinceMs) continue;
    count++;
    const token = labelFor(c.credential);
    byToken[token] = (byToken[token] ?? 0) + 1;
    byPurpose[c.purpose] = (byPurpose[c.purpose] ?? 0) + 1;
  }
  return { total: count, byToken, byPurpose };
}

/**
 * The calls of the last `windowMs` (default: everything retained), grouped by
 * purpose, credential and URL pattern. `since` is where the window starts, or
 * the app start when that is later — the ring only knows this run.
 */
export function getGitHubApiStats(windowMs: number = CALL_RETENTION_MS, now: number = Date.now()): GitHubApiStats {
  const start = Math.max(now - windowMs, since);
  const byPurpose = new Map<string, number>();
  const byToken = new Map<string, number>();
  const byPattern = new Map<string, GitHubApiPatternStats>();
  const calls: GitHubApiCall[] = [];
  for (const c of recent) {
    if (c.at < start) continue;
    const call = publicCall(c);
    calls.push(call);
    byPurpose.set(call.purpose, (byPurpose.get(call.purpose) ?? 0) + 1);
    byToken.set(call.token, (byToken.get(call.token) ?? 0) + 1);
    const key = `${call.purpose}\u0000${call.token}\u0000${call.method}\u0000${call.pattern}`;
    const entry = byPattern.get(key);
    if (entry) {
      entry.count++;
      if (call.at >= entry.lastAt) { entry.lastAt = call.at; entry.lastUrl = call.url; }
    } else {
      byPattern.set(key, { purpose: call.purpose, token: call.token, method: call.method, pattern: call.pattern, count: 1, lastAt: call.at, lastUrl: call.url });
    }
  }
  return {
    total: calls.length,
    since: start,
    windowMs,
    byPurpose: [...byPurpose].map(([purpose, count]) => ({ purpose, count })).sort((a, b) => b.count - a.count),
    byToken: [...byToken].map(([token, count]) => ({ token, count })).sort((a, b) => b.count - a.count),
    byPattern: [...byPattern.values()].sort((a, b) => b.count - a.count),
    recent: calls,
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

// ── Conditional requests (ETag cache) ────────────────────────────────────────
// GitHub does not charge a 304 Not Modified against the primary rate limit
// when the request is authorized. Every successful GET that carries an ETag is
// remembered (body + headers, in memory only); the next GET of the same URL by
// the same credential with the same Accept header sends `If-None-Match`, and a
// 304 is answered from the cache as if it were the original 200. Polling loops
// (notification sync, auto-dismiss, PR readiness) re-read mostly unchanged
// resources, so most of their calls become free.

interface EtagEntry {
  etag: string;
  body: string;
  headers: [string, string][];
  status: number;
  statusText: string;
}

/** Max cached responses; the least recently used are dropped first. */
export const ETAG_CACHE_MAX_ENTRIES = 5_000;
/** Bodies larger than this are not cached (keeps the cache's memory bounded). */
export const ETAG_CACHE_MAX_BODY_CHARS = 1_000_000;

const etagCache = new Map<string, EtagEntry>();

/** Exposed for tests. */
export function clearGitHubEtagCache(): void {
  etagCache.clear();
}

/** Number of cached responses. Exposed for tests. */
export function githubEtagCacheSize(): number {
  return etagCache.size;
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  return new Headers(headers).get(name);
}

function etagKey(url: string, init: RequestInit, credential: string | null): string | null {
  if (methodOf(init) !== 'GET') return null;
  // The caller manages its own validators; leave the request alone.
  if (headerValue(init.headers, 'if-none-match') || headerValue(init.headers, 'if-modified-since')) return null;
  const accept = headerValue(init.headers, 'accept') ?? '';
  return `${credential ?? ''}\u0000${accept}\u0000${url}`;
}

function cachedResponse(entry: EtagEntry, fresh: Response): Response {
  const headers = new Headers(entry.headers);
  // The 304 carries the current rate-limit budget; pass that on, not the stale one.
  fresh.headers?.forEach?.((value, name) => {
    if (name.toLowerCase().startsWith('x-ratelimit-')) headers.set(name, value);
  });
  return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers });
}

async function rememberResponse(key: string, response: Response): Promise<void> {
  const etag = response.headers?.get?.('etag');
  if (!etag || response.status !== 200) {
    etagCache.delete(key);
    return;
  }
  try {
    const body = await response.clone().text();
    if (body.length > ETAG_CACHE_MAX_BODY_CHARS) {
      etagCache.delete(key);
      return;
    }
    const headers: [string, string][] = [];
    response.headers.forEach((value, name) => headers.push([name, value]));
    etagCache.delete(key);
    etagCache.set(key, { etag, body, headers, status: response.status, statusText: response.statusText });
    while (etagCache.size > ETAG_CACHE_MAX_ENTRIES) {
      const oldest = etagCache.keys().next().value;
      if (oldest === undefined) break;
      etagCache.delete(oldest);
    }
  } catch {
    // Body not readable (test doubles, aborted stream): just don't cache it.
  }
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
  const credential = bearerOf(init);
  const startedAt = Date.now();
  const seen: { rateLimit: RateLimitInfo | null } = { rateLimit: null };
  const onRateLimit = (info: RateLimitInfo) => {
    seen.rateLimit = info;
    fetchOptions.onRateLimit?.(info);
  };
  const cacheKey = etagKey(url, init, credential);
  const cached = cacheKey ? etagCache.get(cacheKey) : undefined;
  let requestInit = init;
  if (cached) {
    const headers = new Headers(init.headers);
    headers.set('If-None-Match', cached.etag);
    requestInit = { ...init, headers };
  }
  let status = 0;
  try {
    const response = await githubFetch(url, requestInit, { ...fetchOptions, onRateLimit });
    status = response.status;
    if (cacheKey && cached && response.status === 304) {
      // Mark as recently used.
      etagCache.delete(cacheKey);
      etagCache.set(cacheKey, cached);
      return cachedResponse(cached, response);
    }
    if (cacheKey) await rememberResponse(cacheKey, response);
    return response;
  } finally {
    const at = Date.now();
    const { rateLimit } = seen;
    const call: CallRecord = { at, purpose, credential, method, pattern, url, status, durationMs: at - startedAt, rateLimit };
    record(call);
    const budget = rateLimit ? ` ${rateLimit.resource ?? 'core'} ${rateLimit.remaining}/${rateLimit.limit}` : '';
    logger.debug(`[GitHubAPI] ${purpose} [${labelFor(credential)}] ${method} ${pattern} → ${status || 'ERR'} ${call.durationMs}ms${budget} ${url}`);
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
