/**
 * In-memory history of GitHub rate-limit snapshots, per token source, so the
 * status-bar popover can chart the last couple of hours. Lives in the main
 * process so a renderer reload keeps the history.
 */
import type { GitHubRateLimitResource, GitHubRateLimitSample } from '../plugins/types';

export type RateLimitSource = 'oauth' | 'pat';

/** How far back samples are kept. */
export const RATE_LIMIT_HISTORY_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Buckets worth charting; the rest of `/rate_limit` (code_scanning_upload, …) is noise. */
const TRACKED_BUCKETS = ['core', 'graphql', 'search'] as const;

const history: Record<RateLimitSource, GitHubRateLimitSample[]> = { oauth: [], pat: [] };

export function recordRateLimitSample(
  source: RateLimitSource,
  resources: Record<string, GitHubRateLimitResource>,
  now: number = Date.now(),
): void {
  const buckets: GitHubRateLimitSample['buckets'] = {};
  for (const name of TRACKED_BUCKETS) {
    const r = resources[name];
    if (r) buckets[name] = { remaining: r.remaining, limit: r.limit };
  }
  const list = history[source];
  list.push({ at: now, buckets });
  prune(list, now);
}

export function getRateLimitHistory(source: RateLimitSource, now: number = Date.now()): GitHubRateLimitSample[] {
  const list = history[source];
  prune(list, now);
  return list.slice();
}

export function clearRateLimitHistory(source?: RateLimitSource): void {
  if (source) history[source] = [];
  else { history.oauth = []; history.pat = []; }
}

function prune(list: GitHubRateLimitSample[], now: number): void {
  const cutoff = now - RATE_LIMIT_HISTORY_WINDOW_MS;
  let drop = 0;
  while (drop < list.length && list[drop].at < cutoff) drop++;
  if (drop > 0) list.splice(0, drop);
}
