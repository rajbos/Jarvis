import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActiveAgentSession } from '../../src/plugins/types';
import type { RawPullRequest } from '../../src/services/pr-readiness';

vi.mock('../../src/services/local-agent-sessions', () => ({
  discoverCopilotLocalSessions: vi.fn(),
  discoverClaudeLocalSessions: vi.fn(),
}));

vi.mock('../../src/services/git-context', () => ({
  resolveGitContext: vi.fn(),
}));

vi.mock('../../src/services/copilot-agent-tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/copilot-agent-tasks')>();
  return { ...actual, listCopilotAgentTasks: vi.fn(), fetchRepoFullNameById: vi.fn() };
});

vi.mock('../../src/services/pr-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/pr-readiness')>();
  return { ...actual, fetchPullRequests: vi.fn() };
});

import { collectActiveSessions, describeAgentActivity } from '../../src/services/active-sessions';
import { discoverClaudeLocalSessions, discoverCopilotLocalSessions } from '../../src/services/local-agent-sessions';
import { resolveGitContext } from '../../src/services/git-context';
import { fetchRepoFullNameById, listCopilotAgentTasks } from '../../src/services/copilot-agent-tasks';
import { fetchPullRequests, prLookupKey, type PrLookup, type PrLookupResult } from '../../src/services/pr-readiness';

const NOW = Date.parse('2026-03-01T12:00:00Z');

function localSession(overrides: Partial<ActiveAgentSession>): ActiveAgentSession {
  return {
    key: 'local:copilot:s1',
    provider: 'copilot',
    origin: 'local',
    client: 'Copilot app',
    sessionId: 's1',
    title: 'Session',
    cwd: 'C:\\src\\repo',
    repoFullName: null,
    branch: null,
    activity: 'working',
    startedAt: null,
    updatedAt: '2026-03-01T11:00:00Z',
    cloudTaskId: null,
    pid: 1,
    ...overrides,
  };
}

function rawPr(overrides: Partial<RawPullRequest> & { pending?: boolean } = {}): RawPullRequest {
  const { pending, ...rest } = overrides;
  return {
    number: 5,
    title: 'PR title',
    url: 'https://github.com/me/repo/pull/5',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feature',
    headRefOid: 'sha1',
    headRepositoryOwner: { login: 'me' },
    repository: { nameWithOwner: 'me/repo' },
    commits: {
      nodes: [{
        commit: {
          oid: 'sha1',
          statusCheckRollup: {
            state: pending ? 'PENDING' : 'SUCCESS',
            contexts: {
              totalCount: 1,
              nodes: [{ __typename: 'CheckRun', name: 'ci', status: pending ? 'IN_PROGRESS' : 'COMPLETED', conclusion: pending ? null : 'SUCCESS' }],
            },
          },
          checkSuites: { nodes: [] },
        },
      }],
    },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    ...rest,
  };
}

const gitCtx = (branch: string, candidates = ['me/repo']) => ({
  repoRoot: 'C:\\src\\repo',
  branch,
  upstreamBranch: null,
  upstreamRemote: null,
  repoFullName: candidates[0],
  repoCandidates: candidates,
});

function stubPrResults(entries: Array<[PrLookup, PrLookupResult]>) {
  vi.mocked(fetchPullRequests).mockImplementation(async () => new Map(entries.map(([l, r]) => [prLookupKey(l), r])));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [], mirroredTaskIds: new Set() });
  vi.mocked(discoverClaudeLocalSessions).mockResolvedValue([]);
  vi.mocked(listCopilotAgentTasks).mockResolvedValue({ ok: true, tasks: [] });
  vi.mocked(fetchPullRequests).mockResolvedValue(new Map());
  vi.mocked(resolveGitContext).mockReturnValue(null);
});

describe('describeAgentActivity', () => {
  it('never blocks readiness', () => {
    for (const a of ['working', 'queued', 'waiting_for_user', 'idle', 'completed', 'failed', 'unknown'] as const) {
      expect(describeAgentActivity(a).blocking).toBe(false);
    }
  });
});

describe('collectActiveSessions', () => {
  it('lists local sessions without PR data and skips the cloud when not signed in', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [localSession({})], mirroredTaskIds: new Set() });
    vi.mocked(resolveGitContext).mockReturnValue(gitCtx('feature'));

    const snap = await collectActiveSessions({ accessToken: null, now: () => NOW });

    expect(listCopilotAgentTasks).not.toHaveBeenCalled();
    expect(fetchPullRequests).not.toHaveBeenCalled();
    expect(snap.sources.copilotCloud).toMatchObject({ skipped: true });
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].session).toMatchObject({ repoFullName: 'me/repo', branch: 'feature' });
    expect(snap.entries[0].verdictLabel).toBe('Sign in to GitHub to check PR');
  });

  it('links a local session to the open PR on its branch and evaluates readiness', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [localSession({})], mirroredTaskIds: new Set() });
    vi.mocked(resolveGitContext).mockReturnValue(gitCtx('feature'));
    stubPrResults([[{ kind: 'branch', repoFullName: 'me/repo', branch: 'feature' }, { ok: true, pr: rawPr() }]]);

    const snap = await collectActiveSessions({ accessToken: 'tok', now: () => NOW });

    expect(snap.entries[0].pr).toMatchObject({ prNumber: 5, ready: true });
    expect(snap.entries[0].verdict).toBe('ready');
    expect(snap.readyCount).toBe(1);
  });

  it('tries the upstream repo with a head-owner filter for fork branches', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [localSession({})], mirroredTaskIds: new Set() });
    vi.mocked(resolveGitContext).mockReturnValue(gitCtx('feature', ['me/repo', 'org/repo']));
    const upstreamLookup: PrLookup = { kind: 'branch', repoFullName: 'org/repo', branch: 'feature', headOwner: 'me' };
    stubPrResults([
      [{ kind: 'branch', repoFullName: 'me/repo', branch: 'feature' }, { ok: true, pr: null }],
      [upstreamLookup, { ok: true, pr: rawPr({ repository: { nameWithOwner: 'org/repo' }, pending: true }) }],
    ]);

    const snap = await collectActiveSessions({ accessToken: 'tok', now: () => NOW });

    const lookups = vi.mocked(fetchPullRequests).mock.calls[0][1];
    expect(lookups).toContainEqual(upstreamLookup);
    expect(snap.entries[0].session.repoFullName).toBe('org/repo');
    expect(snap.entries[0].verdict).toBe('waiting');
    expect(snap.entries[0].verdictLabel).toBe('Waiting on checks');
  });

  it('does not look up PRs for sessions on a default branch', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [localSession({})], mirroredTaskIds: new Set() });
    vi.mocked(resolveGitContext).mockReturnValue(gitCtx('main'));

    const snap = await collectActiveSessions({ accessToken: 'tok', now: () => NOW });

    expect(vi.mocked(fetchPullRequests).mock.calls[0][1]).toEqual([]);
    expect(snap.entries[0].verdictLabel).toBe('No PR yet');
  });

  it('matches the PR on the local branch name, not the tracked upstream branch', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [localSession({})], mirroredTaskIds: new Set() });
    // A worktree created from origin/main tracks main as its upstream.
    vi.mocked(resolveGitContext).mockReturnValue({ ...gitCtx('feat'), upstreamBranch: 'main', upstreamRemote: 'origin' });

    await collectActiveSessions({ accessToken: 'tok', now: () => NOW });

    expect(vi.mocked(fetchPullRequests).mock.calls[0][1]).toEqual([{ kind: 'branch', repoFullName: 'me/repo', branch: 'feat', headOwner: undefined }]);
  });

  it('adds cloud tasks, skipping ones mirrored from local sessions and resolving repo ids', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [], mirroredTaskIds: new Set(['mirrored']) });
    vi.mocked(fetchRepoFullNameById).mockResolvedValue('me/repo');
    vi.mocked(listCopilotAgentTasks).mockResolvedValue({
      ok: true,
      tasks: [
        { id: 'mirrored', name: 'Local app session', state: 'in_progress', createdAt: null, updatedAt: null, repositoryId: 1, pullRequestNodeIds: [], headRef: null, baseRef: null },
        { id: 'cloud-1', name: 'Cloud work', state: 'in_progress', createdAt: null, updatedAt: '2026-03-01T11:30:00Z', repositoryId: 1, pullRequestNodeIds: ['PR_1'], headRef: 'copilot/x', baseRef: 'main' },
        { id: 'cloud-2', name: 'Branch only', state: 'queued', createdAt: null, updatedAt: null, repositoryId: 1, pullRequestNodeIds: [], headRef: 'copilot/y', baseRef: 'main' },
        { id: 'old', name: 'Old', state: 'completed', createdAt: null, updatedAt: '2026-01-01T00:00:00Z', repositoryId: 1, pullRequestNodeIds: ['PR_old'], headRef: null, baseRef: null },
      ],
    });
    stubPrResults([[{ kind: 'node', nodeId: 'PR_1' }, { ok: true, pr: rawPr({ number: 11 }) }]]);

    const snap = await collectActiveSessions({ accessToken: 'tok', now: () => NOW });

    expect(snap.sources.copilotCloud).toEqual({ ok: true, count: 2 });
    expect(fetchRepoFullNameById).toHaveBeenCalledTimes(1);
    const keys = snap.entries.map((e) => e.session.key);
    expect(keys).toEqual(['cloud:copilot:cloud-1', 'cloud:copilot:cloud-2']);
    expect(snap.entries[0]).toMatchObject({ verdict: 'ready', session: { origin: 'cloud', repoFullName: 'me/repo' } });
    const lookups = vi.mocked(fetchPullRequests).mock.calls[0][1];
    expect(lookups).toContainEqual({ kind: 'branch', repoFullName: 'me/repo', branch: 'copilot/y' });
  });

  it('drops finished cloud tasks whose PR is already merged', async () => {
    vi.mocked(listCopilotAgentTasks).mockResolvedValue({
      ok: true,
      tasks: [{ id: 'done', name: 'Done', state: 'completed', createdAt: null, updatedAt: '2026-03-01T11:00:00Z', repositoryId: null, pullRequestNodeIds: ['PR_m'], headRef: null, baseRef: null }],
    });
    stubPrResults([[{ kind: 'node', nodeId: 'PR_m' }, { ok: true, pr: rawPr({ state: 'MERGED' }) }]]);

    const snap = await collectActiveSessions({ accessToken: 'tok', now: () => NOW });
    expect(snap.entries).toEqual([]);
  });

  it('reports PR lookup errors per session and cloud source errors per source', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({ sessions: [localSession({})], mirroredTaskIds: new Set() });
    vi.mocked(resolveGitContext).mockReturnValue(gitCtx('feature'));
    vi.mocked(listCopilotAgentTasks).mockResolvedValue({ ok: false, status: 403, error: 'Agent tasks API 403' });
    stubPrResults([[{ kind: 'branch', repoFullName: 'me/repo', branch: 'feature' }, { ok: false, error: 'Not accessible' }]]);

    const snap = await collectActiveSessions({ accessToken: 'tok', now: () => NOW });

    expect(snap.sources.copilotCloud).toEqual({ ok: false, count: 0, error: 'Agent tasks API 403' });
    expect(snap.entries[0]).toMatchObject({ prError: 'Not accessible', verdict: 'no_pr' });
  });

  it('keeps going when a local source throws', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockImplementation(() => { throw new Error('EACCES'); });
    vi.mocked(discoverClaudeLocalSessions).mockResolvedValue([localSession({ key: 'local:claude:c', provider: 'claude', client: 'Claude Code', cwd: null })]);

    const snap = await collectActiveSessions({ accessToken: null, now: () => NOW });

    expect(snap.sources.copilotLocal).toEqual({ ok: false, count: 0, error: 'EACCES' });
    expect(snap.entries.map((e) => e.session.provider)).toEqual(['claude']);
  });

  it('sorts ready first, then waiting, then sessions without a PR', async () => {
    vi.mocked(discoverCopilotLocalSessions).mockResolvedValue({
      sessions: [
        localSession({ key: 'a', sessionId: 'a', cwd: 'A' }),
        localSession({ key: 'b', sessionId: 'b', cwd: 'B' }),
        localSession({ key: 'c', sessionId: 'c', cwd: 'C' }),
      ],
      mirroredTaskIds: new Set(),
    });
    vi.mocked(resolveGitContext).mockImplementation((cwd: string) => gitCtx(`branch-${cwd}`));
    stubPrResults([
      [{ kind: 'branch', repoFullName: 'me/repo', branch: 'branch-B' }, { ok: true, pr: rawPr({ number: 2, pending: true }) }],
      [{ kind: 'branch', repoFullName: 'me/repo', branch: 'branch-C' }, { ok: true, pr: rawPr({ number: 3 }) }],
    ]);

    const snap = await collectActiveSessions({ accessToken: 'tok', now: () => NOW });
    expect(snap.entries.map((e) => e.session.key)).toEqual(['c', 'b', 'a']);
  });
});
