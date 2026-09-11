/**
 * Browser tab session tests.
 *
 * A scraping run (e.g. the Ruddr project + group refresh) asks the extension for
 * its own tab on the first navigation and closes it when every group is done.
 * These tests cover the ownership rule that guards the close:
 * - only a tab the extension reports as created is ever closed
 * - a reused (user-owned) tab is left alone, as is a tab handed back for login
 * - the close is idempotent and never throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/plugins/browser-companion/server', () => ({
  sendCommand: vi.fn().mockResolvedValue({ ok: true, data: null }),
}));

import {
  createTabSession,
  navigatePayload,
  recordNavigationTab,
  keepSessionTabOpen,
  closeSessionTab,
} from '../../src/plugins/browser-companion/tab-session';
import { sendCommand } from '../../src/plugins/browser-companion/server';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendCommand).mockResolvedValue({ id: '1', ok: true, data: null });
});

describe('navigatePayload', () => {
  it('requests a new tab for the first navigation of a session', () => {
    expect(navigatePayload(createTabSession())).toEqual({ newTab: true });
  });

  it('requests nothing once the session has a tab', () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 7, createdTab: true });
    expect(navigatePayload(session)).toEqual({});
  });

  it('requests nothing when there is no session', () => {
    expect(navigatePayload(undefined)).toEqual({});
  });
});

describe('recordNavigationTab', () => {
  it('adopts the tab and claims ownership when the extension created it', () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: true });
    expect(session).toEqual({ tabId: 42, createdByUs: true });
  });

  it('adopts the tab without ownership when an existing tab was reused', () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: false });
    expect(session).toEqual({ tabId: 42, createdByUs: false });
  });

  it('treats a response from an older extension (no createdTab) as not ours', () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42 });
    expect(session.createdByUs).toBe(false);
  });

  it('keeps the first tab — later navigations stay in it', () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: true });
    recordNavigationTab(session, { tabId: 99, createdTab: true });
    expect(session).toEqual({ tabId: 42, createdByUs: true });
  });

  it('ignores a response without a tab id', () => {
    const session = createTabSession();
    recordNavigationTab(session, null);
    expect(session.tabId).toBeUndefined();
  });
});

describe('closeSessionTab', () => {
  it('closes a tab the extension opened for us', async () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: true });

    await closeSessionTab(session);

    expect(sendCommand).toHaveBeenCalledWith({ type: 'close-tab', tabId: 42, payload: {} });
  });

  it('leaves a reused tab alone', async () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: false });

    await closeSessionTab(session);

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('leaves a tab handed back to the user (e.g. for login) open', async () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: true });
    keepSessionTabOpen(session);

    await closeSessionTab(session);

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('does nothing when the run never navigated', async () => {
    await closeSessionTab(createTabSession());
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('does nothing without a session', async () => {
    await closeSessionTab(undefined);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('closes at most once, even when called again', async () => {
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: true });

    await closeSessionTab(session);
    await closeSessionTab(session);

    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed close — a finished scrape is not failed over a stray tab', async () => {
    vi.mocked(sendCommand).mockRejectedValueOnce(new Error('No browser extension connected'));
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: true });

    await expect(closeSessionTab(session)).resolves.toBeUndefined();
  });

  it('swallows an error response from the extension', async () => {
    vi.mocked(sendCommand).mockResolvedValueOnce({ id: '1', ok: false, error: 'Unknown command type: close-tab' });
    const session = createTabSession();
    recordNavigationTab(session, { tabId: 42, createdTab: true });

    await expect(closeSessionTab(session)).resolves.toBeUndefined();
  });
});
