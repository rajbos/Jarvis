// ── Browser Companion WebSocket bridge server ─────────────────────────────────
// Runs in the Electron main process. The matching browser extension connects
// here via WebSocket and acts as an RPC relay into the user's live browser.
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import type { BrowserWindow } from 'electron';
import { loadConfig, saveConfig } from '../../agent/config';

export const BRIDGE_PORT = 35789;
export const BRIDGE_ORIGIN = `ws://localhost:${BRIDGE_PORT}`;

// ── Message types shared with the browser extension ──────────────────────────

export interface BridgeCommand {
  id: string;
  type:
    | 'navigate'
    | 'evaluate'
    | 'extract'
    | 'scroll-extract'
    | 'scrape-stats'
    | 'read-form-fields'
    | 'click'
    | 'fill'
    | 'screenshot'
    | 'list-tabs'
    | 'get-page-content'
    | 'focus-window';
  tabId?: number;   // omit to use current active tab
  payload: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgeEvent {
  type: 'connected' | 'disconnected' | 'tab-updated' | 'navigation-complete';
  data?: unknown;
}

// ── Security constants ────────────────────────────────────────────────────────

const AUTH_TIMEOUT_MS = 5_000;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_COMMANDS = 30;
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

// ── Server state ──────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;

/** All connected sockets (authenticated or pending). Used for cleanup only. */
const connectedClients = new Set<WebSocket>();

/** The single authenticated extension socket, or null. */
let authenticatedClient: WebSocket | null = null;

/** Auth handshake timeouts: socket → timer handle. */
const authTimeouts = new Map<WebSocket, ReturnType<typeof setTimeout>>();

/** Rate-limit state per socket. */
const rateLimitMap = new Map<WebSocket, { count: number; windowStart: number }>();

// Pending RPC calls: id → { resolve, reject, timer }
const pending = new Map<
  string,
  { resolve: (val: BridgeResponse) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

let getWindowFn: (() => BrowserWindow | null) | null = null;

// ── Token management ──────────────────────────────────────────────────────────

/**
 * Returns the current bridge token, generating and persisting one if none exists.
 * The token is stored in config.json (plaintext) and is a localhost pairing secret,
 * not a hardened credential.
 */
export function getBridgeToken(): string {
  const config = loadConfig();
  if (config.bridge?.token) return config.bridge.token;
  const token = randomBytes(16).toString('hex');
  saveConfig({ ...config, bridge: { ...config.bridge, token } });
  return token;
}

/**
 * Generates a fresh token, saves it, and closes the currently authenticated
 * extension so it must re-pair with the new token.
 */
export function regenerateBridgeToken(): string {
  const config = loadConfig();
  const token = randomBytes(16).toString('hex');
  saveConfig({ ...config, bridge: { token } });
  // Drop the authenticated client — it will need to re-pair
  if (authenticatedClient) {
    authenticatedClient.close(1008, 'Token rotated');
    authenticatedClient = null;
  }
  rejectAllPending(new Error('Bridge token rotated'));
  getWindowFn?.()?.webContents.send('browser:extension-connected', { count: 0 });
  return token;
}

// ── URL validation ────────────────────────────────────────────────────────────

/**
 * Validates that a URL is safe to navigate to.
 * Only http: and https: schemes are allowed.
 * Throws a descriptive error for blocked URLs.
 */
export function validateNavigateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `URL scheme "${parsed.protocol}" is not allowed. Only http: and https: are permitted.`,
    );
  }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

function checkRateLimit(ws: WebSocket): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ws) ?? { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ws, entry);
  return entry.count <= RATE_LIMIT_MAX_COMMANDS;
}

// ── Helper: reject all pending calls ─────────────────────────────────────────

function rejectAllPending(err: Error): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(err);
    pending.delete(id);
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────

export function startBridgeServer(getWindow: () => BrowserWindow | null): void {
  if (wss) return; // already running

  // Ensure a token exists (generates one on first run)
  getBridgeToken();

  getWindowFn = getWindow;

  wss = new WebSocketServer({ port: BRIDGE_PORT, host: '127.0.0.1' });
  let started = false;

  wss.on('listening', () => {
    started = true;
    console.log(`[BrowserBridge] Listening on ${BRIDGE_ORIGIN}`);
  });

  wss.on('connection', (ws, req) => {
    // Only allow connections from localhost
    const remoteAddr = req.socket.remoteAddress ?? '';
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      ws.close(1008, 'Forbidden');
      return;
    }

    connectedClients.add(ws);
    console.log('[BrowserBridge] Client connecting (pending auth). Total sockets:', connectedClients.size);

    // Start auth timeout — client must authenticate within AUTH_TIMEOUT_MS
    const authTimer = setTimeout(() => {
      if (authTimeouts.has(ws)) {
        console.warn('[BrowserBridge] Auth timeout — closing unauthenticated socket');
        authTimeouts.delete(ws);
        ws.close(1008, 'Authentication timeout');
      }
    }, AUTH_TIMEOUT_MS);
    authTimeouts.set(ws, authTimer);

    ws.on('message', (raw) => {
      // If socket is not yet authenticated, only allow auth messages
      if (ws !== authenticatedClient) {
        handleAuthMessage(ws, raw.toString());
        return;
      }

      // Rate-limit authenticated commands
      if (!checkRateLimit(ws)) {
        console.warn('[BrowserBridge] Rate limit exceeded');
        // Send error response if the message has an id
        try {
          const msg = JSON.parse(raw.toString()) as { id?: string };
          if (msg.id) {
            ws.send(JSON.stringify({ id: msg.id, ok: false, error: 'Rate limit exceeded' }));
          }
        } catch { /* ignore */ }
        return;
      }

      try {
        const msg = JSON.parse(raw.toString()) as BridgeResponse | BridgeEvent;
        if ('id' in msg) {
          // It's a command response
          const response = msg as BridgeResponse;
          const entry = pending.get(response.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(response.id);
            entry.resolve(response);
          }
        } else {
          // It's an event from the extension — forward to renderer
          getWindowFn?.()?.webContents.send('browser:extension-event', msg);
        }
      } catch (e) {
        console.warn('[BrowserBridge] Bad message from extension:', e);
      }
    });

    ws.on('close', () => {
      // Clean up auth timeout if still pending
      const authTimer = authTimeouts.get(ws);
      if (authTimer) {
        clearTimeout(authTimer);
        authTimeouts.delete(ws);
      }
      connectedClients.delete(ws);
      rateLimitMap.delete(ws);

      if (ws === authenticatedClient) {
        authenticatedClient = null;
        rejectAllPending(new Error('Extension disconnected'));
        console.log('[BrowserBridge] Authenticated extension disconnected');
        getWindowFn?.()?.webContents.send('browser:extension-connected', { count: 0 });
      }
    });

    ws.on('error', (err) => {
      console.warn('[BrowserBridge] WebSocket error:', err.message);
    });
  });

  wss.on('error', (err) => {
    console.error('[BrowserBridge] Server error:', err.message);
    if (!started) {
      try { wss?.close(); } catch { /* ignore */ }
      wss = null;
    }
  });
}

function handleAuthMessage(ws: WebSocket, rawData: string): void {
  let msg: { type?: string; token?: string };
  try {
    msg = JSON.parse(rawData) as { type?: string; token?: string };
  } catch {
    ws.close(1008, 'Invalid message');
    return;
  }

  if (msg.type !== 'auth') {
    // Ignore keep-alive pings during auth window; reject anything else
    if (msg.type !== 'ping') {
      ws.send(JSON.stringify({ type: 'auth-fail', reason: 'auth-required' }));
      ws.close(1008, 'Authentication required');
    }
    return;
  }

  const expected = getBridgeToken();
  if (!msg.token || msg.token !== expected) {
    console.warn('[BrowserBridge] Bad token from extension — closing');
    ws.send(JSON.stringify({ type: 'auth-fail', reason: 'invalid-token' }));
    ws.close(1008, 'Invalid token');
    return;
  }

  // Token is valid — clear auth timeout
  const authTimer = authTimeouts.get(ws);
  if (authTimer) {
    clearTimeout(authTimer);
    authTimeouts.delete(ws);
  }

  // If another extension was already authenticated, close it first (single-client policy)
  if (authenticatedClient && authenticatedClient !== ws) {
    console.log('[BrowserBridge] New extension authenticated — replacing previous connection');
    rejectAllPending(new Error('Extension replaced by new connection'));
    authenticatedClient.close(1000, 'Replaced by new connection');
  }

  authenticatedClient = ws;
  ws.send(JSON.stringify({ type: 'auth-ok' }));
  console.log('[BrowserBridge] Extension authenticated');
  getWindowFn?.()?.webContents.send('browser:extension-connected', { count: 1 });
}

export function stopBridgeServer(): void {
  rejectAllPending(new Error('Bridge server stopping'));
  for (const timer of authTimeouts.values()) clearTimeout(timer);
  authTimeouts.clear();
  authenticatedClient = null;
  connectedClients.clear();
  rateLimitMap.clear();
  wss?.close();
  wss = null;
  getWindowFn = null;
}

export function getBridgeStatus(): { running: boolean; port: number; connectedClients: number } {
  return {
    running: wss !== null,
    port: BRIDGE_PORT,
    connectedClients: authenticatedClient ? 1 : 0,
  };
}

// ── RPC send ──────────────────────────────────────────────────────────────────

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function nextId(): string {
  return `${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/**
 * Send a command to the connected browser extension and wait for the response.
 * Rejects if no authenticated extension is connected, or if the command times out.
 * Navigate commands are URL-validated before sending.
 * Pass `timeoutMs` to override the default 30s timeout (e.g. for slow scroll-extract).
 */
export function sendCommand(
  command: Omit<BridgeCommand, 'id'>,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (!authenticatedClient) {
      reject(new Error('No browser extension connected'));
      return;
    }

    // Centralized URL validation for navigate commands
    if (command.type === 'navigate') {
      const url = command.payload?.url;
      try {
        validateNavigateUrl(typeof url === 'string' ? url : String(url ?? ''));
      } catch (err) {
        reject(err);
        return;
      }
    }

    const id = nextId();
    const full: BridgeCommand = { ...command, id };

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });

    try {
      authenticatedClient.send(JSON.stringify(full));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`Failed to send to extension: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}
