import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/github-accounts', () => ({
  listAccounts: vi.fn(() => []),
  listGhCliAccountsCached: vi.fn(async () => []),
  resolveAccountForRepo: vi.fn(() => null),
  resolveAccountToken: vi.fn(async () => null),
}));
vi.mock('../../src/services/copilot-usage', () => ({
  getGhCliToken: vi.fn(async () => null),
}));

import { ghCliFallbacks } from '../../src/services/github-repo-access';
import { listGhCliAccountsCached } from '../../src/services/github-accounts';
import { getGhCliToken } from '../../src/services/copilot-usage';

describe('ghCliFallbacks', () => {
  beforeEach(() => {
    vi.mocked(listGhCliAccountsCached).mockResolvedValue([
      { host: 'github.com', login: 'other', active: false },
      { host: 'github.com', login: 'active', active: true },
      { host: 'github.com', login: 'Me', active: false },
      { host: 'ghe.example.com', login: 'me', active: true },
    ]);
    vi.mocked(getGhCliToken).mockImplementation(async (login) => `cli-${login}`);
  });

  it('puts the same account first, then the active CLI account, and skips other hosts', async () => {
    const access = { id: 'me', host: 'github.com', login: 'me', token: 'oauth-me', source: 'oauth' as const };
    const fallbacks = await ghCliFallbacks(access, 'github.com');
    expect(fallbacks.map((f) => f.token)).toEqual(['cli-Me', 'cli-active', 'cli-other']);
    expect(fallbacks.every((f) => f.source === 'gh-cli')).toBe(true);
  });

  it('leaves out the token already in use and CLI accounts without a token', async () => {
    vi.mocked(getGhCliToken).mockImplementation(async (login) => (login === 'other' ? null : `cli-${login}`));
    const access = { id: 'me', host: 'github.com', login: 'me', token: 'cli-Me', source: 'gh-cli' as const };
    const fallbacks = await ghCliFallbacks(access, 'github.com');
    expect(fallbacks.map((f) => f.login)).toEqual(['active']);
  });
});
