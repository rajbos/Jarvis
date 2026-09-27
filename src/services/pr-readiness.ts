// ── PR review readiness ───────────────────────────────────────────────────────
// Decides whether a pull request is ready for a human reviewer:
//   1. every check on the head commit has completed (pass or fail), and
//   2. if a Copilot code review is attached to the PR, it has finished on the
//      head commit (a review of an older commit is "stale" → not ready).
//
// All PR data is fetched with batched GraphQL queries (one request per sweep
// for up to BATCH_SIZE lookups) and evaluated by the pure evaluatePrReadiness().

import type { CopilotReviewStatus, PrReadiness, ReadinessStage } from '../plugins/types';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const BATCH_SIZE = 10;

/** Check-run name GitHub uses for the Copilot code review agent. */
export const COPILOT_REVIEW_CHECK_NAME = 'copilot-pull-request-reviewer';
const COPILOT_REVIEWER_LOGINS = new Set(['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]', 'copilot']);

export function isCopilotReviewerLogin(login: string | null | undefined): boolean {
  return !!login && COPILOT_REVIEWER_LOGINS.has(login.toLowerCase());
}

// Team{…} is deliberately not selected — it requires read:org and fails otherwise.
const PR_FIELDS = `
  number title url state isDraft headRefName headRefOid
  headRepositoryOwner { login }
  repository { nameWithOwner }
  commits(last: 1) {
    nodes {
      commit {
        oid
        committedDate
        statusCheckRollup {
          state
          contexts(first: 100) {
            totalCount
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
        checkSuites(first: 50) {
          nodes {
            checkRuns(first: 5, filterBy: { checkName: "${COPILOT_REVIEW_CHECK_NAME}" }) {
              nodes { name status conclusion startedAt completedAt }
            }
          }
        }
      }
    }
  }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on Bot { login } ... on User { login } } }
  }
  reviews(last: 30) {
    nodes { author { __typename login } state submittedAt commit { oid } }
  }
`;

// ── Raw GraphQL shapes ────────────────────────────────────────────────────────

interface RawContext {
  __typename: 'CheckRun' | 'StatusContext' | string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  headRepositoryOwner: { login: string } | null;
  repository: { nameWithOwner: string };
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        /** Absent in older fixtures / cached payloads. */
        committedDate?: string | null;
        statusCheckRollup: {
          state: string;
          contexts: { totalCount: number; nodes: RawContext[] };
        } | null;
        checkSuites: { nodes: Array<{ checkRuns: { nodes: RawCheckRun[] } | null }> } | null;
      };
    }>;
  };
  reviewRequests: { nodes: Array<{ requestedReviewer: { __typename: string; login?: string } | null }> };
  reviews: { nodes: Array<{ author: { __typename: string; login: string } | null; state: string; submittedAt: string | null; commit: { oid: string } | null }> };
}

// ── Pure evaluation ───────────────────────────────────────────────────────────

const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
/** Checks can take a little while to register after a push — don't call the PR "check-free" too early. */
export const CHECKS_REGISTRATION_GRACE_MS = 5 * 60 * 1000;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function evaluateChecks(pr: RawPullRequest, nowMs: number): PrReadiness['checks'] {
  const commit = pr.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup ?? null;
  const rawContexts = rollup?.contexts.nodes ?? [];
  const contexts = rawContexts.filter(
    (c) => !(c.__typename === 'CheckRun' && c.name === COPILOT_REVIEW_CHECK_NAME),
  );
  const excluded = rawContexts.length - contexts.length;

  let pending = 0;
  let failed = 0;
  let passed = 0;
  const pendingNames: string[] = [];
  const failedNames: string[] = [];
  for (const c of contexts) {
    if (c.__typename === 'CheckRun') {
      if (c.status !== 'COMPLETED') {
        pending++;
        pendingNames.push(c.name ?? 'check');
      } else if (c.conclusion && PASSING_CONCLUSIONS.has(c.conclusion)) {
        passed++;
      } else {
        failed++;
        failedNames.push(c.name ?? 'check');
      }
    } else if (c.__typename === 'StatusContext') {
      if (c.state === 'PENDING' || c.state === 'EXPECTED') {
        pending++;
        pendingNames.push(c.context ?? 'status');
      } else if (c.state === 'SUCCESS') {
        passed++;
      } else {
        failed++;
        failedNames.push(c.context ?? 'status');
      }
    }
  }

  // More than 100 contexts: trust the rollup for the ones we didn't page through.
  const total = Math.max((rollup?.contexts.totalCount ?? 0) - excluded, contexts.length);
  if (total > contexts.length && pending === 0 && (rollup?.state === 'PENDING' || rollup?.state === 'EXPECTED')) {
    pending = total - contexts.length;
  }

  const list = (names: string[]) => names.slice(0, 5).join(', ') + (names.length > 5 ? ', …' : '');
  if (pending > 0) {
    return {
      light: 'amber', label: `Running ${total - pending}/${total}`, blocking: true,
      detail: `Waiting on ${pending} check${pending === 1 ? '' : 's'}${pendingNames.length ? `: ${list(pendingNames)}` : ''}`,
      total, pending, failed, passed,
    };
  }
  if (total === 0) {
    const committedAt = Date.parse(commit?.committedDate ?? '');
    if (Number.isFinite(committedAt) && nowMs - committedAt < CHECKS_REGISTRATION_GRACE_MS) {
      return {
        light: 'amber', label: 'Waiting for checks', blocking: true,
        detail: `${shortSha(pr.headRefOid)} was just pushed — waiting for checks to register.`,
        total, pending, failed, passed,
      };
    }
    return {
      light: 'grey', label: 'No checks', blocking: false,
      detail: `No checks reported on ${shortSha(pr.headRefOid)}.`,
      total, pending, failed, passed,
    };
  }
  if (failed > 0) {
    return {
      light: 'red', label: `${failed} failed`, blocking: false,
      detail: `All checks finished; ${failed} failed: ${list(failedNames)}`,
      total, pending, failed, passed,
    };
  }
  return {
    light: 'green', label: 'Passed', blocking: false,
    detail: `All ${total} check${total === 1 ? '' : 's'} passed on ${shortSha(pr.headRefOid)}.`,
    total, pending, failed, passed,
  };
}

function evaluateCopilotReview(pr: RawPullRequest): PrReadiness['copilotReview'] {
  const head = pr.headRefOid;
  const commit = pr.commits.nodes[0]?.commit;

  const runs = (commit?.checkSuites?.nodes ?? [])
    .flatMap((s) => s.checkRuns?.nodes ?? [])
    .filter((r) => r.name === COPILOT_REVIEW_CHECK_NAME)
    .sort((a, b) => (Date.parse(b.startedAt ?? '') || 0) - (Date.parse(a.startedAt ?? '') || 0));
  const latestRun = runs[0] ?? null;

  const requested = pr.reviewRequests.nodes.some((n) => isCopilotReviewerLogin(n.requestedReviewer?.login));
  const copilotReviews = pr.reviews.nodes.filter((r) => isCopilotReviewerLogin(r.author?.login));
  const reviewedHead = copilotReviews.some((r) => r.commit?.oid === head);

  const stage = (status: CopilotReviewStatus, light: ReadinessStage['light'], label: string, detail: string, blocking: boolean) =>
    ({ status, light, label, detail, blocking });

  if (latestRun && latestRun.status !== 'COMPLETED') {
    return stage('in_progress', 'amber', 'Reviewing', `Copilot is reviewing ${shortSha(head)}.`, true);
  }
  if (requested && !reviewedHead) {
    return stage('requested', 'amber', 'Requested', 'Copilot review requested — waiting for it to start.', true);
  }
  if (latestRun && latestRun.conclusion && !PASSING_CONCLUSIONS.has(latestRun.conclusion) && !reviewedHead) {
    return stage('errored', 'red', 'Errored', `Copilot review run on ${shortSha(head)} ended with ${latestRun.conclusion.toLowerCase()}.`, false);
  }
  if (reviewedHead || latestRun) {
    return stage('completed', 'green', 'Reviewed', `Copilot reviewed the latest commit ${shortSha(head)}.`, false);
  }
  if (copilotReviews.length > 0) {
    const last = copilotReviews[copilotReviews.length - 1];
    const on = last.commit?.oid ? ` (last reviewed ${shortSha(last.commit.oid)})` : '';
    return stage('stale', 'amber', 'Stale', `Latest commit ${shortSha(head)} has not been reviewed by Copilot${on}. Re-request the Copilot review.`, true);
  }
  return stage('not_requested', 'grey', 'Not attached', 'No Copilot code review attached to this PR.', false);
}

export function evaluatePrReadiness(pr: RawPullRequest, checkedAt: string = new Date().toISOString()): PrReadiness {
  const checks = evaluateChecks(pr, Date.parse(checkedAt) || Date.now());
  const copilotReview = evaluateCopilotReview(pr);
  const waitingOn: PrReadiness['waitingOn'] = [];
  if (checks.blocking) waitingOn.push('checks');
  if (copilotReview.blocking) waitingOn.push('copilot_review');
  return {
    repoFullName: pr.repository.nameWithOwner,
    prNumber: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    headSha: pr.headRefOid,
    headRef: pr.headRefName,
    checks,
    copilotReview,
    ready: pr.state === 'OPEN' && waitingOn.length === 0,
    waitingOn,
    checkedAt,
  };
}

// ── Batched fetching ──────────────────────────────────────────────────────────

export type PrLookup =
  | { kind: 'number'; repoFullName: string; number: number }
  | { kind: 'branch'; repoFullName: string; branch: string; headOwner?: string }
  | { kind: 'node'; nodeId: string };

export function prLookupKey(lookup: PrLookup): string {
  switch (lookup.kind) {
    case 'number': return `n:${lookup.repoFullName.toLowerCase()}#${lookup.number}`;
    case 'branch': return `b:${lookup.repoFullName.toLowerCase()}@${lookup.branch}@${(lookup.headOwner ?? '').toLowerCase()}`;
    case 'node': return `id:${lookup.nodeId}`;
  }
}

export type PrLookupResult =
  | { ok: true; pr: RawPullRequest | null }
  | { ok: false; error: string };

interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

function buildBatchQuery(lookups: PrLookup[]): { query: string; variables: Record<string, unknown> } {
  const varDefs: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, unknown> = {};

  lookups.forEach((lookup, i) => {
    const alias = `q${i}`;
    if (lookup.kind === 'node') {
      varDefs.push(`$id${i}: ID!`);
      variables[`id${i}`] = lookup.nodeId;
      fields.push(`${alias}: node(id: $id${i}) { ... on PullRequest { ${PR_FIELDS} } }`);
      return;
    }
    const [owner, name] = lookup.repoFullName.split('/');
    varDefs.push(`$o${i}: String!`, `$r${i}: String!`);
    variables[`o${i}`] = owner;
    variables[`r${i}`] = name;
    if (lookup.kind === 'number') {
      varDefs.push(`$n${i}: Int!`);
      variables[`n${i}`] = lookup.number;
      fields.push(`${alias}: repository(owner: $o${i}, name: $r${i}) { pullRequest(number: $n${i}) { ${PR_FIELDS} } }`);
    } else {
      varDefs.push(`$b${i}: String!`);
      variables[`b${i}`] = lookup.branch;
      fields.push(
        `${alias}: repository(owner: $o${i}, name: $r${i}) { pullRequests(headRefName: $b${i}, states: [OPEN], first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } } }`,
      );
    }
  });

  return { query: `query(${varDefs.join(', ')}) {\n${fields.join('\n')}\n}`, variables };
}

function extractPr(lookup: PrLookup, value: unknown): RawPullRequest | null {
  if (!value || typeof value !== 'object') return null;
  if (lookup.kind === 'node') {
    const pr = value as Partial<RawPullRequest>;
    return typeof pr.number === 'number' ? (pr as RawPullRequest) : null;
  }
  if (lookup.kind === 'number') {
    return ((value as { pullRequest?: RawPullRequest | null }).pullRequest) ?? null;
  }
  const nodes = (value as { pullRequests?: { nodes?: RawPullRequest[] } }).pullRequests?.nodes ?? [];
  const owner = lookup.headOwner?.toLowerCase();
  return nodes.find((n) => !owner || n.headRepositoryOwner?.login.toLowerCase() === owner) ?? null;
}

/**
 * Resolve many PR lookups with as few GraphQL requests as possible. Results
 * are keyed by {@link prLookupKey}. A lookup that GitHub rejects (e.g. repo
 * not accessible) yields `{ ok: false }` without failing the rest of the batch.
 */
export async function fetchPullRequests(accessToken: string, lookups: PrLookup[]): Promise<Map<string, PrLookupResult>> {
  const results = new Map<string, PrLookupResult>();
  const unique = new Map<string, PrLookup>();
  for (const l of lookups) unique.set(prLookupKey(l), l);
  const all = [...unique.values()];

  for (let start = 0; start < all.length; start += BATCH_SIZE) {
    const batch = all.slice(start, start + BATCH_SIZE);
    const { query, variables } = buildBatchQuery(batch);
    let body: GraphQLResponse;
    try {
      const response = await fetch(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`GitHub GraphQL API error ${response.status}: ${text.slice(0, 200)}`);
      }
      body = (await response.json()) as GraphQLResponse;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const l of batch) results.set(prLookupKey(l), { ok: false, error });
      continue;
    }

    const errorsByAlias = new Map<string, string>();
    for (const e of body.errors ?? []) {
      const alias = typeof e.path?.[0] === 'string' ? e.path[0] : '*';
      errorsByAlias.set(alias, e.message);
    }

    batch.forEach((lookup, i) => {
      const alias = `q${i}`;
      const value = body.data?.[alias];
      const error = errorsByAlias.get(alias) ?? (body.data ? undefined : errorsByAlias.get('*'));
      if (error && !value) {
        results.set(prLookupKey(lookup), { ok: false, error });
      } else {
        results.set(prLookupKey(lookup), { ok: true, pr: extractPr(lookup, value) });
      }
    });
  }

  return results;
}
