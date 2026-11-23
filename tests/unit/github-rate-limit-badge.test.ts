import { describe, it, expect } from 'vitest';
import { purposesForToken } from '../../src/plugins/github-auth/api-usage';
import type { GitHubApiCallStats } from '../../src/plugins/types';

const p = (purpose: string, token: string, pattern: string, count: number) =>
  ({ purpose, token, method: 'GET', pattern, count, lastUrl: '' });

const stats = (byPattern: GitHubApiCallStats['byPattern']): GitHubApiCallStats =>
  ({ total: 0, since: 0, windowMs: 0, byPurpose: [], byToken: [], byPattern });

describe('purposesForToken', () => {
  const s = stats([
    p('auto-dismiss', 'oauth', '/a', 5),
    p('auto-dismiss', 'pat', '/a', 100),
    p('notifications-sync:list', 'oauth', '/b', 3),
    p('notifications-sync:list', 'oauth', '/c', 4),
  ]);

  it('sums only that token\'s pattern groups per purpose, busiest first', () => {
    expect(purposesForToken(s, 'oauth')).toEqual([
      { purpose: 'notifications-sync:list', count: 7 },
      { purpose: 'auto-dismiss', count: 5 },
    ]);
    expect(purposesForToken(s, 'pat')).toEqual([{ purpose: 'auto-dismiss', count: 100 }]);
  });

  it('returns nothing for a token with no calls', () => {
    expect(purposesForToken(s, 'none')).toEqual([]);
  });
});
