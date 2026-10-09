import type { GitHubRateLimitResource, GitHubRateLimitSample, GitHubRateLimitSource } from '../types';

export type ChartBucket = 'core' | 'graphql';

export const CHART_BUCKETS: readonly ChartBucket[] = ['core', 'graphql'];

export const CHART_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface ChartPoint {
  x: number;
  y: number;
}

/**
 * Map history samples to SVG coordinates: x spans the last 2 hours ending at
 * `now`, y is the share of the bucket still remaining (top = full, bottom = 0).
 */
export function rateLimitSeries(
  history: GitHubRateLimitSample[],
  bucket: ChartBucket,
  now: number,
  width: number,
  height: number,
): ChartPoint[] {
  const start = now - CHART_WINDOW_MS;
  const points: ChartPoint[] = [];
  for (const sample of history) {
    const b = sample.buckets[bucket];
    if (!b || b.limit <= 0 || sample.at < start) continue;
    const ratio = Math.min(1, Math.max(0, b.remaining / b.limit));
    points.push({
      x: round(((Math.min(sample.at, now) - start) / CHART_WINDOW_MS) * width),
      y: round((1 - ratio) * height),
    });
  }
  return points;
}

/**
 * The bucket closest to running out among core and GraphQL. Search is left
 * out: its 30-per-minute quota swings too fast to be a useful headline.
 */
export function tightestBucket(
  source: GitHubRateLimitSource,
): { name: ChartBucket; resource: GitHubRateLimitResource } | null {
  const all = source.resources ?? (source.resource ? { core: source.resource } : {});
  let best: { name: ChartBucket; resource: GitHubRateLimitResource } | null = null;
  for (const name of CHART_BUCKETS) {
    const r = all[name];
    if (!r || r.limit <= 0) continue;
    if (!best || r.remaining / r.limit < best.resource.remaining / best.resource.limit) {
      best = { name, resource: r };
    }
  }
  return best;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
