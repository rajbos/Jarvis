import { describe, expect, it } from 'vitest';
import { buildUpdateDiagnostic, classifyUpdateError } from '../../src/main/update-diagnostics';

function err(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe('classifyUpdateError', () => {
  it('recognises a rejected signature or provenance check', () => {
    expect(classifyUpdateError(err('whatever', { code: 'ERR_UPDATER_INVALID_SIGNATURE' }))).toBe('verification-failed');
    expect(classifyUpdateError(err('New version 0.2.1 is not signed by the application owner: no publisherName'))).toBe('verification-failed');
  });

  it('recognises missing release metadata', () => {
    expect(classifyUpdateError(err('Cannot find latest.yml in the latest release artifacts (https://x): HttpError: 404', {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    }))).toBe('release-missing');
    expect(classifyUpdateError(err('HTTP error: Not Found', { statusCode: 404 }))).toBe('release-missing');
  });

  it('recognises rate limiting', () => {
    expect(classifyUpdateError(err('HTTP error: Too Many Requests', { statusCode: 429 }))).toBe('rate-limited');
    expect(classifyUpdateError(err('API rate limit exceeded for 1.2.3.4', { statusCode: 403 }))).toBe('rate-limited');
  });

  it('recognises network failures', () => {
    expect(classifyUpdateError(err('getaddrinfo ENOTFOUND api.github.com', { code: 'ENOTFOUND' }))).toBe('offline');
    expect(classifyUpdateError(err('net::ERR_INTERNET_DISCONNECTED'))).toBe('offline');
  });

  it('falls back to unknown, including for non-Error values', () => {
    expect(classifyUpdateError(err('something odd'))).toBe('unknown');
    expect(classifyUpdateError('a string')).toBe('unknown');
  });
});

describe('buildUpdateDiagnostic', () => {
  it('lists the raw error, code and status alongside the plain-language cause', () => {
    const report = buildUpdateDiagnostic(err('HTTP error: Not Found', { statusCode: 404, code: 'HTTP_ERROR_404' }), {
      currentVersion: '0.2.1',
      targetVersion: null,
      now: new Date('2026-10-10T12:00:00Z'),
    });

    expect(report).toMatchObject({
      id: 'updates-1791633600000',
      source: 'updates',
      occurredAt: '2026-10-10T12:00:00.000Z',
      logFilter: 'Update',
    });
    expect(report.facts).toEqual([
      { label: 'Cause', value: 'Release metadata missing' },
      { label: 'Installed version', value: '0.2.1' },
      { label: 'Error code', value: 'HTTP_ERROR_404' },
      { label: 'HTTP status', value: '404' },
      { label: 'Error', value: 'HTTP error: Not Found' },
    ]);
    expect(report.links).toEqual([{ label: 'Releases page', url: 'https://github.com/rajbos/Jarvis/releases' }]);
  });
});
