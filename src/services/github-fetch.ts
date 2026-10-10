/**
 * Shared, rate-limit-aware wrapper around `fetch` for the GitHub REST API.
 *
 * All GitHub REST call sites should use `githubFetch()` (or at least
 * `parseRateLimit()`) instead of hand-rolling `fetch()`, so rate-limit
 * handling stays consistent:
 *  - `x-ratelimit-*` headers are parsed on every response,
 *  - a primary rate-limit rejection (403/429 with remaining 0) or a secondary
 *    rate-limit (429, or 403 with `retry-after` / a "secondary rate limit"
 *    message) waits until the reset and retries,
 *  - when the wait would be too long, `GitHubRateLimitError` is thrown so
 *    callers can distinguish "rate limited" from "not found" and stop
 *    fanning out further requests.
 * Genuine 401/403 (not exhausted)/404 responses are returned untouched.
 */
import { logger } from './logger';

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  reset: number; // Unix timestamp (seconds)
  /** Bucket the headers describe (`x-ratelimit-resource`): core, search, graphql, … */
  resource?: string;
}

/** Fallback wait for a secondary rate limit that carries no `retry-after` header. */
export const SECONDARY_RATE_LIMIT_WAIT_MS = 60_000;

/** Default upper bound for how long a single call is willing to wait for a reset. */
export const DEFAULT_MAX_WAIT_MS = 60_000;

export class GitHubRateLimitError extends Error {
  constructor(
    public readonly url: string,
    public readonly rateLimit: RateLimitInfo | null,
    public readonly waitMs: number,
  ) {
    super(`GitHub API rate limit exceeded for ${url} (resets in ${Math.ceil(waitMs / 1000)}s)`);
    this.name = 'GitHubRateLimitError';
  }
}

/**
 * Parses the `x-ratelimit-*` headers. Returns null when the response carries no
 * rate-limit info (non-API responses, some errors), so callers don't mistake a
 * missing header for a full budget.
 */
export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const remaining = parseInt(headers.get('x-ratelimit-remaining') ?? '', 10);
  const limit = parseInt(headers.get('x-ratelimit-limit') ?? '', 10);
  if (!Number.isFinite(remaining)) return null;
  const reset = parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
  const info: RateLimitInfo = {
    remaining,
    // Without a limit header the remaining count is the only budget we know of.
    limit: Number.isFinite(limit) ? limit : remaining,
    reset: Number.isFinite(reset) ? reset : 0,
  };
  const resource = headers.get('x-ratelimit-resource');
  if (resource) info.resource = resource;
  return info;
}

/**
 * The rate-limit bucket a REST URL is billed against, used to pick which
 * tracked budget to check before a call (the response's `x-ratelimit-resource`
 * header is authoritative afterwards).
 */
export function rateLimitResourceForUrl(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // not an absolute URL — match on the raw string
  }
  if (/\/search\/code(\/|$|\?)/.test(path)) return 'code_search';
  if (/\/search\//.test(path)) return 'search';
  if (/\/graphql(\/|$|\?)/.test(path)) return 'graphql';
  return 'core';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a primary rate-limit rejection: the bucket is exhausted. */
export function isPrimaryRateLimited(response: Response, info: RateLimitInfo | null): boolean {
  return (response.status === 403 || response.status === 429) && info?.remaining === 0;
}

/**
 * True for a secondary (abuse / concurrency) rate limit: 429, or a 403 that
 * still has primary budget left but carries `retry-after` or a body message
 * mentioning "secondary rate limit". Reads a clone of the body, so the caller
 * can still consume the original.
 */
export async function isSecondaryRateLimited(response: Response, info: RateLimitInfo | null): Promise<boolean> {
  if (isPrimaryRateLimited(response, info)) return false;
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (response.headers.get('retry-after') !== null) return true;
  try {
    const body = await response.clone().text();
    return /secondary rate limit/i.test(body);
  } catch {
    return false;
  }
}

/** True when the response is a rate-limit rejection (primary or secondary). */
export async function isRateLimited(response: Response, info: RateLimitInfo | null): Promise<boolean> {
  return isPrimaryRateLimited(response, info) || (await isSecondaryRateLimited(response, info));
}

/**
 * Milliseconds to wait before retrying a rate-limited response: `retry-after`
 * when present, the bucket reset for a primary limit, otherwise the secondary
 * rate-limit fallback.
 */
export function computeRateLimitWaitMs(response: Response, info: RateLimitInfo | null): number {
  const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000 + 1000;
  if (isPrimaryRateLimited(response, info) && info) return Math.max(0, info.reset * 1000 - Date.now() + 1000);
  return SECONDARY_RATE_LIMIT_WAIT_MS;
}

export interface GithubFetchOptions {
  /** Max time to sleep waiting for a reset before throwing instead. Default 60s. */
  maxWaitMs?: number;
  /** Max retries after a rate-limit rejection. Default 1. */
  maxRetries?: number;
  /** Called with the parsed rate-limit info of every response. */
  onRateLimit?: (info: RateLimitInfo) => void;
}

/**
 * `fetch` with rate-limit awareness. Returns the (non-rate-limited) response;
 * the caller still checks `response.ok`. Throws `GitHubRateLimitError` if the
 * limit is exhausted and cannot be waited out.
 */
export async function githubFetch(
  url: string,
  init: RequestInit,
  options: GithubFetchOptions = {},
): Promise<Response> {
  const { maxWaitMs = DEFAULT_MAX_WAIT_MS, maxRetries = 1, onRateLimit } = options;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    const info = parseRateLimit(response.headers);
    if (info) onRateLimit?.(info);
    if (!(await isRateLimited(response, info))) return response;

    const waitMs = computeRateLimitWaitMs(response, info);
    if (attempt >= maxRetries || waitMs > maxWaitMs) {
      logger.warn(`[GitHub] Rate limit exceeded for ${url}; not waiting (${Math.ceil(waitMs / 1000)}s until reset)`);
      throw new GitHubRateLimitError(url, info, waitMs);
    }
    logger.debug(`[GitHub] Rate limit exceeded. Waiting ${Math.ceil(waitMs / 1000)}s before retry…`);
    await sleep(waitMs);
  }
}
