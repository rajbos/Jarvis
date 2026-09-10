// ── Browser tab session ───────────────────────────────────────────────────────
// A scraping run (e.g. the Ruddr project + group refresh) navigates the browser
// several times. Rather than hijacking whatever tab the user is looking at, the
// first navigation asks the extension for a dedicated tab; every later command
// targets that same tab, and the run closes it when it is done.
//
// The tab is only ever closed when the extension reports that it created it
// (`createdTab: true`). If the extension is an older build that ignores the
// `newTab` flag, the run reuses the active tab exactly as before and nothing is
// closed — the user's own tab is never taken away from them.
import { sendCommand } from './server';
import { logger } from '../../services/logger';

export interface BrowserTabSession {
  /** The tab this run works in, once a navigation has reported one. */
  tabId?: number;
  /** True only when the extension opened this tab for us — the one case we may close it. */
  createdByUs: boolean;
}

/** Starts a session. Pass it to `navigatePayload()` on the run's first navigation. */
export function createTabSession(): BrowserTabSession {
  return { createdByUs: false };
}

/**
 * Payload extras for a `navigate` command: requests a fresh tab for the first
 * navigation of a session, and nothing afterwards (the tab id is passed as
 * `tabId` on the command itself from then on).
 */
export function navigatePayload(session: BrowserTabSession | undefined): { newTab?: true } {
  return session && session.tabId === undefined ? { newTab: true } : {};
}

/** Records the tab a `navigate` response landed on, and whether we own it. */
export function recordNavigationTab(session: BrowserTabSession | undefined, data: unknown): void {
  if (!session || session.tabId !== undefined) return;
  const nav = data as { tabId?: number; createdTab?: boolean } | null;
  if (typeof nav?.tabId !== 'number') return;
  session.tabId = nav.tabId;
  session.createdByUs = nav.createdTab === true;
}

/**
 * Hands the tab back to the user (e.g. Ruddr wants a login) so the run leaves it
 * open. The session keeps targeting the tab; it just no longer claims ownership.
 */
export function keepSessionTabOpen(session: BrowserTabSession | undefined): void {
  if (session) session.createdByUs = false;
}

/**
 * Closes the run's tab — but only if the extension opened it for us. Failures are
 * logged and swallowed: a tab that could not be closed is never worth failing a
 * completed scrape over.
 */
export async function closeSessionTab(session: BrowserTabSession | undefined): Promise<void> {
  if (!session || !session.createdByUs || session.tabId === undefined) return;

  const tabId = session.tabId;
  // Clear ownership first so a second call (or a retry) never closes a tab twice.
  session.createdByUs = false;
  session.tabId = undefined;

  try {
    const resp = await sendCommand({ type: 'close-tab', tabId, payload: {} });
    if (!resp.ok) {
      logger.debug(`[BrowserBridge] Could not close tab ${tabId}: ${resp.error ?? 'unknown'}`);
      return;
    }
    logger.debug(`[BrowserBridge] Closed tab ${tabId} opened for this run`);
  } catch (err) {
    logger.debug(
      `[BrowserBridge] Could not close tab ${tabId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
