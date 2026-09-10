/// <reference path="../../src/types/sql.js.d.ts" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import {
  storeWorkflowRuns,
  storeWorkflowJobs,
  getWorkflowSummaryForRepo,
  fetchWorkflowRuns,
  fetchWorkflowRunJobs,
  extractLogExcerpt,
  type LogExtractionResult,
} from '../../src/services/github-workflows';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRun(id: number, opts: {
  repoFullName?: string;
  workflowName?: string;
  workflowId?: number;
  branch?: string;
  conclusion?: string | null;
  status?: string;
  event?: string;
} = {}): Parameters<typeof storeWorkflowRuns>[2][number] {
  return {
    id,
    name: opts.workflowName ?? 'CI',
    workflow_id: opts.workflowId ?? 42,
    head_branch: opts.branch ?? 'main',
    head_sha: 'abc123',
    event: opts.event ?? 'push',
    status: opts.status ?? 'completed',
    conclusion: 'conclusion' in opts ? opts.conclusion! : 'success',
    run_number: id,
    run_started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    html_url: `https://github.com/owner/repo/actions/runs/${id}`,
  };
}

function makeJob(id: number, runId: number, opts: {
  name?: string;
  status?: string;
  conclusion?: string | null;
} = {}): Parameters<typeof storeWorkflowJobs>[3][number] {
  return {
    id,
    run_id: runId,
    name: opts.name ?? `Job ${id}`,
    status: opts.status ?? 'completed',
    conclusion: opts.conclusion ?? 'success',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    steps: [],
  };
}

// ── extractLogExcerpt ─────────────────────────────────────────────────────────

describe('extractLogExcerpt', () => {
  it('slices the log to the failing step timestamp window and returns its name', () => {
    const text = [
      '2024-01-01T10:00:00.0000000Z Current runner version: 1.2.3',
      '2024-01-01T10:00:01.0000000Z Set up job',
      '2024-01-01T10:00:05.0000000Z Run actions/checkout@v4',
      '2024-01-01T10:00:10.0000000Z Run tests started',
      '2024-01-01T10:00:11.0000000Z FAIL: expected 1 to equal 2',
      '2024-01-01T10:00:12.0000000Z ##[error]Process completed with exit code 1',
      '2024-01-01T10:00:13.0000000Z Post job cleanup',
    ].join('\n');

    const steps = [
      { name: 'Set up job', status: 'completed', conclusion: 'success', number: 1, started_at: '2024-01-01T10:00:00Z', completed_at: '2024-01-01T10:00:05Z' },
      { name: 'Checkout', status: 'completed', conclusion: 'success', number: 2, started_at: '2024-01-01T10:00:05Z', completed_at: '2024-01-01T10:00:10Z' },
      { name: 'Run tests', status: 'completed', conclusion: 'failure', number: 3, started_at: '2024-01-01T10:00:10Z', completed_at: '2024-01-01T10:00:12Z' },
    ];

    const result = extractLogExcerpt(text, steps);
    expect(result.failingStepName).toBe('Run tests');
    expect(result.excerpt).toContain('Run tests started');
    expect(result.excerpt).toContain('FAIL: expected 1 to equal 2');
    expect(result.excerpt).toContain('Process completed with exit code 1');
    expect(result.excerpt).not.toContain('Current runner version');
    expect(result.excerpt).not.toContain('Post job cleanup');
  });

  it('extracts ##[error] annotation lines into errorHighlights regardless of windowing', () => {
    const text = [
      '2024-01-01T10:00:00.0000000Z Current runner version: 1.2.3',
      '2024-01-01T10:00:12.0000000Z ##[error]Process completed with exit code 1',
      '2024-01-01T10:00:13.0000000Z ##[error]Another error annotation',
    ].join('\n');

    const result = extractLogExcerpt(text, []);
    expect(result.errorHighlights).toContain('##[error]Process completed with exit code 1');
    expect(result.errorHighlights).toContain('##[error]Another error annotation');
  });

  it('returns null errorHighlights when no ##[error] lines are present', () => {
    const result = extractLogExcerpt('just a plain log\nwith no annotations', []);
    expect(result.errorHighlights).toBeNull();
  });

  it('falls back to head+tail when there is no failing step', () => {
    const head = 'A'.repeat(2000);
    const tail = 'Z'.repeat(2000);
    const text = `${head}${'-'.repeat(20000)}${tail}`;

    const result = extractLogExcerpt(text, []);
    expect(result.failingStepName).toBeNull();
    expect(result.excerpt).toContain('AAAA');
    expect(result.excerpt).toContain('ZZZZ');
    expect(result.excerpt.length).toBeLessThan(text.length);
  });

  it('falls back to head+tail when step timestamps are missing', () => {
    const head = 'A'.repeat(2000);
    const tail = 'Z'.repeat(2000);
    const text = `${head}${'-'.repeat(20000)}${tail}`;
    const steps = [{ name: 'Run tests', status: 'completed', conclusion: 'failure', number: 1 }];

    const result = extractLogExcerpt(text, steps);
    expect(result.failingStepName).toBeNull();
    expect(result.excerpt).toContain('ZZZZ');
  });

  it('falls back to head+tail when the failing step window matches no timestamped lines', () => {
    const text = 'no timestamps in this log at all, just plain text';
    const steps = [{ name: 'Run tests', status: 'completed', conclusion: 'failure', number: 1, started_at: '2024-01-01T10:00:00Z', completed_at: '2024-01-01T10:00:05Z' }];

    const result = extractLogExcerpt(text, steps);
    expect(result.failingStepName).toBeNull();
    expect(result.excerpt).toBe(text);
  });

  it('returns the full text unmodified when under the byte cap and no failing step', () => {
    const text = 'short log\nwith a couple lines';
    const result = extractLogExcerpt(text, []);
    expect(result.excerpt).toBe(text);
  });
});

// ── storeWorkflowRuns ─────────────────────────────────────────────────────────

describe('storeWorkflowRuns', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('inserts workflow runs into the database', () => {
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1), makeRun(2)]);
    const res = db.exec(`SELECT COUNT(*) FROM github_workflow_runs WHERE repo_full_name = 'owner/repo'`);
    expect(res[0].values[0][0]).toBe(2);
  });

  it('replaces existing runs for the same repo on re-call', () => {
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1), makeRun(2)]);
    storeWorkflowRuns(db, 'owner/repo', [makeRun(3)]);
    const res = db.exec(`SELECT COUNT(*) FROM github_workflow_runs WHERE repo_full_name = 'owner/repo'`);
    expect(res[0].values[0][0]).toBe(1);
  });

  it('does not delete runs for a different repo', () => {
    storeWorkflowRuns(db, 'owner/other', [makeRun(99)]);
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1)]);
    const res = db.exec(`SELECT COUNT(*) FROM github_workflow_runs`);
    expect(res[0].values[0][0]).toBe(2);
  });

  it('stores null conclusion correctly', () => {
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1, { conclusion: null })]);
    const res = db.exec(`SELECT conclusion FROM github_workflow_runs WHERE id = '1'`);
    expect(res[0].values[0][0]).toBeNull();
  });

  it('handles an empty runs array', () => {
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1)]);
    storeWorkflowRuns(db, 'owner/repo', []);
    const res = db.exec(`SELECT COUNT(*) FROM github_workflow_runs WHERE repo_full_name = 'owner/repo'`);
    expect(res[0].values[0][0]).toBe(0);
  });
});

// ── storeWorkflowJobs ─────────────────────────────────────────────────────────

describe('storeWorkflowJobs', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1)]);
  });

  afterEach(() => db.close());

  it('inserts jobs for a workflow run', () => {
    storeWorkflowJobs(db, 'owner/repo', '1', [makeJob(10, 1), makeJob(11, 1)], new Map());
    const res = db.exec(`SELECT COUNT(*) FROM github_workflow_jobs WHERE run_id = '1'`);
    expect(res[0].values[0][0]).toBe(2);
  });

  it('stores log excerpts for jobs that have them', () => {
    const logExcerpts = new Map<string, LogExtractionResult>([
      ['10', { excerpt: 'Error: test failed\nExpected foo but got bar', failingStepName: null, errorHighlights: null }],
    ]);
    storeWorkflowJobs(db, 'owner/repo', '1', [makeJob(10, 1)], logExcerpts);
    const res = db.exec(`SELECT log_excerpt FROM github_workflow_jobs WHERE id = '10'`);
    expect(res[0].values[0][0]).toContain('Error: test failed');
  });

  it('stores failing_step_name and error_highlights alongside the excerpt', () => {
    const logExcerpts = new Map<string, LogExtractionResult>([
      ['10', { excerpt: 'log body', failingStepName: 'Run tests', errorHighlights: '##[error]Test failed' }],
    ]);
    storeWorkflowJobs(db, 'owner/repo', '1', [makeJob(10, 1)], logExcerpts);
    const res = db.exec(`SELECT failing_step_name, error_highlights FROM github_workflow_jobs WHERE id = '10'`);
    expect(res[0].values[0]).toEqual(['Run tests', '##[error]Test failed']);
  });

  it('stores null log_excerpt when no excerpt is provided', () => {
    storeWorkflowJobs(db, 'owner/repo', '1', [makeJob(10, 1)], new Map());
    const res = db.exec(`SELECT log_excerpt FROM github_workflow_jobs WHERE id = '10'`);
    expect(res[0].values[0][0]).toBeNull();
  });

  it('handles an empty jobs array without error', () => {
    expect(() => storeWorkflowJobs(db, 'owner/repo', '1', [], new Map())).not.toThrow();
  });
});

// ── getWorkflowSummaryForRepo ─────────────────────────────────────────────────

describe('getWorkflowSummaryForRepo', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => db.close());

  it('returns empty summary when no runs are stored', () => {
    const summary = getWorkflowSummaryForRepo(db, 'owner/repo');
    expect(summary.repo_full_name).toBe('owner/repo');
    expect(summary.total_runs).toBe(0);
    expect(summary.recent_runs).toHaveLength(0);
    expect(summary.jobs_by_run).toEqual({});
  });

  it('returns correct total_runs count', () => {
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1), makeRun(2), makeRun(3)]);
    const summary = getWorkflowSummaryForRepo(db, 'owner/repo');
    expect(summary.total_runs).toBe(3);
    expect(summary.recent_runs).toHaveLength(3);
  });

  it('includes jobs grouped by run_id', () => {
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1), makeRun(2)]);
    storeWorkflowJobs(db, 'owner/repo', '1', [makeJob(10, 1), makeJob(11, 1)], new Map());
    storeWorkflowJobs(db, 'owner/repo', '2', [makeJob(20, 2)], new Map());

    const summary = getWorkflowSummaryForRepo(db, 'owner/repo');
    expect(summary.jobs_by_run['1']).toHaveLength(2);
    expect(summary.jobs_by_run['2']).toHaveLength(1);
  });

  it('does not return runs for a different repo', () => {
    storeWorkflowRuns(db, 'owner/other', [makeRun(99)]);
    const summary = getWorkflowSummaryForRepo(db, 'owner/repo');
    expect(summary.total_runs).toBe(0);
  });

  it('stores and retrieves failure conclusion correctly', () => {
    storeWorkflowRuns(db, 'owner/repo', [makeRun(1, { conclusion: 'failure' })]);
    const summary = getWorkflowSummaryForRepo(db, 'owner/repo');
    expect(summary.recent_runs[0].conclusion).toBe('failure');
  });
});

// ── fetchWorkflowRuns ─────────────────────────────────────────────────────────

describe('fetchWorkflowRuns', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches and returns workflow runs', async () => {
    const runs = [
      { id: 1, name: 'CI', workflow_id: 42, head_branch: 'main', head_sha: 'abc', event: 'push', status: 'completed', conclusion: 'success', run_number: 1, run_started_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:01:00Z', html_url: 'https://github.com/o/r/actions/runs/1' },
    ];
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ workflow_runs: runs, total_count: 1 }), { status: 200 }),
    );

    const result = await fetchWorkflowRuns('token', 'owner/repo', '2024-01-01');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('throws on non-OK responses', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Forbidden', { status: 403 }),
    );
    await expect(fetchWorkflowRuns('token', 'owner/repo', '2024-01-01')).rejects.toThrow('GitHub API error 403');
  });

  it('follows pagination when a full page is returned', async () => {
    const makePage = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: start + i,
        name: 'CI',
        workflow_id: 42,
        head_branch: 'main',
        head_sha: 'abc',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        run_number: start + i,
        run_started_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:01:00Z',
        html_url: `https://github.com/o/r/actions/runs/${start + i}`,
      }));

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ workflow_runs: makePage(1, 50), total_count: 100 }), { status: 200 });
      }
      return new Response(JSON.stringify({ workflow_runs: makePage(51, 10), total_count: 100 }), { status: 200 });
    });

    const result = await fetchWorkflowRuns('token', 'owner/repo', '2024-01-01');
    expect(result).toHaveLength(60);
    expect(callCount).toBe(2);
  });

  it('stops after two pages even when both pages are full', async () => {
    const makePage = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: start + i,
        name: 'CI',
        workflow_id: 42,
        head_branch: 'main',
        head_sha: 'abc',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        run_number: start + i,
        run_started_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:01:00Z',
        html_url: `https://github.com/o/r/actions/runs/${start + i}`,
      }));

    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ workflow_runs: makePage(1, 50), total_count: 150 }), { status: 200 });
      }
      return new Response(JSON.stringify({ workflow_runs: makePage(51, 50), total_count: 150 }), { status: 200 });
    });

    const result = await fetchWorkflowRuns('token', 'owner/repo', '2024-01-01');
    expect(result).toHaveLength(100);
    expect(callCount).toBe(2);
  });

  it('stops paginating when fewer than 50 runs are returned', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ workflow_runs: [{ id: 1, name: 'CI', workflow_id: 1, head_branch: 'main', head_sha: 'a', event: 'push', status: 'completed', conclusion: 'success', run_number: 1, run_started_at: '', updated_at: '', html_url: '' }], total_count: 1 }), { status: 200 }),
    );

    const result = await fetchWorkflowRuns('token', 'owner/repo', '2024-01-01');
    expect(result).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── fetchWorkflowRunJobs ──────────────────────────────────────────────────────

describe('fetchWorkflowRunJobs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches and returns jobs for a workflow run', async () => {
    const jobs = [
      { id: 10, run_id: 1, name: 'build', status: 'completed', conclusion: 'success', started_at: '2024-01-01T00:00:00Z', completed_at: '2024-01-01T00:05:00Z', steps: [] },
    ];
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ jobs }), { status: 200 }),
    );

    const result = await fetchWorkflowRunJobs('token', 'owner/repo', '1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(10);
  });

  it('throws on non-OK responses', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Not Found', { status: 404 }),
    );
    await expect(fetchWorkflowRunJobs('token', 'owner/repo', '99')).rejects.toThrow('GitHub API error 404');
  });
});

// ── fetchAndStoreWorkflowData ─────────────────────────────────────────────────
import { fetchAndStoreWorkflowData, createGitHubIssue } from '../../src/services/github-workflows';

describe('fetchAndStoreWorkflowData', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('stores runs and returns the count', async () => {
    const run = makeRun(1, { conclusion: 'success' });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ workflow_runs: [run], total_count: 1 }), { status: 200 }),
    );

    const result = await fetchAndStoreWorkflowData(db, 'token', 'owner/repo');
    expect(result.runsStored).toBe(1);

    const res = db.exec(`SELECT COUNT(*) FROM github_workflow_runs`);
    expect(res[0].values[0][0]).toBe(1);
  });

  it('fetches jobs for failing runs', async () => {
    const failRun = makeRun(1, { conclusion: 'failure' });
    const job = makeJob(10, 1, { conclusion: 'failure' });

    let fetchCall = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      fetchCall++;
      if (url.includes('/actions/runs') && !url.includes('/jobs') && !url.includes('/logs')) {
        return new Response(JSON.stringify({ workflow_runs: [failRun], total_count: 1 }), { status: 200 });
      }
      if (url.includes('/jobs')) {
        return new Response(JSON.stringify({ jobs: [job] }), { status: 200 });
      }
      // Log endpoint
      return new Response('log line 1\nlog line 2', { status: 200 });
    });

    await fetchAndStoreWorkflowData(db, 'token', 'owner/repo');
    const res = db.exec(`SELECT COUNT(*) FROM github_workflow_jobs`);
    expect(res[0].values[0][0]).toBe(1);
  });

  it('stores jobs even when failing job log retrieval returns non-OK', async () => {
    const failRun = makeRun(1, { conclusion: 'failure' });
    const failedJob = makeJob(10, 1, { conclusion: 'failure' });
    const successJob = makeJob(11, 1, { conclusion: 'success' });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/actions/runs') && !url.includes('/jobs') && !url.includes('/logs')) {
        return new Response(JSON.stringify({ workflow_runs: [failRun], total_count: 1 }), { status: 200 });
      }
      if (url.includes('/actions/jobs/') && url.includes('/logs')) {
        return new Response('unavailable', { status: 503 });
      }
      if (url.includes('/jobs')) {
        return new Response(JSON.stringify({ jobs: [failedJob, successJob] }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await fetchAndStoreWorkflowData(db, 'token', 'owner/repo');
    const jobs = db.exec(`SELECT id, log_excerpt FROM github_workflow_jobs ORDER BY id ASC`);
    expect(jobs[0].values).toEqual([
      ['10', null],
      ['11', null],
    ]);
  });

  it('handles multiple failing runs from the same workflow', async () => {
    const failRun1 = makeRun(1, { conclusion: 'failure', workflowId: 77 });
    const failRun2 = makeRun(2, { conclusion: 'failure', workflowId: 77 });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/actions/runs') && !url.includes('/jobs') && !url.includes('/logs')) {
        return new Response(JSON.stringify({ workflow_runs: [failRun1, failRun2], total_count: 2 }), { status: 200 });
      }
      if (url.includes('/jobs')) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      return new Response('', { status: 200 });
    });

    const result = await fetchAndStoreWorkflowData(db, 'token', 'owner/repo');
    expect(result.runsStored).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('returns 0 when no runs are found', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ workflow_runs: [], total_count: 0 }), { status: 200 }),
    );

    const result = await fetchAndStoreWorkflowData(db, 'token', 'owner/repo');
    expect(result.runsStored).toBe(0);
  });
});

// ── createGitHubIssue ─────────────────────────────────────────────────────────

describe('createGitHubIssue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the created issue URL on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ html_url: 'https://github.com/owner/repo/issues/42' }), { status: 201 }),
    );

    const result = await createGitHubIssue('token', 'owner/repo', 'Bug report', 'desc', ['bug']);
    expect(result.url).toBe('https://github.com/owner/repo/issues/42');
  });

  it('throws when the API returns a non-OK status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Unprocessable Entity', { status: 422 }),
    );
    await expect(
      createGitHubIssue('token', 'owner/repo', 'Title', 'Body', []),
    ).rejects.toThrow('Failed to create issue: HTTP 422');
  });
});
