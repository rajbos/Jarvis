/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Copilot usage plugin — IPC handler tests (real in-memory DB, mocked GitHub).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const notificationShow = vi.fn();
const allWindows: unknown[] = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  Notification: vi.fn().mockImplementation(function () { return { show: notificationShow }; }),
  BrowserWindow: { getAllWindows: vi.fn(() => allWindows) },
}));

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/services/github-oauth', () => ({
  loadGitHubAuth: vi.fn(() => null),
  loadGitHubPat: vi.fn(() => null),
  fetchGitHubUser: vi.fn(),
}));

vi.mock('../../src/services/copilot-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/copilot-usage')>();
  return { ...actual, fetchAiCreditUsage: vi.fn(), fetchCopilotQuota: vi.fn(), getGhCliToken: vi.fn(async () => null) };
});

import { registerHandlers, checkCopilotUsage, _resetCopilotUsageState } from '../../src/plugins/copilot-usage/handler';
import { loadGitHubAuth, loadGitHubPat, fetchGitHubUser } from '../../src/services/github-oauth';
import { fetchAiCreditUsage, fetchCopilotQuota, getGhCliToken } from '../../src/services/copilot-usage';
import type { CopilotUsage } from '../../src/plugins/types';

const mockAuth = vi.mocked(loadGitHubAuth);
const mockPat = vi.mocked(loadGitHubPat);
const mockUser = vi.mocked(fetchGitHubUser);
const mockFetch = vi.mocked(fetchAiCreditUsage);
const mockQuota = vi.mocked(fetchCopilotQuota);
const mockGhToken = vi.mocked(getGhCliToken);

const enterpriseQuota = {
  login: 'rajbos', plan: 'enterprise', creditsUsed: 121320, entitlementCredits: 175000,
  remainingCredits: 53680, unlimited: false, resetsAt: Date.UTC(2026, 9, 1) / 1000,
};

const summary = (creditsUsed: number) => ({
  creditsUsed, includedCreditsUsed: creditsUsed, billedCredits: 0, billedAmountUsd: 0, byModel: [],
});

function call(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, ...args);
}

describe('Copilot usage plugin', () => {
  let db: SqlJsDatabase;
  const now = new Date('2026-09-16T00:00:00Z');

  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    _resetCopilotUsageState();
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    mockAuth.mockReturnValue(null);
    mockPat.mockReturnValue(null);
    mockGhToken.mockResolvedValue(null);
    registerHandlers(db, () => null);
  });

  afterEach(() => db.close());

  it('prefers the GitHub CLI token and the internal quota endpoint, even without OAuth', async () => {
    mockGhToken.mockResolvedValue('gho_cli');
    mockQuota.mockResolvedValue({ ok: true, quota: enterpriseQuota });

    const usage = await checkCopilotUsage(db, () => null, now);
    expect(mockQuota).toHaveBeenCalledWith('gho_cli');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(usage).toMatchObject({
      configured: true, source: 'gh-cli', login: 'rajbos', plan: 'enterprise',
      creditsUsed: 121320, entitlementCredits: 175000, includedCreditsUsed: 121320, billedCredits: 0,
      resetsAt: Date.UTC(2026, 9, 1) / 1000, byModel: [],
    });
    expect(usage.projectedCredits).toBeGreaterThan(121320);
  });

  it('counts credits beyond the entitlement as billed overage', async () => {
    mockGhToken.mockResolvedValue('gho_cli');
    mockQuota.mockResolvedValue({ ok: true, quota: { ...enterpriseQuota, creditsUsed: 176000, remainingCredits: 0 } });

    const usage = await checkCopilotUsage(db, () => null, now);
    expect(usage).toMatchObject({ includedCreditsUsed: 175000, billedCredits: 1000, billedAmountUsd: 10 });
  });

  it('falls back to the billing report when the CLI quota lookup fails', async () => {
    mockGhToken.mockResolvedValue('gho_cli');
    mockQuota.mockResolvedValue({ ok: false, status: 404, error: 'HTTP 404: Not Found' });
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'repo,user', avatarUrl: null });
    mockFetch.mockResolvedValue({ ok: true, summary: summary(5) });

    const usage = await checkCopilotUsage(db, () => null, now);
    expect(usage).toMatchObject({ source: 'oauth', creditsUsed: 5 });
  });

  it('reports not configured when the CLI fails and no token is linked', async () => {
    mockGhToken.mockResolvedValue('gho_cli');
    mockQuota.mockResolvedValue({ ok: false, status: 0, error: 'offline' });
    const usage = await checkCopilotUsage(db, () => null, now);
    expect(usage.configured).toBe(false);
  });

  it('reports not configured when GitHub is not connected', async () => {
    const usage = await checkCopilotUsage(db, () => null, now);
    expect(usage.configured).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses the OAuth token and applies the stored budget + projection', async () => {
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'repo,user', avatarUrl: null });
    mockFetch.mockResolvedValue({ ok: true, summary: summary(500) });
    await call('copilot-usage:set-budget', 2000);

    const usage = await checkCopilotUsage(db, () => null, now);
    expect(mockFetch).toHaveBeenCalledWith('oauth', 'me', expect.objectContaining({ year: 2026, month: 9 }));
    expect(usage).toMatchObject({
      configured: true, source: 'oauth', creditsUsed: 500, budgetCredits: 2000, projectedCredits: 1000,
    });
    expect(notificationShow).not.toHaveBeenCalled();
  });

  it('falls back to the PAT when the OAuth token lacks billing access', async () => {
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'repo,read:user', avatarUrl: null });
    mockPat.mockReturnValue('pat');
    mockUser.mockResolvedValue({ login: 'me' } as Awaited<ReturnType<typeof fetchGitHubUser>>);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, error: 'HTTP 404', missingScope: true })
      .mockResolvedValueOnce({ ok: true, summary: summary(10) });

    const usage = await checkCopilotUsage(db, () => null, now);
    expect(usage).toMatchObject({ source: 'pat', creditsUsed: 10 });
  });

  it('flags missingScope when no token can read billing data', async () => {
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'repo,read:user', avatarUrl: null });
    mockFetch.mockResolvedValue({ ok: false, status: 403, error: 'HTTP 403', missingScope: true });

    const usage = await checkCopilotUsage(db, () => null, now);
    expect(usage.missingScope).toBe(true);
    expect(usage.oauthHasUserScope).toBe(false);
    expect(usage.error).toMatch(/re-authorize/i);
  });

  it('does not suggest re-authorizing when the OAuth token already has the user scope', async () => {
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'repo,user', avatarUrl: null });
    mockFetch.mockResolvedValue({ ok: false, status: 404, error: 'HTTP 404: Not Found', missingScope: true });

    const usage = await checkCopilotUsage(db, () => null, now);
    expect(usage.oauthHasUserScope).toBe(true);
    expect(usage.error).not.toMatch(/re-authorize/i);
    expect(usage.error).toContain('HTTP 404: Not Found');
  });

  it('notifies once per threshold per month', async () => {
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'user', avatarUrl: null });
    await call('copilot-usage:set-budget', 1000);

    mockFetch.mockResolvedValue({ ok: true, summary: summary(850) });
    await checkCopilotUsage(db, () => null, now);
    await checkCopilotUsage(db, () => null, now);
    expect(notificationShow).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValue({ ok: true, summary: summary(1001) });
    await checkCopilotUsage(db, () => null, now);
    expect(notificationShow).toHaveBeenCalledTimes(2);

    // New month → alerts re-arm.
    await checkCopilotUsage(db, () => null, new Date('2026-10-20T00:00:00Z'));
    expect(notificationShow).toHaveBeenCalledTimes(3);
  });

  it('pushes updates to the main window', async () => {
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } } as unknown as Electron.BrowserWindow;
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'user', avatarUrl: null });
    mockFetch.mockResolvedValue({ ok: true, summary: summary(1) });
    await checkCopilotUsage(db, () => win, now);
    expect(send).toHaveBeenCalledWith('copilot-usage:updated', expect.objectContaining({ creditsUsed: 1 }));
  });

  it('pushes updates to every open window (e.g. Settings) once', async () => {
    const mainSend = vi.fn();
    const settingsSend = vi.fn();
    const main = { isDestroyed: () => false, webContents: { send: mainSend } };
    const settings = { isDestroyed: () => false, webContents: { send: settingsSend } };
    allWindows.push(main, settings);
    try {
      mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'user', avatarUrl: null });
      mockFetch.mockResolvedValue({ ok: true, summary: summary(1) });
      await checkCopilotUsage(db, () => main as unknown as Electron.BrowserWindow, now);
      expect(mainSend).toHaveBeenCalledTimes(1);
      expect(settingsSend).toHaveBeenCalledWith('copilot-usage:updated', expect.objectContaining({ creditsUsed: 1 }));
    } finally {
      allWindows.length = 0;
    }
  });

  it('validates, stores and clears the budget', async () => {
    expect(await call('copilot-usage:set-budget', -5)).toMatchObject({ ok: false });
    expect(await call('copilot-usage:set-budget', 'lots')).toMatchObject({ ok: false });
    expect(await call('copilot-usage:set-budget', 1234.6)).toEqual({ ok: true, budgetCredits: 1235 });
    expect(await call('copilot-usage:get-budget')).toEqual({ ok: true, budgetCredits: 1235 });
    expect(await call('copilot-usage:set-budget', null)).toEqual({ ok: true, budgetCredits: null });
    expect(await call('copilot-usage:get-budget')).toEqual({ ok: true, budgetCredits: null });
  });

  it('copilot-usage:get serves the cached result after the first check', async () => {
    mockAuth.mockReturnValue({ login: 'me', accessToken: 'oauth', scopes: 'user', avatarUrl: null });
    mockFetch.mockResolvedValue({ ok: true, summary: summary(7) });
    const first = await call('copilot-usage:get') as CopilotUsage;
    const second = await call('copilot-usage:get') as CopilotUsage;
    expect(second).toBe(first);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
