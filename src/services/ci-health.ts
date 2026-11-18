/**
 * CI health trends — pure calculations over cached workflow runs.
 *
 * No I/O here: callers load rows from `github_workflow_runs` and pass them in,
 * so everything is deterministic and unit-testable. `now` is injected.
 *
 * Limits of the cached data (see the PR for #567):
 *  - Only the last 7 days (max 100 runs per repo) are fetched and the cache is
 *    replaced on every fetch, so a 30-day window reports whatever is stored.
 *  - A re-run keeps the same run id, so the earlier failed attempt is
 *    overwritten. "Flaky" is therefore detected across separate run rows
 *    of the same workflow on the same commit SHA (fail, then pass).
 */

export interface CiRunInput {
  repoFullName: string;
  workflowId: string | null;
  workflowName: string | null;
  headSha: string | null;
  conclusion: string | null;
  status?: string | null;
  runStartedAt: string | null;
  updatedAt: string | null;
}

export interface CiWorkflowHealth {
  repoFullName: string;
  workflowId: string;
  workflowName: string;
  /** Completed runs with a pass/fail conclusion inside the window. */
  totalRuns: number;
  failedRuns: number;
  /** failedRuns / totalRuns, 0..1. */
  failureRate: number;
  /** Commit SHAs where a failure was followed by a success. */
  flakyShas: number;
  /** Median duration (ms) of successful runs in the recent half of the window, or null. */
  medianDurationMs: number | null;
  /** Median duration (ms) of successful runs in the earlier half of the window, or null. */
  previousMedianDurationMs: number | null;
  /** (recent - previous) / previous; null when either half lacks data. */
  durationDrift: number | null;
}

export interface CiHealthReport {
  windowDays: number;
  generatedAt: string;
  workflows: CiWorkflowHealth[];
  topFailing: CiWorkflowHealth[];
  topFlaky: CiWorkflowHealth[];
  topSlowing: CiWorkflowHealth[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PASS = new Set(['success']);
const FAIL = new Set(['failure', 'timed_out']);
/** Minimum successful runs per half before a duration drift is reported. */
const MIN_RUNS_PER_HALF = 2;
/** Drift below this is noise and not listed as "slowing". */
const MIN_REPORTED_DRIFT = 0.1;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  // SQLite datetime() output has no zone marker; treat it as UTC.
  const iso = /^\d{4}-\d{2}-\d{2} \d/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function durationMs(run: CiRunInput): number | null {
  const start = toMs(run.runStartedAt);
  const end = toMs(run.updatedAt);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

/** Count SHAs on which this workflow failed and a later run then passed. */
export function countFlakyShas(runs: CiRunInput[]): number {
  const bySha = new Map<string, CiRunInput[]>();
  for (const r of runs) {
    if (!r.headSha || !r.conclusion) continue;
    const list = bySha.get(r.headSha) ?? [];
    list.push(r);
    bySha.set(r.headSha, list);
  }
  let flaky = 0;
  for (const list of bySha.values()) {
    const ordered = list
      .map((r) => ({ r, t: toMs(r.runStartedAt) ?? 0 }))
      .sort((a, b) => a.t - b.t);
    let seenFail = false;
    for (const { r } of ordered) {
      if (FAIL.has(r.conclusion as string)) seenFail = true;
      else if (seenFail && PASS.has(r.conclusion as string)) {
        flaky++;
        break;
      }
    }
  }
  return flaky;
}

export function computeCiHealth(
  runs: CiRunInput[],
  windowDays: number,
  now: Date = new Date(),
  topN = 5,
): CiHealthReport {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const midpoint = now.getTime() - (windowDays * DAY_MS) / 2;

  const groups = new Map<string, CiRunInput[]>();
  for (const r of runs) {
    const started = toMs(r.runStartedAt);
    if (started === null || started < cutoff || started > now.getTime()) continue;
    const key = `${r.repoFullName}|${r.workflowId ?? r.workflowName ?? 'unknown'}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const workflows: CiWorkflowHealth[] = [];
  for (const list of groups.values()) {
    const decided = list.filter(
      (r) => r.conclusion && (PASS.has(r.conclusion) || FAIL.has(r.conclusion)),
    );
    if (decided.length === 0) continue;
    const failedRuns = decided.filter((r) => FAIL.has(r.conclusion as string)).length;

    const recent: number[] = [];
    const earlier: number[] = [];
    for (const r of decided) {
      const d = durationMs(r);
      if (d === null || !PASS.has(r.conclusion as string)) continue; // failures often abort early
      ((toMs(r.runStartedAt) as number) >= midpoint ? recent : earlier).push(d);
    }
    const medianRecent = recent.length >= MIN_RUNS_PER_HALF ? median(recent) : null;
    const medianEarlier = earlier.length >= MIN_RUNS_PER_HALF ? median(earlier) : null;
    const drift =
      medianRecent !== null && medianEarlier !== null && medianEarlier > 0
        ? (medianRecent - medianEarlier) / medianEarlier
        : null;

    const first = decided[0];
    workflows.push({
      repoFullName: first.repoFullName,
      workflowId: first.workflowId ?? first.workflowName ?? 'unknown',
      workflowName: first.workflowName ?? first.workflowId ?? 'unknown',
      totalRuns: decided.length,
      failedRuns,
      failureRate: failedRuns / decided.length,
      flakyShas: countFlakyShas(decided),
      medianDurationMs: medianRecent,
      previousMedianDurationMs: medianEarlier,
      durationDrift: drift,
    });
  }

  const byName = (a: CiWorkflowHealth, b: CiWorkflowHealth) =>
    `${a.repoFullName}/${a.workflowName}`.localeCompare(`${b.repoFullName}/${b.workflowName}`);

  const topFailing = workflows
    .filter((w) => w.failedRuns > 0)
    .sort((a, b) => b.failureRate - a.failureRate || b.failedRuns - a.failedRuns || byName(a, b))
    .slice(0, topN);
  const topFlaky = workflows
    .filter((w) => w.flakyShas > 0)
    .sort((a, b) => b.flakyShas - a.flakyShas || byName(a, b))
    .slice(0, topN);
  const topSlowing = workflows
    .filter((w) => w.durationDrift !== null && w.durationDrift > MIN_REPORTED_DRIFT)
    .sort((a, b) => (b.durationDrift as number) - (a.durationDrift as number) || byName(a, b))
    .slice(0, topN);

  return { windowDays, generatedAt: now.toISOString(), workflows, topFailing, topFlaky, topSlowing };
}
