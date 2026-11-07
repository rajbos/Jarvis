import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getGitHubApiStats,
  githubRequest,
  githubUrlPattern,
  resetGitHubApiStats,
  summarizeGitHubApiCalls,
} from '../../src/services/github-api';
import { GitHubRateLimitError } from '../../src/services/github-fetch';

const realFetch = globalThis.fetch;

function res(status: number, headers: Record<string, string> = {}, body = '{}'): Response {
  return new Response(body, { status, headers });
}

describe('githubUrlPattern', () => {
  it('replaces owner/repo and numeric ids, keeping query keys only', () => {
    expect(githubUrlPattern('https://api.github.com/repos/rajbos/Jarvis/pulls/12')).toBe('/repos/{owner}/{repo}/pulls/{n}');
    expect(githubUrlPattern('https://api.github.com/repos/rajbos/Jarvis/pulls/12/commits?per_page=100&page=2'))
      .toBe('/repos/{owner}/{repo}/pulls/{n}/commits?page&per_page');
    expect(githubUrlPattern('https://api.github.com/repos/o/r/actions/runs?check_suite_id=5&per_page=10'))
      .toBe('/repos/{owner}/{repo}/actions/runs?check_suite_id&per_page');
  });

  it('handles the agent-detection endpoints', () => {
    expect(githubUrlPattern('https://api.github.com/agents/tasks?per_page=100&page=1&is_archived=false'))
      .toBe('/agents/tasks?is_archived&page&per_page');
    expect(githubUrlPattern('https://api.github.com/agents/tasks/9e0c7d2a-1111-2222-3333-444455556666')).toBe('/agents/tasks/{task}');
    expect(githubUrlPattern('https://api.github.com/repositories/123456')).toBe('/repositories/{id}');
    expect(githubUrlPattern('https://api.github.com/graphql')).toBe('/graphql');
    expect(githubUrlPattern('https://api.github.com/notifications/threads/987')).toBe('/notifications/threads/{id}');
  });

  it('replaces shas and uuids anywhere and leaves unknown input alone', () => {
    expect(githubUrlPattern('https://api.github.com/repos/o/r/commits/0123456789abcdef0123456789abcdef01234567/check-runs'))
      .toBe('/repos/{owner}/{repo}/commits/{sha}/check-runs');
    expect(githubUrlPattern('https://api.github.com/users/octocat/repos')).toBe('/users/{user}/repos');
    expect(githubUrlPattern('https://api.github.com/user/repos')).toBe('/user/repos');
    expect(githubUrlPattern('not a url')).toBe('not a url');
  });
});

describe('githubRequest', () => {
  beforeEach(() => {
    resetGitHubApiStats(1000);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('records every call by purpose and pattern with the concrete url', async () => {
    const fetchMock = vi.fn(async () => res(200, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await githubRequest('https://api.github.com/repos/rajbos/Jarvis/pulls/1', {}, { purpose: 'active-sessions' });
    await githubRequest('https://api.github.com/repos/rajbos/Jarvis/pulls/2', {}, { purpose: 'active-sessions' });
    await githubRequest('https://api.github.com/graphql', { method: 'POST' }, { purpose: 'active-sessions' });
    await githubRequest('https://api.github.com/notifications?all=false', {}, { purpose: 'notifications-sync' });

    const stats = getGitHubApiStats();
    expect(stats.total).toBe(4);
    expect(stats.byPurpose).toEqual([
      { purpose: 'active-sessions', count: 3 },
      { purpose: 'notifications-sync', count: 1 },
    ]);
    const pulls = stats.byPattern.find((p) => p.pattern === '/repos/{owner}/{repo}/pulls/{n}');
    expect(pulls).toMatchObject({ purpose: 'active-sessions', method: 'GET', count: 2, lastUrl: 'https://api.github.com/repos/rajbos/Jarvis/pulls/2' });
    expect(stats.recent[2]).toMatchObject({ method: 'POST', pattern: '/graphql', status: 200, rateLimit: { remaining: 4999, limit: 5000 } });
  });

  it('summarizes calls made after a point in time, per purpose', async () => {
    globalThis.fetch = vi.fn(async () => res(200)) as unknown as typeof fetch;
    vi.spyOn(Date, 'now').mockReturnValue(5000);
    await githubRequest('https://api.github.com/repos/a/b/pulls/1', {}, { purpose: 'p1' });
    vi.spyOn(Date, 'now').mockReturnValue(9000);
    await githubRequest('https://api.github.com/repos/a/b/pulls/2', {}, { purpose: 'p1' });
    await githubRequest('https://api.github.com/graphql', { method: 'POST' }, { purpose: 'p2' });

    expect(summarizeGitHubApiCalls(6000)).toBe('2 call(s): p1=1 (GET /repos/{owner}/{repo}/pulls/{n}×1); p2=1 (POST /graphql×1)');
    expect(summarizeGitHubApiCalls(10_000)).toBe('');
  });

  it('records network failures with status 0 and rethrows', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(githubRequest('https://api.github.com/user', {}, { purpose: 'auth' })).rejects.toThrow('offline');
    expect(getGitHubApiStats().recent[0]).toMatchObject({ status: 0, purpose: 'auth', pattern: '/user' });
  });

  it('propagates rate-limit errors from githubFetch', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    globalThis.fetch = vi.fn(async () => res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset })) as unknown as typeof fetch;
    await expect(githubRequest('https://api.github.com/user', {}, { purpose: 'auth' })).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(getGitHubApiStats().total).toBe(1);
  });
});
