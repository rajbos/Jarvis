/**
 * Pure helpers for the GitHub API usage dialog (kept out of the .tsx so unit
 * tests can import them without a JSX runtime).
 */
import type { GitHubApiCallStats, GitHubRateLimitSample } from '../types';

/** Human name for a credential label from the call stats. */
export function tokenLabel(token: string): string {
  if (token === 'oauth') return 'OAuth';
  if (token === 'pat') return 'PAT';
  if (token === 'other') return 'Unlabelled token';
  if (token === 'none') return 'No token';
  return token;
}

/** "30 min", "3 h 5 min", "3 d" — how long the tally has been running. */
export function formatSince(sinceMs: number, now: number): string {
  const mins = Math.max(1, Math.round((now - sinceMs) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
  return `${Math.floor(hours / 24)} d`;
}

export interface PurposeRow {
  purpose: string;
  total: number;
  byToken: Record<string, number>;
}

/**
 * Calls per purpose with a column per credential, from the per-pattern tally.
 * `byPattern` is capped by the IPC, so the row totals come from `byPurpose`.
 */
export function purposeRows(stats: GitHubApiCallStats): PurposeRow[] {
  const rows = new Map<string, PurposeRow>();
  for (const p of stats.byPattern) {
    const row = rows.get(p.purpose) ?? { purpose: p.purpose, total: 0, byToken: {} };
    row.total += p.count;
    row.byToken[p.token] = (row.byToken[p.token] ?? 0) + p.count;
    rows.set(p.purpose, row);
  }
  for (const { purpose, count } of stats.byPurpose) {
    const row = rows.get(purpose) ?? { purpose, total: 0, byToken: {} };
    row.total = count;
    rows.set(purpose, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

export interface HourlyLows {
  /** Lowest remaining in the last 60 minutes; null without samples. */
  current: number | null;
  /** Lowest remaining in the 60 minutes before that. */
  previous: number | null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Lowest remaining value of one bucket in the current hour and the hour before,
 * from the 2-hour sample history, so the drain per hour can be read off the
 * row without decoding the trend line.
 */
export function hourlyLows(history: readonly GitHubRateLimitSample[] | undefined, bucket: string, now: number): HourlyLows {
  let current: number | null = null;
  let previous: number | null = null;
  for (const sample of history ?? []) {
    const value = (sample.buckets as Record<string, { remaining: number } | undefined>)[bucket]?.remaining;
    if (value === undefined) continue;
    const age = now - sample.at;
    if (age < 0 || age >= 2 * HOUR_MS) continue;
    if (age < HOUR_MS) current = current === null ? value : Math.min(current, value);
    else previous = previous === null ? value : Math.min(previous, value);
  }
  return { current, previous };
}

/** Credential columns: the status-bar tokens first, then whatever else made calls. */
export function tokenColumns(stats: GitHubApiCallStats | null): string[] {
  const others = (stats?.byToken ?? []).map((t) => t.token).filter((t) => t !== 'oauth' && t !== 'pat');
  return ['oauth', 'pat', ...others];
}
