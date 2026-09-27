import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  COPILOT_REVIEW_CHECK_NAME,
  evaluatePrReadiness,
  fetchPullRequests,
  isCopilotReviewerLogin,
  prLookupKey,
  type RawPullRequest,
} from '../../src/services/pr-readiness';

const HEAD = 'abcdef1234567890';
const OLD = '0123456789abcdef';

interface Ctx {
  __typename: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

interface PrOpts {
  state?: RawPullRequest['state'];
  isDraft?: boolean;
  contexts?: Ctx[];
  totalCount?: number;
  rollupState?: string;
  noRollup?: boolean;
  copilotRuns?: Array<{ status: string; conclusion: string | null; startedAt?: string }>;
  requested?: string[];
  reviews?: Array<{ login: string; oid: string; state?: string }>;
  committedDate?: string;
}

function makePr(opts: PrOpts = {}): RawPullRequest {
  const contexts = opts.contexts ?? [];
  return {
    number: 42,
    title: 'Add feature',
    url: 'https://github.com/o/r/pull/42',
    state: opts.state ?? 'OPEN',
    isDraft: opts.isDraft ?? false,
    headRefName: 'feature',
    headRefOid: HEAD,
    headRepositoryOwner: { login: 'o' },
    repository: { nameWithOwner: 'o/r' },
    commits: {
      nodes: [{
        commit: {
          oid: HEAD,
          committedDate: opts.committedDate ?? '2026-01-01T00:00:00Z',
          statusCheckRollup: opts.noRollup ? null : {
            state: opts.rollupState ?? 'SUCCESS',
            contexts: { totalCount: opts.totalCount ?? contexts.length, nodes: contexts },
          },
          checkSuites: {
            nodes: [{
              checkRuns: {
                nodes: (opts.copilotRuns ?? []).map((r, i) => ({
                  name: COPILOT_REVIEW_CHECK_NAME,
                  status: r.status,
                  conclusion: r.conclusion,
                  startedAt: r.startedAt ?? `2026-01-01T00:0${i}:00Z`,
                  completedAt: null,
                })),
              },
            }],
          },
        },
      }],
    },
    reviewRequests: {
      nodes: (opts.requested ?? []).map((login) => ({ requestedReviewer: { __typename: 'Bot', login } })),
    },
    reviews: {
      nodes: (opts.reviews ?? []).map((r) => ({
        author: { __typename: 'Bot', login: r.login },
        state: r.state ?? 'COMMENTED',
        submittedAt: '2026-01-01T00:00:00Z',
        commit: { oid: r.oid },
      })),
    },
  };
}

const run = (name: string, status: string, conclusion: string | null = null): Ctx =>
  ({ __typename: 'CheckRun', name, status, conclusion });
const status = (context: string, state: string): Ctx => ({ __typename: 'StatusContext', context, state });

describe('isCopilotReviewerLogin', () => {
  it('matches the known Copilot reviewer logins case-insensitively', () => {
    expect(isCopilotReviewerLogin('copilot-pull-request-reviewer')).toBe(true);
    expect(isCopilotReviewerLogin('copilot-pull-request-reviewer[bot]')).toBe(true);
    expect(isCopilotReviewerLogin('Copilot')).toBe(true);
    expect(isCopilotReviewerLogin('octocat')).toBe(false);
    expect(isCopilotReviewerLogin(null)).toBe(false);
  });
});

describe('evaluatePrReadiness — checks', () => {
  it('is not ready while any check is still running', () => {
    const r = evaluatePrReadiness(makePr({
      contexts: [run('build', 'COMPLETED', 'SUCCESS'), run('test', 'IN_PROGRESS'), status('ci/legacy', 'PENDING')],
    }));
    expect(r.checks.light).toBe('amber');
    expect(r.checks.blocking).toBe(true);
    expect(r.checks.pending).toBe(2);
    expect(r.checks.label).toBe('Running 1/3');
    expect(r.ready).toBe(false);
    expect(r.waitingOn).toEqual(['checks']);
  });

  it('is ready when all checks completed even if some failed (red but non-blocking)', () => {
    const r = evaluatePrReadiness(makePr({
      contexts: [run('build', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'FAILURE'), status('ci/x', 'ERROR')],
    }));
    expect(r.checks.light).toBe('red');
    expect(r.checks.blocking).toBe(false);
    expect(r.checks.failed).toBe(2);
    expect(r.ready).toBe(true);
  });

  it('shows green when every check passed (neutral/skipped count as passing)', () => {
    const r = evaluatePrReadiness(makePr({
      contexts: [run('a', 'COMPLETED', 'SUCCESS'), run('b', 'COMPLETED', 'SKIPPED'), run('c', 'COMPLETED', 'NEUTRAL')],
    }));
    expect(r.checks.light).toBe('green');
    expect(r.checks.passed).toBe(3);
    expect(r.ready).toBe(true);
  });

  it('treats a PR without checks as grey and non-blocking', () => {
    const r = evaluatePrReadiness(makePr({ noRollup: true }));
    expect(r.checks.light).toBe('grey');
    expect(r.checks.blocking).toBe(false);
    expect(r.ready).toBe(true);
  });

  it('waits for checks to register on a freshly pushed commit without checks', () => {
    const checkedAt = '2026-03-01T12:00:00Z';
    const fresh = evaluatePrReadiness(makePr({ noRollup: true, committedDate: '2026-03-01T11:58:00Z' }), checkedAt);
    expect(fresh.checks).toMatchObject({ light: 'amber', label: 'Waiting for checks', blocking: true });
    expect(fresh.ready).toBe(false);
    expect(fresh.waitingOn).toEqual(['checks']);

    const settled = evaluatePrReadiness(makePr({ noRollup: true, committedDate: '2026-03-01T11:50:00Z' }), checkedAt);
    expect(settled.checks).toMatchObject({ light: 'grey', label: 'No checks', blocking: false });
    expect(settled.ready).toBe(true);
  });

  it('excludes the Copilot reviewer check run from the checks light', () => {
    const r = evaluatePrReadiness(makePr({
      contexts: [run('build', 'COMPLETED', 'SUCCESS'), run(COPILOT_REVIEW_CHECK_NAME, 'IN_PROGRESS')],
    }));
    expect(r.checks.total).toBe(1);
    expect(r.checks.light).toBe('green');
  });

  it('falls back to the rollup state for contexts beyond the first page', () => {
    const r = evaluatePrReadiness(makePr({
      contexts: [run('a', 'COMPLETED', 'SUCCESS')],
      totalCount: 150,
      rollupState: 'PENDING',
    }));
    expect(r.checks.blocking).toBe(true);
    expect(r.checks.pending).toBe(149);
  });
});

describe('evaluatePrReadiness — Copilot review', () => {
  it('is not attached when Copilot was never involved', () => {
    const r = evaluatePrReadiness(makePr());
    expect(r.copilotReview.status).toBe('not_requested');
    expect(r.copilotReview.blocking).toBe(false);
    expect(r.ready).toBe(true);
  });

  it('blocks while the Copilot review check run is in progress', () => {
    const r = evaluatePrReadiness(makePr({ copilotRuns: [{ status: 'IN_PROGRESS', conclusion: null }] }));
    expect(r.copilotReview.status).toBe('in_progress');
    expect(r.copilotReview.blocking).toBe(true);
    expect(r.ready).toBe(false);
    expect(r.waitingOn).toEqual(['copilot_review']);
  });

  it('blocks while a Copilot review is requested but has not reviewed the head commit', () => {
    const r = evaluatePrReadiness(makePr({ requested: ['copilot-pull-request-reviewer'] }));
    expect(r.copilotReview.status).toBe('requested');
    expect(r.ready).toBe(false);
  });

  it('is completed when Copilot reviewed the head commit', () => {
    const r = evaluatePrReadiness(makePr({ reviews: [{ login: 'copilot-pull-request-reviewer', oid: HEAD }] }));
    expect(r.copilotReview.status).toBe('completed');
    expect(r.copilotReview.light).toBe('green');
    expect(r.ready).toBe(true);
  });

  it('is completed when the review check run finished on the head commit', () => {
    const r = evaluatePrReadiness(makePr({ copilotRuns: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    expect(r.copilotReview.status).toBe('completed');
    expect(r.ready).toBe(true);
  });

  it('is stale (blocking) when Copilot only reviewed an older commit', () => {
    const r = evaluatePrReadiness(makePr({ reviews: [{ login: 'Copilot', oid: OLD }] }));
    expect(r.copilotReview.status).toBe('stale');
    expect(r.copilotReview.blocking).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('is errored (red, non-blocking) when the review run failed without a review', () => {
    const r = evaluatePrReadiness(makePr({ copilotRuns: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }));
    expect(r.copilotReview.status).toBe('errored');
    expect(r.copilotReview.light).toBe('red');
    expect(r.ready).toBe(true);
  });

  it('uses the most recent review run when several exist', () => {
    const r = evaluatePrReadiness(makePr({
      copilotRuns: [
        { status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T00:00:00Z' },
        { status: 'QUEUED', conclusion: null, startedAt: '2026-01-02T00:00:00Z' },
      ],
    }));
    expect(r.copilotReview.status).toBe('in_progress');
  });

  it('ignores reviews from non-Copilot authors', () => {
    const r = evaluatePrReadiness(makePr({ reviews: [{ login: 'octocat', oid: OLD }] }));
    expect(r.copilotReview.status).toBe('not_requested');
  });
});

describe('evaluatePrReadiness — combined', () => {
  it('waits on both stages at once', () => {
    const r = evaluatePrReadiness(makePr({
      contexts: [run('test', 'QUEUED')],
      copilotRuns: [{ status: 'IN_PROGRESS', conclusion: null }],
    }));
    expect(r.waitingOn).toEqual(['checks', 'copilot_review']);
    expect(r.ready).toBe(false);
  });

  it('never marks a closed or merged PR ready', () => {
    expect(evaluatePrReadiness(makePr({ state: 'MERGED' })).ready).toBe(false);
    expect(evaluatePrReadiness(makePr({ state: 'CLOSED' })).ready).toBe(false);
  });

  it('keeps draft PRs eligible and carries the draft flag', () => {
    const r = evaluatePrReadiness(makePr({ isDraft: true }));
    expect(r.ready).toBe(true);
    expect(r.isDraft).toBe(true);
  });

  it('maps identity fields from the raw PR', () => {
    const r = evaluatePrReadiness(makePr(), '2026-02-02T00:00:00Z');
    expect(r).toMatchObject({
      repoFullName: 'o/r', prNumber: 42, headSha: HEAD, headRef: 'feature', checkedAt: '2026-02-02T00:00:00Z',
    });
  });
});

describe('fetchPullRequests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (body: { query: string; variables: Record<string, unknown> }) => unknown, status = 200) {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      const json = handler(body);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        text: async () => JSON.stringify(json),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('resolves number, branch and node lookups in one aliased request', async () => {
    const pr = makePr();
    const fork = { ...makePr(), number: 7, headRepositoryOwner: { login: 'forker' } };
    const fetchMock = stubFetch((body) => {
      expect(body.query).toContain('q0: repository(owner: $o0, name: $r0) { pullRequest(number: $n0)');
      expect(body.query).toContain('q1: repository(owner: $o1, name: $r1) { pullRequests(headRefName: $b1');
      expect(body.query).toContain('q2: node(id: $id2) { ... on PullRequest');
      expect(body.variables).toMatchObject({ o0: 'o', r0: 'r', n0: 42, b1: 'feature', id2: 'PR_node' });
      return {
        data: {
          q0: { pullRequest: pr },
          q1: { pullRequests: { nodes: [pr, fork] } },
          q2: { ...pr, number: 99 },
        },
      };
    });

    const lookups = [
      { kind: 'number' as const, repoFullName: 'o/r', number: 42 },
      { kind: 'branch' as const, repoFullName: 'o/r', branch: 'feature', headOwner: 'forker' },
      { kind: 'node' as const, nodeId: 'PR_node' },
    ];
    const results = await fetchPullRequests('token', lookups);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init.headers.Authorization).toBe('Bearer token');

    expect(results.get(prLookupKey(lookups[0]))).toEqual({ ok: true, pr });
    // headOwner filter picks the fork's PR, not the same-named upstream branch
    expect(results.get(prLookupKey(lookups[1]))).toMatchObject({ ok: true, pr: { number: 7 } });
    expect(results.get(prLookupKey(lookups[2]))).toMatchObject({ ok: true, pr: { number: 99 } });
  });

  it('returns pr: null when a branch has no open PR', async () => {
    stubFetch(() => ({ data: { q0: { pullRequests: { nodes: [] } } } }));
    const lookup = { kind: 'branch' as const, repoFullName: 'o/r', branch: 'nothing' };
    const results = await fetchPullRequests('token', [lookup]);
    expect(results.get(prLookupKey(lookup))).toEqual({ ok: true, pr: null });
  });

  it('maps per-alias GraphQL errors without failing the rest of the batch', async () => {
    const pr = makePr();
    stubFetch(() => ({
      data: { q0: null, q1: { pullRequest: pr } },
      errors: [{ message: "Could not resolve to a Repository with the name 'x/private'.", path: ['q0'] }],
    }));
    const bad = { kind: 'number' as const, repoFullName: 'x/private', number: 1 };
    const good = { kind: 'number' as const, repoFullName: 'o/r', number: 42 };
    const results = await fetchPullRequests('token', [bad, good]);
    expect(results.get(prLookupKey(bad))).toEqual({ ok: false, error: expect.stringContaining('Could not resolve') });
    expect(results.get(prLookupKey(good))).toEqual({ ok: true, pr });
  });

  it('marks the whole batch failed on an HTTP error', async () => {
    stubFetch(() => ({ message: 'Bad credentials' }), 401);
    const lookup = { kind: 'number' as const, repoFullName: 'o/r', number: 1 };
    const results = await fetchPullRequests('token', [lookup]);
    expect(results.get(prLookupKey(lookup))).toEqual({ ok: false, error: expect.stringContaining('401') });
  });

  it('marks the batch failed when the query itself is rejected', async () => {
    stubFetch(() => ({ errors: [{ message: 'Field does not exist' }] }));
    const lookup = { kind: 'number' as const, repoFullName: 'o/r', number: 1 };
    const results = await fetchPullRequests('token', [lookup]);
    expect(results.get(prLookupKey(lookup))).toEqual({ ok: false, error: 'Field does not exist' });
  });

  it('dedupes lookups and splits them into batches of 10', async () => {
    const fetchMock = stubFetch((body) => {
      const aliases = Object.keys(body.variables).filter((k) => k.startsWith('n'));
      return { data: Object.fromEntries(aliases.map((k) => [`q${k.slice(1)}`, { pullRequest: null }])) };
    });
    const lookups = Array.from({ length: 12 }, (_, i) => ({ kind: 'number' as const, repoFullName: 'o/r', number: i }));
    const results = await fetchPullRequests('token', [...lookups, ...lookups]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.size).toBe(12);
    for (const l of lookups) expect(results.get(prLookupKey(l))).toEqual({ ok: true, pr: null });
  });

  it('makes no request when there is nothing to look up', async () => {
    const fetchMock = stubFetch(() => ({}));
    const results = await fetchPullRequests('token', []);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results.size).toBe(0);
  });
});
