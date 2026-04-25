// ── GitHub Actions workflow run fetching & caching ───────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import type { WorkflowRun, WorkflowJob, WorkflowRunSummary } from '../plugins/types';

const GITHUB_API_BASE = 'https://api.github.com';

// Max log bytes to store per job — keeps the DB size manageable
const MAX_LOG_BYTES = 10000;
// Only fetch logs for the most recent N failing runs per workflow
const MAX_FAILING_RUNS_FOR_LOGS = 5;

// ── GitHub API response shapes ────────────────────────────────────────────────

interface GitHubWorkflowRun {
  id: number;
  name: string;
  path: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  run_started_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubWorkflowJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  steps: Array<{ name: string; status: string; conclusion: string | null; number: number }>;
}

// ── Low-level GitHub API helpers ──────────────────────────────────────────────

async function githubGet<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API error ${response.status}: ${url}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Fetch the first MAX_LOG_BYTES characters of a job's log file.
 * GitHub redirects to a pre-signed URL; we follow it and read the stream.
 */
async function fetchJobLogExcerpt(
  accessToken: string,
  repoFullName: string,
  jobId: string,
): Promise<string> {
  const logUrl = `${GITHUB_API_BASE}/repos/${repoFullName}/actions/jobs/${jobId}/logs`;
  const response = await fetch(logUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  });
  if (!response.ok) return '';
  const text = await response.text();
  return text.slice(0, MAX_LOG_BYTES);
}

// ── Public fetch functions ────────────────────────────────────────────────────

/**
 * Fetch workflow runs for a repo created since `since` (ISO 8601 string).
 * Fetches up to 2 pages (100 runs) — sufficient for a 7-day window.
 */
export async function fetchWorkflowRuns(
  accessToken: string,
  repoFullName: string,
  since: string,
): Promise<GitHubWorkflowRun[]> {
  const runs: GitHubWorkflowRun[] = [];
  let url: string | null =
    `${GITHUB_API_BASE}/repos/${repoFullName}/actions/runs?per_page=50&created=>${since}`;
  let pages = 0;

  while (url !== null && pages < 2) {
    const currentUrl: string = url;
    const data = await githubGet<{ workflow_runs: GitHubWorkflowRun[]; total_count: number }>(
      currentUrl,
      accessToken,
    );
    runs.push(...data.workflow_runs);
    pages++;
    // Advance page if we got a full page, otherwise stop
    if (data.workflow_runs.length === 50) {
      url = currentUrl.includes('page=')
        ? currentUrl.replace(/page=\d+/, (m) => `page=${parseInt(m.split('=')[1]) + 1}`)
        : `${currentUrl}&page=2`;
    } else {
      url = null;
    }
  }

  return runs;
}

/**
 * Fetch failed jobs for a specific workflow run.
 */
export async function fetchWorkflowRunJobs(
  accessToken: string,
  repoFullName: string,
  runId: string,
): Promise<GitHubWorkflowJob[]> {
  const url = `${GITHUB_API_BASE}/repos/${repoFullName}/actions/runs/${runId}/jobs?per_page=30&filter=all`;
  const data = await githubGet<{ jobs: GitHubWorkflowJob[] }>(url, accessToken);
  // Return ALL jobs so the LLM can see which steps passed vs failed in each run
  return data.jobs;
}

// ── DB persistence ────────────────────────────────────────────────────────────

export function storeWorkflowRuns(
  db: SqlJsDatabase,
  repoFullName: string,
  runs: GitHubWorkflowRun[],
): void {
  // Remove stale cached runs for this repo before inserting fresh data
  db.run('DELETE FROM github_workflow_runs WHERE repo_full_name = ?', [repoFullName]);

  for (const r of runs) {
    db.run(
      `INSERT OR REPLACE INTO github_workflow_runs
        (id, repo_full_name, workflow_name, workflow_id, workflow_path, head_branch, head_sha, event,
         status, conclusion, run_number, run_started_at, updated_at, html_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        String(r.id),
        repoFullName,
        r.name ?? null,
        String(r.workflow_id),
        r.path ?? null,
        r.head_branch ?? null,
        r.head_sha ?? null,
        r.event ?? null,
        r.status ?? null,
        r.conclusion ?? null,
        r.run_number ?? null,
        r.run_started_at ?? null,
        r.updated_at ?? null,
        r.html_url ?? null,
      ],
    );
  }
}

export function storeWorkflowJobs(
  db: SqlJsDatabase,
  repoFullName: string,
  runId: string,
  jobs: GitHubWorkflowJob[],
  logExcerpts: Map<string, string>,
): void {
  for (const j of jobs) {
    db.run(
      `INSERT OR REPLACE INTO github_workflow_jobs
        (id, run_id, repo_full_name, name, status, conclusion,
         started_at, completed_at, log_excerpt, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        String(j.id),
        runId,
        repoFullName,
        j.name ?? null,
        j.status ?? null,
        j.conclusion ?? null,
        j.started_at ?? null,
        j.completed_at ?? null,
        logExcerpts.get(String(j.id)) ?? null,
      ],
    );
  }
}

// ── High-level fetch + store ──────────────────────────────────────────────────

/**
 * Fetch and cache workflow runs + job details for a repo.
 * Fetches runs from the last 7 days, then for failing runs fetches job details
 * and log excerpts (capped at MAX_FAILING_RUNS_FOR_LOGS per workflow).
 */
export async function fetchAndStoreWorkflowData(
  db: SqlJsDatabase,
  accessToken: string,
  repoFullName: string,
): Promise<{ runsStored: number }> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const runs = await fetchWorkflowRuns(accessToken, repoFullName, since);
  storeWorkflowRuns(db, repoFullName, runs);

  // Group failing runs by workflow_id to limit log fetches
  const failingByWorkflow = new Map<string, GitHubWorkflowRun[]>();
  for (const r of runs) {
    if (r.conclusion === 'failure') {
      const key = String(r.workflow_id);
      if (!failingByWorkflow.has(key)) failingByWorkflow.set(key, []);
      failingByWorkflow.get(key)!.push(r);
    }
  }

  for (const [, failingRuns] of failingByWorkflow) {
    const toFetch = failingRuns.slice(0, MAX_FAILING_RUNS_FOR_LOGS);
    for (const run of toFetch) {
      const runId = String(run.id);
      const jobs = await fetchWorkflowRunJobs(accessToken, repoFullName, runId);
      const logExcerpts = new Map<string, string>();

      for (const job of jobs) {
        if (job.conclusion === 'failure') {
          const excerpt = await fetchJobLogExcerpt(accessToken, repoFullName, String(job.id));
          if (excerpt) logExcerpts.set(String(job.id), excerpt);
        }
      }

      storeWorkflowJobs(db, repoFullName, runId, jobs, logExcerpts);
    }
  }

  return { runsStored: runs.length };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Returns a structured workflow run summary for use in agent context assembly.
 * Shows the last 7 days of runs with associated failed job details.
 */
export function getWorkflowSummaryForRepo(
  db: SqlJsDatabase,
  repoFullName: string,
): WorkflowRunSummary {
  const runStmt = db.prepare(`
    SELECT id, repo_full_name, workflow_name, workflow_id, head_branch, head_sha,
           event, status, conclusion, run_number, run_started_at, updated_at, html_url, workflow_path, fetched_at
    FROM github_workflow_runs
    WHERE repo_full_name = ?
    ORDER BY run_started_at DESC
    LIMIT 50
  `);
  runStmt.bind([repoFullName]);

  const recentRuns: WorkflowRun[] = [];
  while (runStmt.step()) {
    recentRuns.push(runStmt.getAsObject() as unknown as WorkflowRun);
  }
  runStmt.free();

  const jobStmt = db.prepare(`
    SELECT id, run_id, repo_full_name, name, status, conclusion,
           started_at, completed_at, log_excerpt, fetched_at
    FROM github_workflow_jobs
    WHERE repo_full_name = ?
    ORDER BY started_at ASC
  `);
  jobStmt.bind([repoFullName]);

  const jobsByRun: Record<string, WorkflowJob[]> = {};
  while (jobStmt.step()) {
    const job = jobStmt.getAsObject() as unknown as WorkflowJob;
    const key = job.run_id;
    if (!jobsByRun[key]) jobsByRun[key] = [];
    jobsByRun[key].push(job);
  }
  jobStmt.free();

  return {
    repo_full_name: repoFullName,
    total_runs: recentRuns.length,
    recent_runs: recentRuns,
    jobs_by_run: jobsByRun,
  };
}

/**
 * Create a GitHub issue in the given repo.
 * Returns the created issue URL on success.
 */
export async function createGitHubIssue(
  accessToken: string,
  repoFullName: string,
  title: string,
  body: string,
  labels: string[],
): Promise<{ url: string }> {
  const response = await fetch(`${GITHUB_API_BASE}/repos/${repoFullName}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create issue: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { html_url: string };
  return { url: data.html_url };
}
