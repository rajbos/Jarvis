// ── Message a running Copilot CLI session ─────────────────────────────────────
// Delivers a prompt into a Copilot CLI session that is still open, so it runs
// in that session's own window instead of in a new process.
//
// A Copilot CLI session started with `sessionManagementTools.enabled` in
// ~/.copilot/settings.json listens on a loopback port for messages from peer
// sessions and records how to reach it in
//   ~/.copilot/session-management/<sessionId>.json  { sessionId, address, token }
// A request is one JSON line: { token, message: { senderSessionId, senderName, content } }
// and the reply is { sent: true, targetSessionName } or { error }.
//
// This is Copilot's own peer format (what its `send_session_message` tool
// speaks), not a documented API, and it may change between CLI versions — so
// every failure is reported to the caller rather than thrown.

import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CONTENT_CHARS = 8_000;
const MAX_REPLY_BYTES = 64 * 1024;

/** Identifies Jarvis to the receiving session for the lifetime of this process. */
const SENDER_SESSION_ID = randomUUID();
const SENDER_NAME = 'Jarvis';

export interface CopilotSessionEndpoint {
  host: string;
  port: number;
  token: string;
}

export type CopilotSessionMessageResult =
  | { ok: true; targetSessionName: string | null }
  | { ok: false; error: string };

export interface CopilotSessionMessageOptions {
  homeDir?: string;
  timeoutMs?: number;
}

function registryPath(sessionId: string, homeDir: string): string {
  return path.join(homeDir, '.copilot', 'session-management', `${sessionId}.json`);
}

/** Split "host:port" (the host may be a bracketed IPv6 literal). */
function parseAddress(address: string): { host: string; port: number } | null {
  const m = address.match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/**
 * Where a session accepts peer messages; null when it has not opted in (or its
 * registry entry is unreadable). Only loopback addresses are accepted, so a
 * tampered entry can't point the token at another machine.
 */
export async function readCopilotSessionEndpoint(
  sessionId: string,
  homeDir: string = os.homedir(),
): Promise<CopilotSessionEndpoint | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  let raw: string;
  try {
    raw = await fsp.readFile(registryPath(sessionId, homeDir), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = (parsed ?? {}) as Record<string, unknown>;
  if (typeof entry.address !== 'string' || typeof entry.token !== 'string' || !entry.token) return null;
  const address = parseAddress(entry.address);
  if (!address || !LOOPBACK_HOSTS.has(address.host)) return null;
  return { ...address, token: entry.token };
}

/** Whether a (running) session can be messaged in place. */
export async function isCopilotSessionSteerable(sessionId: string, homeDir: string = os.homedir()): Promise<boolean> {
  return (await readCopilotSessionEndpoint(sessionId, homeDir)) !== null;
}

function exchange(endpoint: CopilotSessionEndpoint, line: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString('utf-8'));
    };
    const timer = setTimeout(() => finish(chunks.length > 0 ? null : new Error('timed out')), timeoutMs);
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REPLY_BYTES) {
        finish(new Error('reply too large'));
        return;
      }
      chunks.push(chunk);
      // The reply is a single JSON line; don't wait for the peer to hang up.
      if (chunk.includes(0x0a)) finish(null);
    });
    socket.on('end', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('error', (err) => finish(err));
  });
}

/**
 * Deliver `content` as a prompt to the running Copilot CLI session `sessionId`.
 * Resolves with the outcome; never rejects and never includes the token in an error.
 */
export async function sendCopilotSessionMessage(
  sessionId: string,
  content: string,
  options: CopilotSessionMessageOptions = {},
): Promise<CopilotSessionMessageResult> {
  const text = content.trim().slice(0, MAX_CONTENT_CHARS);
  if (!text) return { ok: false, error: 'Nothing to send.' };
  const endpoint = await readCopilotSessionEndpoint(sessionId, options.homeDir);
  if (!endpoint) {
    return { ok: false, error: 'This Copilot session does not accept messages (it was started without sessionManagementTools enabled).' };
  }

  const request = JSON.stringify({
    token: endpoint.token,
    message: { senderSessionId: SENDER_SESSION_ID, senderName: SENDER_NAME, content: text },
  });
  let reply: string;
  try {
    reply = await exchange(endpoint, `${request}\n`, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') return { ok: false, error: 'The Copilot session is no longer listening — it may have been closed.' };
    return { ok: false, error: `Could not reach the Copilot session: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.trim()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'The Copilot session sent an unreadable reply (its message format may have changed).' };
  }
  if (parsed.sent === true) {
    return { ok: true, targetSessionName: typeof parsed.targetSessionName === 'string' ? parsed.targetSessionName : null };
  }
  const reason = typeof parsed.error === 'string' ? parsed.error.split(endpoint.token).join('…').slice(0, 200) : 'no reason given';
  return { ok: false, error: `The Copilot session rejected the message: ${reason}` };
}
