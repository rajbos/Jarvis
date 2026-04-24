/**
 * Unit tests for plugins/browser-companion/server.ts
 *
 * Tests the browser bridge WebSocket server's public API:
 * - getBridgeStatus (status reporting)
 * - sendCommand (rejects when no clients are connected)
 * - stopBridgeServer (safe to call even without a running server)
 *
 * startBridgeServer is exercised indirectly via the IPC registration tests
 * (handler-validation.test.ts), which call registerIpcHandlers and produce the
 * "[BrowserBridge] Listening" log line.  That route covers the happy-path
 * branches for connection handling.  The tests below focus on the branches that
 * are exercised WITHOUT a live WebSocket connection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getBridgeStatus,
  sendCommand,
  stopBridgeServer,
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
