/**
 * Unit tests for plugins/browser-companion/server.ts
 *
 * Tests the browser bridge WebSocket server's public API:
 * - getBridgeStatus (status reporting)
 * - sendCommand (rejects when no clients are connected)
 * - stopBridgeServer (safe to call even without a running server)
 * - validateNavigateUrl (URL scheme allow-list)
 * - getBridgeToken (token generation and persistence)
 * - regenerateBridgeToken (token rotation)
 *
 * startBridgeServer is exercised indirectly via the IPC registration tests
 * (handler-validation.test.ts), which call registerIpcHandlers and produce the
 * "[BrowserBridge] Listening" log line.  That route covers the happy-path
 * branches for connection handling.  The tests below focus on the branches that
 * are exercised WITHOUT a live WebSocket connection.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── WebSocket mock ─────────────────────────────────────────────────────────────
// Using vi.hoisted so variables are available inside the vi.mock factory.
// This avoids binding a real port and prevents flaky port-conflict failures
// when handler-validation.test.ts also starts the server in its own worker.

const mockRegistry = vi.hoisted(() => ({
  serverEmitter: null as null | (ReturnType<typeof import('events').EventEmitter> & { close: () => void }),
  createSocket: null as null | ((remoteAddr?: string) => {
    emit: (event: string, ...args: unknown[]) => void;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
  }),
}));

vi.mock('ws', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events');

  class MockWebSocket extends EventEmitter {
    readyState = 1;
    send = vi.fn();
    close = vi.fn((code?: number, reason?: string | Buffer) => {
      this.readyState = 3;
      this.emit('close', code, typeof reason === 'string' ? Buffer.from(reason) : (reason ?? Buffer.alloc(0)));
    });
    socket: { remoteAddress: string } = { remoteAddress: '127.0.0.1' };
  }

  class MockWebSocketServer extends EventEmitter {
    close = vi.fn();
    constructor(_opts?: unknown) {
      super();
      // Store as "any" to keep typing simple across hoisted boundary
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockRegistry as any).serverEmitter = this;
    }
  }

  // Expose a factory so tests can create sockets with a chosen remoteAddress
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockRegistry as any).createSocket = (remoteAddr = '127.0.0.1') => {
    const ws = new MockWebSocket();
    ws.socket = { remoteAddress: remoteAddr };
    return ws;
  };

  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

import {
  getBridgeStatus,
  sendCommand,
  stopBridgeServer,
  startBridgeServer,
  validateNavigateUrl,
  getBridgeToken,
  regenerateBridgeToken,
  BRIDGE_PORT,
} from '../../src/plugins/browser-companion/server';

afterEach(() => {
  // Ensure the server is always stopped after each test so module-level state
  // does not leak across tests.
  stopBridgeServer();
});

describe('getBridgeStatus', () => {
  it('reports not running when the server has not been started', () => {
    const status = getBridgeStatus();
    expect(status.running).toBe(false);
    expect(status.port).toBe(BRIDGE_PORT);
    expect(status.connectedClients).toBe(0);
  });

  it('includes the correct bridge port constant', () => {
    expect(BRIDGE_PORT).toBe(35789);
  });
});

describe('sendCommand', () => {
  it('rejects immediately when no browser extension is connected', async () => {
    await expect(
      sendCommand({ type: 'navigate', payload: { url: 'https://example.com' } }),
    ).rejects.toThrow('No browser extension connected');
  });

  it('rejects with the correct error message for every command type when disconnected', async () => {
    const types = [
      'list-tabs',
      'get-page-content',
      'focus-window',
      'evaluate',
      'extract',
      'scroll-extract',
    ] as const;
    for (const type of types) {
      await expect(
        sendCommand({ type, payload: {} }),
      ).rejects.toThrow('No browser extension connected');
    }
  });


});

describe('stopBridgeServer', () => {
  it('does not throw when called without a running server', () => {
    expect(() => stopBridgeServer()).not.toThrow();
  });

  it('can be called multiple times consecutively without error', () => {
    expect(() => {
      stopBridgeServer();
      stopBridgeServer();
      stopBridgeServer();
    }).not.toThrow();
  });

  it('getBridgeStatus still reports not running after stop', () => {
    stopBridgeServer();
    const status = getBridgeStatus();
    expect(status.running).toBe(false);
    expect(status.connectedClients).toBe(0);
  });
});

// ── validateNavigateUrl ────────────────────────────────────────────────────────

describe('validateNavigateUrl', () => {
  it('accepts http: URLs without throwing', () => {
    expect(() => validateNavigateUrl('http://example.com')).not.toThrow();
  });

  it('accepts https: URLs without throwing', () => {
    expect(() => validateNavigateUrl('https://example.com/path?q=1')).not.toThrow();
  });

  it('rejects file: URLs', () => {
    expect(() => validateNavigateUrl('file:///etc/passwd')).toThrow('not allowed');
  });

  it('rejects chrome: URLs', () => {
    expect(() => validateNavigateUrl('chrome://extensions')).toThrow('not allowed');
  });

  it('rejects javascript: URLs', () => {
    expect(() => validateNavigateUrl('javascript:alert(1)')).toThrow('not allowed');
  });

  it('rejects data: URLs', () => {
    expect(() => validateNavigateUrl('data:text/html,<h1>hi</h1>')).toThrow('not allowed');
  });

  it('rejects ftp: URLs', () => {
    expect(() => validateNavigateUrl('ftp://example.com/file')).toThrow('not allowed');
  });

  it('throws a descriptive error for completely invalid URLs', () => {
    expect(() => validateNavigateUrl('not-a-valid-url')).toThrow('Invalid URL');
  });

  it('throws a descriptive error for empty string', () => {
    expect(() => validateNavigateUrl('')).toThrow('Invalid URL');
  });

  it('includes the blocked scheme in the error message', () => {
    expect(() => validateNavigateUrl('file:///test')).toThrow('file:');
  });
});

// ── getBridgeToken / regenerateBridgeToken ─────────────────────────────────────

describe('getBridgeToken', () => {
  let tmpDir: string;
  const originalEnv = process.env.JARVIS_CONFIG_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bridge-token-test-'));
    process.env.JARVIS_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.JARVIS_CONFIG_DIR;
    } else {
      process.env.JARVIS_CONFIG_DIR = originalEnv;
    }
  });

  it('generates a non-empty token when no config exists', () => {
    const token = getBridgeToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('persists the token to config.json', () => {
    const token = getBridgeToken();
    const configPath = path.join(tmpDir, 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { bridge?: { token?: string } };
    expect(saved.bridge?.token).toBe(token);
  });

  it('returns the same token on repeated calls', () => {
    const first = getBridgeToken();
    const second = getBridgeToken();
    expect(second).toBe(first);
  });

  it('returns an existing token from config without regenerating', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ bridge: { token: 'existing-token-abc123' } }), 'utf-8');
    const token = getBridgeToken();
    expect(token).toBe('existing-token-abc123');
  });

  it('generates a token matching the expected hex format (32 hex chars)', () => {
    const token = getBridgeToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('regenerateBridgeToken', () => {
  let tmpDir: string;
  const originalEnv = process.env.JARVIS_CONFIG_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bridge-regen-test-'));
    process.env.JARVIS_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.JARVIS_CONFIG_DIR;
    } else {
      process.env.JARVIS_CONFIG_DIR = originalEnv;
    }
  });

  it('returns a new token in hex format', () => {
    const token = regenerateBridgeToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('replaces the previously stored token', () => {
    const first = getBridgeToken();
    const second = regenerateBridgeToken();
    // The new token should be persisted
    const third = getBridgeToken();
    expect(third).toBe(second);
    // With high probability (collision extremely unlikely) the new token differs
    expect(second).not.toBe(first);
  });

  it('persists the new token to config.json', () => {
    const newToken = regenerateBridgeToken();
    const configPath = path.join(tmpDir, 'config.json');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { bridge?: { token?: string } };
    expect(saved.bridge?.token).toBe(newToken);
  });
});

// ── WebSocket auth flow (via mocked ws module) ────────────────────────────────
// These tests exercise the auth handshake, rate-limiting, and single-client
// branches of startBridgeServer / handleAuthMessage without binding a real port.

describe('startBridgeServer — WebSocket auth flow', () => {
  let tmpDir: string;
  const originalEnv = process.env.JARVIS_CONFIG_DIR;
  let token: string;

  // Helper: emit the 'listening' event so startBridgeServer's callback fires
  function emitListening(): void {
    (mockRegistry.serverEmitter as unknown as { emit: (e: string) => void })?.emit('listening');
  }

  // Helper: simulate a new WebSocket connection from localhost
  function connectSocket(remoteAddr = '127.0.0.1'): ReturnType<NonNullable<typeof mockRegistry.createSocket>> {
    const ws = mockRegistry.createSocket!(remoteAddr);
    const req = { socket: { remoteAddress: remoteAddr } };
    (mockRegistry.serverEmitter as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('connection', ws, req);
    return ws;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ws-test-'));
    process.env.JARVIS_CONFIG_DIR = tmpDir;
    // Start the server (uses mocked WSS — no real port binding)
    startBridgeServer(() => null);
    emitListening();
    token = getBridgeToken();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.JARVIS_CONFIG_DIR;
    } else {
      process.env.JARVIS_CONFIG_DIR = originalEnv;
    }
  });

  it('startBridgeServer marks the server as running', () => {
    expect(getBridgeStatus().running).toBe(true);
  });

  it('calling startBridgeServer a second time is a no-op', () => {
    startBridgeServer(() => null); // second call — should return early
    expect(getBridgeStatus().running).toBe(true);
  });

  it('authenticates a socket that sends the correct token', () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth-ok' }));
    expect(getBridgeStatus().connectedClients).toBe(1);
  });

  it('rejects a socket that sends a wrong token', () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'wrong-token' })));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth-fail', reason: 'invalid-token' }));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid token');
  });

  it('rejects a socket that sends a non-auth, non-ping message before authenticating', () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'navigate', url: 'https://example.com' })));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth-fail', reason: 'auth-required' }));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Authentication required');
  });

  it('ignores ping messages received before authentication (no close)', () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes a socket that sends invalid JSON before authenticating', () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from('not-valid-json{'));
    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid message');
  });

  it('closes non-localhost connections immediately', () => {
    const ws = connectSocket('10.0.0.1');
    expect(ws.close).toHaveBeenCalledWith(1008, 'Forbidden');
  });

  it('replaces an existing authenticated client when a new one connects and authenticates', () => {
    // First client authenticates
    const ws1 = connectSocket();
    ws1.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));
    expect(getBridgeStatus().connectedClients).toBe(1);

    // Second client authenticates — should replace first
    const ws2 = connectSocket();
    ws2.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));
    // First client should be closed
    expect(ws1.close).toHaveBeenCalledWith(1000, 'Replaced by new connection');
    // Second client is now authenticated
    expect(getBridgeStatus().connectedClients).toBe(1);
  });

  it('resets connected count to 0 when the authenticated client disconnects', () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));
    expect(getBridgeStatus().connectedClients).toBe(1);
    ws.emit('close');
    expect(getBridgeStatus().connectedClients).toBe(0);
  });

  it('sends rate-limit error when authenticated client exceeds 30 commands in a window', () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));
    ws.send.mockClear(); // clear the auth-ok call

    // Send 31 messages — the 31st should be rate-limited
    const msg = JSON.stringify({ id: 'test-id', type: 'list-tabs' });
    for (let i = 0; i < 31; i++) {
      ws.emit('message', Buffer.from(msg));
    }

    // At least one rate-limit response should have been sent
    const rateLimitCalls = (ws.send.mock.calls as string[][]).filter(
      ([payload]) => typeof payload === 'string' && payload.includes('Rate limit exceeded'),
    );
    expect(rateLimitCalls.length).toBeGreaterThan(0);
  });

  it('responds to pending sendCommand promises when a response arrives', async () => {
    const ws = connectSocket();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token })));

    // Intercept the outgoing command to extract its id
    ws.send.mockClear();
    const cmdPromise = sendCommand({ type: 'list-tabs', payload: {} });

    // Wait for the send call to happen
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const sentPayload = JSON.parse((ws.send.mock.calls[0] as [string])[0]) as { id: string };
    const id = sentPayload.id;

    // Simulate the extension's response
    ws.emit('message', Buffer.from(JSON.stringify({ id, ok: true, data: [] })));

    const result = await cmdPromise;
    expect(result.ok).toBe(true);
    expect(result.id).toBe(id);
  });
});

