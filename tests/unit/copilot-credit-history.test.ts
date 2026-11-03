import { describe, it, expect, afterEach, vi } from 'vitest';
import initSqlJs from 'sql.js';

vi.mock('../../src/storage/database', () => ({ saveDatabase: vi.fn() }));

import { attachUsageHistoryStore, detachUsageHistoryStore, readUsageSamples } from '../../src/services/usage-history';
import { recordCopilotCredits } from '../../src/plugins/copilot-usage/credit-history';
import type { CopilotUsage } from '../../src/plugins/types';

const usage = (over: Partial<CopilotUsage>): CopilotUsage => ({
  configured: true,
  year: 2030,
  month: 1,
  resetsAt: 0,
  creditsUsed: 0,
  includedCreditsUsed: 0,
  billedCredits: 0,
  billedAmountUsd: 0,
  byModel: [],
  budgetCredits: null,
  projectedCredits: null,
  fetchedAt: '2030-01-15T12:00:00.000Z',
  ...over,
});

describe('recordCopilotCredits', () => {
  afterEach(() => detachUsageHistoryStore());

  it('stores one series per account and skips accounts without a good reading', async () => {
    const SQL = await initSqlJs();
    attachUsageHistoryStore(new SQL.Database());
    recordCopilotCredits(
      [
        { id: 'work-user', usage: usage({ creditsUsed: 4200, budgetCredits: 5000 }) },
        { id: 'bob@acme.ghe.com', usage: usage({ creditsUsed: 15, entitlementCredits: 300 }) },
        { id: 'unlimited', usage: usage({ creditsUsed: 7 }) },
        { id: 'failed', usage: usage({ creditsUsed: 1, error: 'HTTP 500' }) },
        { id: 'stale', usage: usage({ creditsUsed: 1, stale: true }) },
        { id: 'signed-out', usage: usage({ configured: false }) },
      ],
      1000,
    );
    expect(readUsageSamples('copilot', 0, 2000)).toEqual([
      {
        at: 1000,
        series: {
          'work-user': { value: 4200, limit: 5000 },
          'bob@acme.ghe.com': { value: 15, limit: 300 },
          unlimited: { value: 7, limit: null },
        },
      },
    ]);
  });
});
