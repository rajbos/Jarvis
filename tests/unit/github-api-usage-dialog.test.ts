import { describe, it, expect } from 'vitest';
import { formatSince, purposeRows, tokenLabel } from '../../src/plugins/github-auth/api-usage';
import type { GitHubApiCallStats } from '../../src/plugins/types';

describe('GitHubApiUsageDialog helpers', () => {
  it('splits each feature across credentials and keeps the true totals', () => {
    const stats: GitHubApiCallStats = {
      total: 10,
      since: 0,
      byPurpose: [{ purpose: 'sync', count: 7 }, { purpose: 'sweep', count: 3 }],
      byToken: [{ token: 'oauth', count: 8 }, { token: 'pat', count: 2 }],
      // Capped list: one sync pattern is missing, so the purpose total must come from byPurpose.
      byPattern: [
        { purpose: 'sync', token: 'oauth', method: 'GET', pattern: '/a', count: 4, lastUrl: '' },
        { purpose: 'sync', token: 'pat', method: 'GET', pattern: '/b', count: 2, lastUrl: '' },
        { purpose: 'sweep', token: 'oauth', method: 'POST', pattern: '/graphql', count: 3, lastUrl: '' },
      ],
    };
    expect(purposeRows(stats)).toEqual([
      { purpose: 'sync', total: 7, byToken: { oauth: 4, pat: 2 } },
      { purpose: 'sweep', total: 3, byToken: { oauth: 3 } },
    ]);
  });

  it('names tokens and formats the tally window', () => {
    expect(tokenLabel('oauth')).toBe('OAuth');
    expect(tokenLabel('pat')).toBe('PAT');
    expect(tokenLabel('gh-cli:me')).toBe('gh-cli:me');
    expect(tokenLabel('none')).toBe('No token');
    expect(formatSince(0, 30 * 60_000)).toBe('30 min');
    expect(formatSince(0, 3 * 60 * 60_000 + 5 * 60_000)).toBe('3 h 5 min');
    expect(formatSince(0, 3 * 24 * 60 * 60_000)).toBe('3 d');
  });
});
