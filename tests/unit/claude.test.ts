/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Unit tests for the Claude (Claude Code OAuth) rate-limit service.
 *
 * Covers credential-file parsing, token-expiry logic, and parsing of the
 * anthropic-ratelimit-unified-* response headers — all pure/offline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadClaudeCodeCredentials,
  isTokenExpired,
  parseRateLimitHeaders,
} from '../../src/services/claude';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-claude-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCredentials(contents: unknown): string {
  const file = path.join(tmpDir, '.credentials.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

function headerGetter(headers: Record<string, string>): (name: string) => string | null {
  return (name) => headers[name] ?? null;
}

// ── loadClaudeCodeCredentials ─────────────────────────────────────────────────

describe('loadClaudeCodeCredentials', () => {
  it('returns null when the file does not exist', () => {
    expect(loadClaudeCodeCredentials(path.join(tmpDir, 'missing.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(loadClaudeCodeCredentials(writeCredentials('not json{'))).toBeNull();
  });

  it('returns null when claudeAiOauth.accessToken is missing', () => {
    expect(loadClaudeCodeCredentials(writeCredentials({ claudeAiOauth: {} }))).toBeNull();
    expect(loadClaudeCodeCredentials(writeCredentials({}))).toBeNull();
  });

  it('parses a full credentials file', () => {
    const file = writeCredentials({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-abc',
        refreshToken: 'sk-ant-ort01-xyz',
        expiresAt: 1_800_000_000_000,
        subscriptionType: 'pro',
        scopes: ['user:profile'],
      },
    });
    expect(loadClaudeCodeCredentials(file)).toEqual({
      accessToken: 'sk-ant-oat01-abc',
      refreshToken: 'sk-ant-ort01-xyz',
      expiresAt: 1_800_000_000_000,
      subscriptionType: 'pro',
      scopes: ['user:profile'],
    });
  });

  it('falls back to rateLimitTier for the subscription type', () => {
    const file = writeCredentials({
      claudeAiOauth: { accessToken: 'tok', rateLimitTier: 'max' },
    });
    expect(loadClaudeCodeCredentials(file)?.subscriptionType).toBe('max');
  });
});

// ── isTokenExpired ────────────────────────────────────────────────────────────

describe('isTokenExpired', () => {
  const now = 1_000_000;

  it('treats a missing expiry as expired', () => {
    expect(isTokenExpired(undefined, now)).toBe(true);
    expect(isTokenExpired(Number.NaN, now)).toBe(true);
  });

  it('applies the skew window', () => {
    expect(isTokenExpired(now + 30_000, now)).toBe(true);  // within 60s skew
    expect(isTokenExpired(now + 120_000, now)).toBe(false);
  });
});

// ── parseRateLimitHeaders ─────────────────────────────────────────────────────

describe('parseRateLimitHeaders', () => {
  it('reports not limited on a healthy 200 response', () => {
    const probe = parseRateLimitHeaders(200, headerGetter({
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-status': 'allowed',
    }));
    expect(probe.limited).toBe(false);
    expect(probe.resetAt).toBeNull();
    expect(probe.fiveHour).toEqual({ utilization: 0.42, reset: 1_800_000_000, limited: false });
    expect(probe.sevenDay).toBeNull();
  });

  it('detects a 429 with retry-after and derives resetAt from it', () => {
    const before = Math.floor(Date.now() / 1000);
    const probe = parseRateLimitHeaders(429, headerGetter({ 'retry-after': '1800' }));
    expect(probe.limited).toBe(true);
    expect(probe.retryAfterSec).toBe(1800);
    expect(probe.resetAt).toBeGreaterThanOrEqual(before + 1800);
  });

  it('detects an exhausted 5h window on a 200 response', () => {
    const probe = parseRateLimitHeaders(200, headerGetter({
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '1800003600',
    }));
    expect(probe.limited).toBe(true);
    expect(probe.resetAt).toBe(1_800_003_600);
  });

  it('picks the latest reset when both windows are exhausted', () => {
    const probe = parseRateLimitHeaders(429, headerGetter({
      'anthropic-ratelimit-unified-5h-remaining': '0',
      'anthropic-ratelimit-unified-5h-reset': '1800003600',
      'anthropic-ratelimit-unified-7d-remaining': '0',
      'anthropic-ratelimit-unified-7d-reset': '1800600000',
    }));
    expect(probe.limited).toBe(true);
    expect(probe.resetAt).toBe(1_800_600_000);
  });

  it('falls back to the overall unified reset header', () => {
    const probe = parseRateLimitHeaders(429, headerGetter({
      'anthropic-ratelimit-unified-status': 'rate_limited',
      'anthropic-ratelimit-unified-reset': '1800000000',
    }));
    expect(probe.limited).toBe(true);
    expect(probe.resetAt).toBe(1_800_000_000);
  });

  it('accepts ISO-8601 reset values', () => {
    const probe = parseRateLimitHeaders(200, headerGetter({
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '2027-01-15T10:00:00Z',
    }));
    expect(probe.fiveHour?.reset).toBe(Math.floor(Date.parse('2027-01-15T10:00:00Z') / 1000));
    expect(probe.limited).toBe(true);
  });

  it('handles a response with no rate-limit headers at all', () => {
    const probe = parseRateLimitHeaders(200, headerGetter({}));
    expect(probe.limited).toBe(false);
    expect(probe.fiveHour).toBeNull();
    expect(probe.sevenDay).toBeNull();
    expect(probe.resetAt).toBeNull();
  });
});
