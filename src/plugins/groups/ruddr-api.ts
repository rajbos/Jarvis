// ── Ruddr API through the browser extension ───────────────────────────────────
// Ruddr has no API token for members, but its web app talks to a JSON API
// with the user's session. Jarvis asks the extension to make those same
// read-only GETs inside a ruddr.io tab, instead of rendering pages and reading
// numbers off the screen. A run opens one background tab (see tab-session.ts)
// and reuses it for every call.
import { sendCommand, getBridgeStatus } from '../browser-companion/server';
import { navigatePayload, recordNavigationTab } from '../browser-companion/tab-session';
import type { BrowserTabSession } from '../browser-companion/tab-session';

const RUDDR_APP = 'https://www.ruddr.io/app';
const API_TIMEOUT_MS = 60_000;

export type RuddrApiFailure =
  | 'not_connected'
  | 'login_required'
  | 'extension_outdated'
  | 'navigation_failed'
  | 'failed';

export type RuddrApiResult =
  | { ok: true; responses: Array<{ status: number; body: unknown }> }
  | { ok: false; reason: RuddrApiFailure; error: string };

/** Opens a Ruddr page in the session's tab (first call only) so API calls carry the user's session. */
async function ensureRuddrTab(session: BrowserTabSession, workspace: string): Promise<RuddrApiResult | null> {
  if (session.tabId !== undefined) return null;
  const nav = await sendCommand({
    type: 'navigate',
    payload: { url: `${RUDDR_APP}/${workspace}/time/week`, ...navigatePayload(session) },
  });
  if (!nav.ok) return { ok: false, reason: 'navigation_failed', error: `Navigation failed: ${nav.error ?? 'unknown'}` };
  recordNavigationTab(session, nav.data);
  const url = (nav.data as { url?: string } | null)?.url ?? '';
  if (url.includes('/login')) return { ok: false, reason: 'login_required', error: 'login_required' };
  return null;
}

/**
 * GET each path (relative to `/api/www/workspaces/<workspace id>/`) through
 * the extension. Responses come back in order, each with its HTTP status.
 */
export async function ruddrApiGet(
  session: BrowserTabSession,
  workspace: string,
  paths: string[],
): Promise<RuddrApiResult> {
  const bridge = getBridgeStatus();
  if (!bridge.running || bridge.connectedClients === 0) {
    return { ok: false, reason: 'not_connected', error: 'No browser extension connected. Open the Browser Companion tab and ensure the extension is active.' };
  }
  const tabProblem = await ensureRuddrTab(session, workspace);
  if (tabProblem) return tabProblem;

  const resp = await sendCommand({ type: 'ruddr-api-get', tabId: session.tabId, payload: { workspace, paths } }, API_TIMEOUT_MS);
  if (!resp.ok) {
    if ((resp.error ?? '').includes('Unknown command type')) {
      return { ok: false, reason: 'extension_outdated', error: 'The Jarvis browser extension needs reloading (ruddr-api-get unknown).' };
    }
    return { ok: false, reason: 'failed', error: resp.error ?? 'Ruddr API call failed' };
  }
  const data = resp.data as { ok?: boolean; status?: number; error?: string; url?: string; responses?: Array<{ status: number; body: unknown }> } | null;
  if (!data?.ok) {
    if (data?.status === 401 || data?.status === 403 || (data?.url ?? '').includes('/login')) {
      return { ok: false, reason: 'login_required', error: 'login_required' };
    }
    return { ok: false, reason: 'failed', error: data?.error ?? 'Ruddr API call failed' };
  }
  return { ok: true, responses: data.responses ?? [] };
}

/** Client and project keys from a Ruddr project path (`/app/<ws>/portfolio/projects/<client>/<project>`). */
export function projectKeysFromPath(path: string): { clientKey: string; projectKey: string } | null {
  const m = /\/portfolio\/projects\/(?:edit\/)?([^/?#]+)\/([^/?#]+)/.exec(path);
  return m ? { clientKey: m[1], projectKey: m[2] } : null;
}

/** The path Jarvis stores for a project, in the same shape as Ruddr's own links. */
export function projectPath(workspace: string, clientKey: string, projectKey: string): string {
  return `/app/${workspace}/portfolio/projects/${clientKey}/${projectKey}`;
}
