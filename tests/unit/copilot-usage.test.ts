import { describe, it, expect, vi, afterEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

import {
  currentBillingMonth,
  elapsedMonthFraction,
  projectMonthEndUsage,
  summarizeAiCreditUsage,
  fetchAiCreditUsage,
  fetchCopilotQuota,
  getGhCliToken,
  parseCopilotQuota,
  type AiCreditUsageItem,
} from '../../src/services/copilot-usage';
import { copilotBudgetLevel, copilotUsageLimit } from '../../src/plugins/copilot-usage/budget-level';
import { resolveGitHubScopes } from '../../src/agent/config';
import type { CopilotUsage } from '../../src/plugins/types';

function item(overrides: Partial<AiCreditUsageItem>): AiCreditUsageItem {
  return {
    product: 'Copilot AI Credits',
    sku: 'AI Credit',
    model: 'GPT-5',
    unitType: 'ai-credits',
    pricePerUnit: 0.01,
    grossQuantity: 0,
    grossAmount: 0,
    discountQuantity: 0,
    discountAmount: 0,
    netQuantity: 0,
    netAmount: 0,
    ...overrides,
  };
}

describe('currentBillingMonth', () => {
  it('uses the UTC calendar month and resets on the 1st of the next month', () => {
    const period = currentBillingMonth(new Date('2026-09-25T13:00:00Z'));
    expect(period.year).toBe(2026);
    expect(period.month).toBe(9);
    expect(period.startsAt).toBe(Date.UTC(2026, 8, 1) / 1000);
    expect(period.resetsAt).toBe(Date.UTC(2026, 9, 1) / 1000);
  });

  it('rolls over the year in December', () => {
    const period = currentBillingMonth(new Date('2026-12-31T23:59:59Z'));
    expect(period.month).toBe(12);
    expect(period.resetsAt).toBe(Date.UTC(2027, 0, 1) / 1000);
  });
});

describe('projectMonthEndUsage', () => {
  const period = currentBillingMonth(new Date('2026-09-01T00:00:00Z'));

  it('extrapolates linearly from the elapsed fraction of the month', () => {
    const halfway = new Date('2026-09-16T00:00:00Z');
    expect(elapsedMonthFraction(period, halfway)).toBeCloseTo(0.5, 5);
    expect(projectMonthEndUsage(500, period, halfway)).toBe(1000);
  });

  it('returns null during the first day of the month', () => {
    expect(projectMonthEndUsage(50, period, new Date('2026-09-01T06:00:00Z'))).toBeNull();
  });
});

describe('summarizeAiCreditUsage', () => {
  it('totals credits and splits included vs billed usage per model', () => {
    const summary = summarizeAiCreditUsage([
      item({ model: 'GPT-5', grossQuantity: 300, discountQuantity: 300, netQuantity: 0 }),
      item({ model: 'Claude Sonnet 5', grossQuantity: 900, discountQuantity: 700, netQuantity: 200, netAmount: 2 }),
      item({ model: 'GPT-5', grossQuantity: 100, discountQuantity: 0, netQuantity: 100, netAmount: 1 }),
      item({ model: 'Idle', grossQuantity: 0 }),
    ]);
    expect(summary.creditsUsed).toBe(1300);
    expect(summary.includedCreditsUsed).toBe(1000);
    expect(summary.billedCredits).toBe(300);
    expect(summary.billedAmountUsd).toBe(3);
    expect(summary.byModel).toEqual([
      { model: 'Claude Sonnet 5', credits: 900 },
      { model: 'GPT-5', credits: 400 },
    ]);
  });

  it('returns zeros for an empty report', () => {
    expect(summarizeAiCreditUsage([])).toEqual({
      creditsUsed: 0, includedCreditsUsed: 0, billedCredits: 0, billedAmountUsd: 0, byModel: [],
    });
  });
});

describe('fetchAiCreditUsage', () => {
  afterEach(() => vi.unstubAllGlobals());
  const period = currentBillingMonth(new Date('2026-09-10T00:00:00Z'));

  it('requests the given month for the user and summarises the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ usageItems: [item({ grossQuantity: 42, netQuantity: 42, netAmount: 0.42 })] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAiCreditUsage('tok', 'octo cat', period);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/users/octo%20cat/settings/billing/ai_credit/usage?year=2026&month=9',
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(result).toMatchObject({ ok: true, summary: { creditsUsed: 42 } });
    // The untouched body is kept for the flyout's raw JSON view.
    expect(result.raw).toMatchObject({
      endpoint: '/users/octo%20cat/settings/billing/ai_credit/usage?year=2026&month=9',
      status: 200,
      body: { usageItems: [expect.objectContaining({ grossQuantity: 42 })] },
    });
  });

  it('flags a missing scope on 403/404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'Resource not accessible by integration' }),
    }));
    const result = await fetchAiCreditUsage('tok', 'me', period);
    expect(result).toEqual({
      ok: false, status: 403, error: 'HTTP 403: Resource not accessible by integration', missingScope: true,
      raw: {
        endpoint: '/users/me/settings/billing/ai_credit/usage?year=2026&month=9',
        status: 403,
        body: { message: 'Resource not accessible by integration' },
      },
    });
  });

  it('reports network errors without flagging scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await fetchAiCreditUsage('tok', 'me', period);
    expect(result).toEqual({ ok: false, status: 0, error: 'offline', missingScope: false });
  });
});

// A trimmed `GET /copilot_internal/user` body as returned for an enterprise seat.
const internalUser = {
  login: 'rajbos',
  copilot_plan: 'enterprise',
  quota_reset_date: '2026-10-01',
  quota_reset_date_utc: '2026-10-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { unlimited: true, credits_used: 0, entitlement: 0, remaining: 0 },
    premium_interactions: {
      percent_remaining: 30.6, quota_remaining: 53680.2, unlimited: false, has_quota: true,
      token_based_billing: true, credits_used: 121320, remaining: 53680, entitlement: 175000,
    },
  },
};

describe('parseCopilotQuota', () => {
  it('reads the premium quota, plan and reset date', () => {
    expect(parseCopilotQuota(internalUser)).toEqual({
      login: 'rajbos', plan: 'enterprise', creditsUsed: 121320, entitlementCredits: 175000,
      remainingCredits: 53680, unlimited: false, resetsAt: Date.UTC(2026, 9, 1) / 1000,
    });
  });

  it('treats unlimited plans as having no entitlement', () => {
    const quota = parseCopilotQuota({
      ...internalUser,
      quota_snapshots: { premium_interactions: { unlimited: true, credits_used: 12, entitlement: 0 } },
    });
    expect(quota).toMatchObject({ creditsUsed: 12, entitlementCredits: null, unlimited: true });
  });

  it('returns null when the body has no premium quota', () => {
    expect(parseCopilotQuota({ login: 'x' })).toBeNull();
    expect(parseCopilotQuota({ quota_snapshots: {} })).toBeNull();
  });
});

describe('fetchCopilotQuota', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the internal user endpoint with the token and parses the quota', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(internalUser) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchCopilotQuota('gho_x');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/copilot_internal/user');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer gho_x');
    expect(result).toMatchObject({ ok: true, quota: { creditsUsed: 121320, entitlementCredits: 175000 } });
    expect(result.raw).toEqual({ endpoint: '/copilot_internal/user', status: 200, body: internalUser });
  });

  it('reports HTTP errors with the GitHub message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not Found' }),
    }));
    expect(await fetchCopilotQuota('tok')).toEqual({
      ok: false, status: 404, error: 'HTTP 404: Not Found',
      raw: { endpoint: '/copilot_internal/user', status: 404, body: { message: 'Not Found' } },
    });
  });

  it('fails when the response carries no premium quota', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"login":"me"}' }));
    expect(await fetchCopilotQuota('tok')).toMatchObject({ ok: false, status: 200, error: /premium quota/ });
  });

  it('reports network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchCopilotQuota('tok')).toEqual({ ok: false, status: 0, error: 'offline' });
  });
});

describe('getGhCliToken', () => {
  afterEach(() => execFileMock.mockReset());

  it('runs `gh auth token` and returns the trimmed token', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, 'gho_abc123\n', ''));
    await expect(getGhCliToken()).resolves.toBe('gho_abc123');
    expect(execFileMock.mock.calls[0].slice(0, 2)).toEqual(['gh', ['auth', 'token']]);
  });

  it('returns null when gh is missing or not logged in', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '', ''));
    await expect(getGhCliToken()).resolves.toBeNull();
  });

  it('rejects output that is not a bare token', async () => {
    execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, 'You are not logged into any GitHub hosts', ''));
    await expect(getGhCliToken()).resolves.toBeNull();
  });
});

describe('copilotBudgetLevel', () => {
  const base: CopilotUsage = {
    configured: true, year: 2026, month: 9, resetsAt: 0, creditsUsed: 0, includedCreditsUsed: 0,
    billedCredits: 0, billedAmountUsd: 0, byModel: [], budgetCredits: 1000, projectedCredits: null,
    fetchedAt: '2026-09-25T00:00:00Z',
  };

  it('maps usage vs budget to a level', () => {
    expect(copilotBudgetLevel({ ...base, creditsUsed: 100 })).toBe('available');
    expect(copilotBudgetLevel({ ...base, creditsUsed: 800 })).toBe('warning');
    expect(copilotBudgetLevel({ ...base, creditsUsed: 1000 })).toBe('limited');
    expect(copilotBudgetLevel({ ...base, creditsUsed: 100, projectedCredits: 1500 })).toBe('warning');
    expect(copilotBudgetLevel({ ...base, creditsUsed: 5000, budgetCredits: null })).toBe('available');
    expect(copilotBudgetLevel({ ...base, error: 'nope' })).toBe('unknown');
  });

  it('falls back to the plan entitlement when no budget is set', () => {
    const plan = { ...base, budgetCredits: null, entitlementCredits: 175000 };
    expect(copilotUsageLimit(plan)).toBe(175000);
    expect(copilotUsageLimit({ ...plan, budgetCredits: 500 })).toBe(500);
    expect(copilotUsageLimit({ ...plan, entitlementCredits: null })).toBeNull();
    expect(copilotBudgetLevel({ ...plan, creditsUsed: 121320 })).toBe('available');
    expect(copilotBudgetLevel({ ...plan, creditsUsed: 150000 })).toBe('warning');
    expect(copilotBudgetLevel({ ...plan, creditsUsed: 175000 })).toBe('limited');
  });
});

describe('resolveGitHubScopes', () => {
  it('adds the user scope to legacy scope lists and drops read:user', () => {
    expect(resolveGitHubScopes(['repo', 'read:org', 'read:user']).sort()).toEqual(['read:org', 'repo', 'user']);
  });

  it('keeps extra configured scopes', () => {
    expect(resolveGitHubScopes(['repo', 'workflow'])).toEqual(expect.arrayContaining(['repo', 'workflow', 'read:org', 'user']));
  });
});
