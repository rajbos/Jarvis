import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/copilot-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/copilot-usage')>();
  return { ...actual, fetchAiCreditUsage: vi.fn(), fetchCopilotQuota: vi.fn() };
});

import { fetchAiCreditUsage, fetchCopilotQuota } from '../../src/services/copilot-usage';
import { fetchAccountCopilotUsage } from '../../src/plugins/copilot-usage/account-usage';

const mockQuota = vi.mocked(fetchCopilotQuota);
const mockBilling = vi.mocked(fetchAiCreditUsage);
const now = new Date('2026-09-16T00:00:00Z');
const quota = {
  login: 'alice-work', plan: 'business', creditsUsed: 300, entitlementCredits: 1000,
  remainingCredits: 700, unlimited: false, resetsAt: Date.UTC(2026, 9, 1) / 1000,
};
const summary = (n: number) => ({ creditsUsed: n, includedCreditsUsed: n, billedCredits: 0, billedAmountUsd: 0, byModel: [] });
const none = { ghToken: null, oauth: null, pat: null };

describe('fetchAccountCopilotUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is not configured without any credential', async () => {
    const usage = await fetchAccountCopilotUsage({ login: 'alice', ...none }, 500, now);
    expect(usage).toMatchObject({ configured: false, login: 'alice', budgetCredits: 500 });
  });

  it('reads the quota with the account-specific GitHub CLI token', async () => {
    mockQuota.mockResolvedValue({ ok: true, quota });
    const usage = await fetchAccountCopilotUsage({ login: 'alice-work', ...none, ghToken: 'gho_work' }, 800, now);
    expect(mockQuota).toHaveBeenCalledWith('gho_work', undefined);
    expect(usage).toMatchObject({ source: 'gh-cli', login: 'alice-work', plan: 'business', creditsUsed: 300, budgetCredits: 800 });
  });

  it('falls back to the OAuth billing report for that login', async () => {
    mockQuota.mockResolvedValue({ ok: false, status: 404, error: 'HTTP 404' });
    mockBilling.mockResolvedValue({ ok: true, summary: summary(42) });
    const usage = await fetchAccountCopilotUsage(
      { login: 'alice', ghToken: 'gho', oauth: { accessToken: 'oauth', scopes: 'repo,user' }, pat: null }, null, now,
    );
    expect(mockBilling).toHaveBeenCalledWith('oauth', 'alice', expect.objectContaining({ month: 9 }), undefined);
    expect(usage).toMatchObject({ source: 'oauth', creditsUsed: 42 });
  });

  it('talks to the API of the account host (GHE.com)', async () => {
    mockQuota.mockResolvedValue({ ok: true, quota });
    await fetchAccountCopilotUsage(
      { login: 'bob', apiBase: 'https://api.corp.ghe.com', ...none, ghToken: 'gho_ghe' }, null, now,
    );
    expect(mockQuota).toHaveBeenCalledWith('gho_ghe', 'https://api.corp.ghe.com');

    mockQuota.mockResolvedValue({ ok: false, status: 404, error: 'HTTP 404' });
    mockBilling.mockResolvedValue({ ok: true, summary: summary(3) });
    await fetchAccountCopilotUsage(
      { login: 'bob', apiBase: 'https://api.corp.ghe.com', ghToken: null, oauth: null, pat: 'pat' }, null, now,
    );
    expect(mockBilling).toHaveBeenCalledWith('pat', 'bob', expect.anything(), 'https://api.corp.ghe.com');
  });

  it('tries the PAT when the OAuth token cannot read billing', async () => {
    mockBilling
      .mockResolvedValueOnce({ ok: false, status: 403, error: 'HTTP 403', missingScope: true })
      .mockResolvedValueOnce({ ok: true, summary: summary(7) });
    const usage = await fetchAccountCopilotUsage(
      { login: 'alice', ghToken: null, oauth: { accessToken: 'oauth', scopes: 'repo' }, pat: 'pat' }, null, now,
    );
    expect(usage).toMatchObject({ source: 'pat', creditsUsed: 7 });
  });

  it('explains how to fix an org-billed account that only has billing-report access', async () => {
    mockBilling.mockResolvedValue({ ok: false, status: 403, error: 'HTTP 403', missingScope: true });
    const usage = await fetchAccountCopilotUsage(
      { login: 'alice', ghToken: null, oauth: { accessToken: 'oauth', scopes: 'repo,user' }, pat: null }, null, now,
    );
    expect(usage.error).toMatch(/gh auth login/);
    expect(usage).toMatchObject({ configured: true, missingScope: true, oauthHasUserScope: true });
  });
});
