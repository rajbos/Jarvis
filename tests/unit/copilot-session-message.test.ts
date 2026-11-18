import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import {
  isCopilotSessionSteerable,
  readCopilotSessionEndpoint,
  sendCopilotSessionMessage,
} from '../../src/services/copilot-session-message';

const TOKEN = 'fixture-token-123';

describe('copilot-session-message', () => {
  let home: string;
  let servers: net.Server[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-copilot-message-'));
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    fs.rmSync(home, { recursive: true, force: true });
  });

  function register(sessionId: string, entry: Record<string, unknown> | string) {
    const dir = path.join(home, '.copilot', 'session-management');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), typeof entry === 'string' ? entry : JSON.stringify(entry));
  }

  /** A stand-in for a Copilot session: records each request line and answers with `reply`. */
  async function listen(reply: (request: Record<string, unknown>) => string | null): Promise<{ port: number; requests: Array<Record<string, unknown>> }> {
    const requests: Array<Record<string, unknown>> = [];
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const request = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        requests.push(request);
        const answer = reply(request);
        if (answer !== null) socket.end(answer);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as net.AddressInfo).port, requests };
  }

  it('reads a loopback endpoint and rejects anything else', async () => {
    register('good', { sessionId: 'good', generation: 1, address: '127.0.0.1:4242', token: TOKEN });
    register('remote', { address: '10.0.0.5:4242', token: TOKEN });
    register('no-token', { address: '127.0.0.1:4242' });
    register('bad-port', { address: '127.0.0.1:99999', token: TOKEN });
    register('garbage', 'not json');

    expect(await readCopilotSessionEndpoint('good', home)).toEqual({ host: '127.0.0.1', port: 4242, token: TOKEN });
    expect(await isCopilotSessionSteerable('good', home)).toBe(true);
    for (const id of ['remote', 'no-token', 'bad-port', 'garbage', 'missing']) {
      expect(await isCopilotSessionSteerable(id, home)).toBe(false);
    }
    // A session id is used as a file name: path separators never reach the disk.
    expect(await readCopilotSessionEndpoint('..\\good', home)).toBeNull();
    expect(await readCopilotSessionEndpoint('../good', home)).toBeNull();
  });

  it('delivers the prompt as one JSON line and reports the target', async () => {
    const peer = await listen(() => '{"sent":true,"targetSessionName":"brakes"}\n');
    register('s1', { sessionId: 's1', generation: 1, address: `127.0.0.1:${peer.port}`, token: TOKEN });

    const result = await sendCopilotSessionMessage('s1', '  Where are we?  ', { homeDir: home });

    expect(result).toEqual({ ok: true, targetSessionName: 'brakes' });
    expect(peer.requests).toHaveLength(1);
    expect(peer.requests[0]).toEqual({
      token: TOKEN,
      message: { senderSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), senderName: 'Jarvis', content: 'Where are we?' },
    });
  });

  it('reports a rejection without echoing the token', async () => {
    const peer = await listen(() => `{"error":"bad request from ${TOKEN}"}\n`);
    register('s1', { address: `127.0.0.1:${peer.port}`, token: TOKEN });

    const result = await sendCopilotSessionMessage('s1', 'hello', { homeDir: home });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('rejected the message: bad request from') });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('fails cleanly for sessions that are not steerable, gone, silent or talking nonsense', async () => {
    expect(await sendCopilotSessionMessage('unknown', 'hello', { homeDir: home })).toMatchObject({ ok: false, error: expect.stringContaining('sessionManagementTools') });
    expect(await sendCopilotSessionMessage('unknown', '   ', { homeDir: home })).toEqual({ ok: false, error: 'Nothing to send.' });

    // A port nothing listens on: bind one, note it, close it again.
    const closed = await listen(() => null);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    register('gone', { address: `127.0.0.1:${closed.port}`, token: TOKEN });
    expect(await sendCopilotSessionMessage('gone', 'hello', { homeDir: home })).toMatchObject({ ok: false, error: expect.stringMatching(/no longer listening|Could not reach/) });

    const silent = await listen(() => null);
    register('silent', { address: `127.0.0.1:${silent.port}`, token: TOKEN });
    expect(await sendCopilotSessionMessage('silent', 'hello', { homeDir: home, timeoutMs: 150 })).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });

    const nonsense = await listen(() => 'HTTP/1.1 400 Bad Request\n');
    register('nonsense', { address: `127.0.0.1:${nonsense.port}`, token: TOKEN });
    expect(await sendCopilotSessionMessage('nonsense', 'hello', { homeDir: home })).toMatchObject({ ok: false, error: expect.stringContaining('unreadable reply') });
  });
});
