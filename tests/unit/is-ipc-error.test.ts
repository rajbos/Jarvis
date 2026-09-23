import { describe, it, expect } from 'vitest';
import { isIpcError } from '../../src/plugins/types';

describe('isIpcError', () => {
  it('returns true for a well-formed error payload', () => {
    expect(isIpcError({ ok: false, error: 'boom' })).toBe(true);
  });

  it('returns false for a success payload', () => {
    expect(isIpcError({ ok: true })).toBe(false);
  });

  it('returns false for an array success payload', () => {
    expect(isIpcError([1, 2, 3])).toBe(false);
  });

  it('returns false when ok is false but error is missing', () => {
    expect(isIpcError({ ok: false })).toBe(false);
  });

  it('returns false when error is not a string', () => {
    expect(isIpcError({ ok: false, error: 42 })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isIpcError(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isIpcError('error')).toBe(false);
    expect(isIpcError(42)).toBe(false);
    expect(isIpcError(undefined)).toBe(false);
  });
});
