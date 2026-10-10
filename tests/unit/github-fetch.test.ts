import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  githubFetch,
  GitHubRateLimitError,
  isRateLimited,
  parseRateLimit,
  rateLimitResourceForUrl,
} from '../../src/services/github-fetch';

const realFetch = globalThis.fetch;

function res(status: number, headers: Record<string, string> = {}, body = '{}'): Response {
  return new Response(body, { status, headers });
}

const SECONDARY_BODY = JSON.stringify({
  message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
});

describe('github-fetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it('parses rate-limit headers including the resource bucket', () => {
    const info = parseRateLimit(
      new Headers({
        'x-ratelimit-remaining': '29',
        'x-ratelimit-limit': '30',
        'x-ratelimit-reset': '123',
        'x-ratelimit-resource': 'search',
      }),
    );
    expect(info).toEqual({ remaining: 29, limit: 30, reset: 123, resource: 'search' });
  });

  it('returns null instead of a fake 5000/5000 when rate-limit headers are missing', () => {
    expect(parseRateLimit(new Headers())).toBeNull();
    expect(parseRateLimit(new Headers({ 'x-ratelimit-limit': '5000' }))).toBeNull();
    expect(parseRateLimit(new Headers({ 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '123' }))).toEqual({
      remaining: 7,
      limit: 7,
      reset: 123,
    });
  });

  it('maps URLs to the rate-limit bucket they are billed against', () => {
    expect(rateLimitResourceForUrl('https://api.github.com/user/repos?per_page=100')).toBe('core');
    expect(rateLimitResourceForUrl('https://api.github.com/search/issues?q=x')).toBe('search');
    expect(rateLimitResourceForUrl('https://api.github.com/search/code?q=x')).toBe('code_search');
    expect(rateLimitResourceForUrl('https://api.github.com/graphql')).toBe('graphql');
    expect(rateLimitResourceForUrl('https://ghe.example.com/api/v3/search/issues?q=x')).toBe('search');
  });

  it('detects secondary rate limits on 403 with budget remaining', async () => {
    const withBody = res(403, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000' }, SECONDARY_BODY);
    expect(await isRateLimited(withBody, parseRateLimit(withBody.headers))).toBe(true);
    // The body is read from a clone, so the caller can still consume it.
    expect(await withBody.text()).toBe(SECONDARY_BODY);

    const withRetryAfter = res(403, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'retry-after': '30' });
    expect(await isRateLimited(withRetryAfter, parseRateLimit(withRetryAfter.headers))).toBe(true);

    const forbidden = res(403, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000' }, '{"message":"Resource not accessible"}');
    expect(await isRateLimited(forbidden, parseRateLimit(forbidden.headers))).toBe(false);
  });

  it('waits and retries on a secondary rate limit without retry-after', async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce(res(403, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000' }, SECONDARY_BODY))
      .mockResolvedValueOnce(res(200));
    globalThis.fetch = fn as unknown as typeof fetch;
    const p = githubFetch('https://api.github.com/x', {}, { maxWaitMs: 120_000 });
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await p).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws GitHubRateLimitError on a secondary rate limit longer than maxWaitMs', async () => {
    const fn = vi.fn(async () => res(403, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000' }, SECONDARY_BODY));
    globalThis.fetch = fn as unknown as typeof fetch;
    await expect(githubFetch('https://api.github.com/x', {}, { maxWaitMs: 10_000 })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('only reports rate-limit info to onRateLimit when the headers are present', async () => {
    const onRateLimit = vi.fn();
    globalThis.fetch = vi.fn(async () => res(200)) as unknown as typeof fetch;
    await githubFetch('https://api.github.com/x', {}, { onRateLimit });
    expect(onRateLimit).not.toHaveBeenCalled();
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
