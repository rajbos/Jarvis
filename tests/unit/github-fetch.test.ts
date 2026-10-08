import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { githubFetch, GitHubRateLimitError, parseRateLimit } from '../../src/services/github-fetch';

const realFetch = globalThis.fetch;

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers });
}

describe('github-fetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it('parses rate-limit headers with defaults', () => {
    const info = parseRateLimit(new Headers({ 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '123' }));
    expect(info).toEqual({ remaining: 7, limit: 5000, reset: 123 });
  });

  it('returns normal responses without retrying', async () => {
    const fn = vi.fn(async () => res(200));
    globalThis.fetch = fn as unknown as typeof fetch;
    const r = await githubFetch('https://api.github.com/x', {});
    expect(r.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits and retries on 403 with remaining 0', async () => {
    const reset = Math.floor(Date.now() / 1000) + 5;
    const fn = vi
      .fn()
      .mockResolvedValueOnce(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }))
      .mockResolvedValueOnce(res(200));
    globalThis.fetch = fn as unknown as typeof fetch;
    const p = githubFetch('https://api.github.com/x', {});
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honours retry-after on 429', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(res(200));
    globalThis.fetch = fn as unknown as typeof fetch;
    const p = githubFetch('https://api.github.com/x', {});
    await vi.advanceTimersByTimeAsync(3_500);
    expect((await p).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a genuine 404, 401 or non-exhausted 403', async () => {
    const cases: Array<[number, Record<string, string>]> = [
      [404, {}],
      [401, {}],
      [403, { 'x-ratelimit-remaining': '42' }],
    ];
    for (const [status, headers] of cases) {
      const fn = vi.fn(async () => res(status, headers));
      globalThis.fetch = fn as unknown as typeof fetch;
      const r = await githubFetch('https://api.github.com/x', {});
      expect(r.status).toBe(status);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('throws GitHubRateLimitError without sleeping when the reset is too far away', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const fn = vi.fn(async () => res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    globalThis.fetch = fn as unknown as typeof fetch;
    await expect(githubFetch('https://api.github.com/x', {})).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const reset = Math.floor(Date.now() / 1000) + 1;
    const fn = vi.fn(async () => res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
    globalThis.fetch = fn as unknown as typeof fetch;
    const assertion = expect(githubFetch('https://api.github.com/x', {})).rejects.toBeInstanceOf(GitHubRateLimitError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
