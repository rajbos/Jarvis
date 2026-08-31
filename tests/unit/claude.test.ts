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
  isTokenPotentiallyUsable,
  parseRateLimitHeaders,
  generatePkce,
  buildAuthorizeUrl,
  parseAuthorizationCode,
} from '../../src/services/claude';
import crypto from 'crypto';

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

// ── isTokenPotentiallyUsable ─────────────────────────────────────────────────

describe('isTokenPotentiallyUsable', () => {
  const now = 1_000_000;

  it('treats zero/missing expiry as usable (Claude Code sometimes writes 0)', () => {
    expect(isTokenPotentiallyUsable(0, now)).toBe(true);
    expect(isTokenPotentiallyUsable(undefined, now)).toBe(true);
    expect(isTokenPotentiallyUsable(Number.NaN, now)).toBe(true);
  });

  it('respects real expiry', () => {
    expect(isTokenPotentiallyUsable(now + 120_000, now)).toBe(true);
    expect(isTokenPotentiallyUsable(now - 1, now)).toBe(false);
  });
});

// ── OAuth PKCE helpers ────────────────────────────────────────────────────────

describe('generatePkce', () => {
  it('produces a verifier, its S256 challenge, and state equal to the verifier', () => {
    const pkce = generatePkce();
    expect(pkce.verifier.length).toBeGreaterThan(40);
    expect(pkce.state).toBe(pkce.verifier);
    const expected = crypto.createHash('sha256').update(pkce.verifier).digest()
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(pkce.challenge).toBe(expected);
  });

  it('generates unique values per call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes the PKCE parameters and Claude Code client id', () => {
    const url = buildAuthorizeUrl({ verifier: 'v', challenge: 'ch', state: 'st' });
    expect(url.startsWith('https://claude.ai/oauth/authorize?')).toBe(true);
    expect(url).toContain('code_challenge=ch');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=st');
    expect(url).toContain('client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url).toContain('response_type=code');
  });
});

describe('parseAuthorizationCode', () => {
  it('accepts a bare code', () => {
    expect(parseAuthorizationCode('abc123')).toEqual({ code: 'abc123' });
  });

  it('splits code#state as shown on the callback page', () => {
    expect(parseAuthorizationCode('abc123#state456')).toEqual({ code: 'abc123', state: 'state456' });
  });

  it('trims whitespace and rejects empty input', () => {
    expect(parseAuthorizationCode('  abc  ')).toEqual({ code: 'abc' });
    expect(parseAuthorizationCode('   ')).toBeNull();
    expect(parseAuthorizationCode('')).toBeNull();
  });

  it('treats a trailing # as no state', () => {
    expect(parseAuthorizationCode('abc#')).toEqual({ code: 'abc', state: undefined });
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
