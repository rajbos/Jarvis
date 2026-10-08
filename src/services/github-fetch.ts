/**
 * Shared, rate-limit-aware wrapper around `fetch` for the GitHub REST API.
 *
 * All GitHub REST call sites should use `githubFetch()` (or at least
 * `parseRateLimit()`) instead of hand-rolling `fetch()`, so rate-limit
 * handling stays consistent:
 *  - `x-ratelimit-*` headers are parsed on every response,
 *  - a primary rate-limit rejection (403 with remaining 0) or secondary
 *    rate-limit (429) waits until the reset and retries,
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
}

/** Default upper bound for how long a single call is willing to wait for a reset. */
export const DEFAULT_MAX_WAIT_MS = 60_000;

export class GitHubRateLimitError extends Error {
  constructor(
    public readonly url: string,
    public readonly rateLimit: RateLimitInfo,
    public readonly waitMs: number,
  ) {
    super(`GitHub API rate limit exceeded for ${url} (resets in ${Math.ceil(waitMs / 1000)}s)`);
    this.name = 'GitHubRateLimitError';
  }
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
  return {
    remaining: parseInt(headers.get('x-ratelimit-remaining') || '5000', 10),
    limit: parseInt(headers.get('x-ratelimit-limit') || '5000', 10),
    reset: parseInt(headers.get('x-ratelimit-reset') || '0', 10),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the response is a rate-limit rejection (primary 403 or 429). */
export function isRateLimited(response: Response, info: RateLimitInfo): boolean {
  return response.status === 429 || (response.status === 403 && info.remaining === 0);
}

/** Milliseconds to wait before retrying, honouring `retry-after` when present. */
function computeWaitMs(response: Response, info: RateLimitInfo): number {
  const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000 + 1000;
  return Math.max(0, info.reset * 1000 - Date.now() + 1000);
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
    onRateLimit?.(info);
    if (!isRateLimited(response, info)) return response;

    const waitMs = computeWaitMs(response, info);
    if (attempt >= maxRetries || waitMs > maxWaitMs) {
      logger.warn(`[GitHub] Rate limit exceeded for ${url}; not waiting (${Math.ceil(waitMs / 1000)}s until reset)`);
      throw new GitHubRateLimitError(url, info, waitMs);
    }
    logger.debug(`[GitHub] Rate limit exceeded. Waiting ${Math.ceil(waitMs / 1000)}s before retry…`);
    await sleep(waitMs);
  }
}
