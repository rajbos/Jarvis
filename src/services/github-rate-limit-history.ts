/**
 * In-memory history of GitHub rate-limit snapshots, per token source, so the
 * status-bar popover can chart the last couple of hours. Every sample is also
 * written to the usage-history store (30 days, for the history dialog), and
 * the in-memory window is reloaded from it on start so a restart keeps it.
 */
import type { GitHubRateLimitResource, GitHubRateLimitSample } from '../plugins/types';
import { RATE_LIMIT_TRACKED_BUCKETS } from '../plugins/github-auth/rate-limit-chart';
import { readUsageSamples, recordUsageSample } from './usage-history';

export type RateLimitSource = 'oauth' | 'pat';

/** How far back samples are kept in memory. */
export const RATE_LIMIT_HISTORY_WINDOW_MS = 2 * 60 * 60 * 1000;

const history: Record<RateLimitSource, GitHubRateLimitSample[]> = { oauth: [], pat: [] };

export function recordRateLimitSample(
  source: RateLimitSource,
  resources: Record<string, GitHubRateLimitResource>,
  now: number = Date.now(),
): void {
  const buckets: GitHubRateLimitSample['buckets'] = {};
  const series: Record<string, { value: number; limit: number }> = {};
  for (const name of RATE_LIMIT_TRACKED_BUCKETS) {
    const r = resources[name];
    if (!r) continue;
    buckets[name] = { remaining: r.remaining, limit: r.limit };
    series[name] = { value: r.remaining, limit: r.limit };
  }
  const list = history[source];
  list.push({ at: now, buckets });
  prune(list, now);
  recordUsageSample(`github-${source}`, { at: now, series });
}

export function getRateLimitHistory(source: RateLimitSource, now: number = Date.now()): GitHubRateLimitSample[] {
  const list = history[source];
  prune(list, now);
  return list.slice();
}

/** Fill the in-memory window from the store, keeping anything already recorded this run. */
export function reloadRateLimitHistory(now: number = Date.now()): void {
  for (const source of ['oauth', 'pat'] as const) {
    const seen = new Set(history[source].map((s) => s.at));
    const loaded = readUsageSamples(`github-${source}`, now - RATE_LIMIT_HISTORY_WINDOW_MS, now)
      .filter((s) => !seen.has(s.at))
      .map((s) => {
        const buckets: GitHubRateLimitSample['buckets'] = {};
        for (const name of RATE_LIMIT_TRACKED_BUCKETS) {
          const v = s.series[name];
          if (v && v.limit !== null) buckets[name] = { remaining: v.value, limit: v.limit };
        }
        return { at: s.at, buckets };
      });
    history[source] = [...loaded, ...history[source]].sort((a, b) => a.at - b.at);
  }
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
