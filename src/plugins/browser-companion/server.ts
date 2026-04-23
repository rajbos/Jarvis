// ── Browser Companion WebSocket bridge server ─────────────────────────────────
// Runs in the Electron main process. The matching browser extension connects
// here via WebSocket and acts as an RPC relay into the user's live browser.
import { WebSocketServer, WebSocket } from 'ws';
import type { BrowserWindow } from 'electron';

export const BRIDGE_PORT = 35789;
export const BRIDGE_ORIGIN = `ws://localhost:${BRIDGE_PORT}`;

// ── Message types shared with the browser extension ──────────────────────────

export interface BridgeCommand {
  id: string;
  type:
    | 'navigate'
    | 'evaluate'
    | 'extract'
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

// ── Server state ──────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
const connectedClients = new Set<WebSocket>();

// Pending RPC calls: id → { resolve, reject, timer }
const pending = new Map<
  string,
  { resolve: (val: BridgeResponse) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

let getWindowFn: (() => BrowserWindow | null) | null = null;

// ── Start / stop ──────────────────────────────────────────────────────────────

export function startBridgeServer(getWindow: () => BrowserWindow | null): void {
  if (wss) return; // already running

  getWindowFn = getWindow;

  wss = new WebSocketServer({ port: BRIDGE_PORT, host: '127.0.0.1' });

  wss.on('connection', (ws, req) => {
    // Only allow connections from localhost
    const remoteAddr = req.socket.remoteAddress ?? '';
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      ws.close(1008, 'Forbidden');
      return;
    }

    connectedClients.add(ws);
    console.log('[BrowserBridge] Extension connected. Total clients:', connectedClients.size);
    getWindowFn?.()?.webContents.send('browser:extension-connected', { count: connectedClients.size });

    ws.on('message', (raw) => {
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
      connectedClients.delete(ws);
      // Reject any pending calls that were in-flight on this socket
      // (we can't tell which socket a pending call was sent to, so reject all if no more clients)
      if (connectedClients.size === 0) {
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Extension disconnected'));
          pending.delete(id);
        }
      }
      console.log('[BrowserBridge] Extension disconnected. Total clients:', connectedClients.size);
      getWindowFn?.()?.webContents.send('browser:extension-connected', { count: connectedClients.size });
    });

    ws.on('error', (err) => {
      console.warn('[BrowserBridge] WebSocket error:', err.message);
    });
  });

  wss.on('error', (err) => {
    console.error('[BrowserBridge] Server error:', err.message);
  });

  console.log(`[BrowserBridge] Listening on ${BRIDGE_ORIGIN}`);
}

export function stopBridgeServer(): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Bridge server stopping'));
    pending.delete(id);
  }
  connectedClients.clear();
  wss?.close();
  wss = null;
  getWindowFn = null;
}

export function getBridgeStatus(): { running: boolean; port: number; connectedClients: number } {
  return {
    running: wss !== null,
    port: BRIDGE_PORT,
    connectedClients: connectedClients.size,
  };
}

// ── RPC send ──────────────────────────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 30_000;

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Send a command to the connected browser extension and wait for the response.
 * Rejects if no extension is connected, or if the command times out.
 */
export function sendCommand(command: Omit<BridgeCommand, 'id'>): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (connectedClients.size === 0) {
      reject(new Error('No browser extension connected'));
      return;
    }

    const id = nextId();
    const full: BridgeCommand = { ...command, id };

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
    }, COMMAND_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    // Send to the first available client (extension is single-instance)
    const [client] = connectedClients;
    try {
      client.send(JSON.stringify(full));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`Failed to send to extension: ${e instanceof Error ? e.message : String(e)}`));
    }
  });
}
