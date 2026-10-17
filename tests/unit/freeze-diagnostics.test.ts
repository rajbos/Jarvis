import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FREEZE_REPORT_COOLDOWN_MS,
  buildStallDiagnostic,
  buildUnresponsiveDiagnostic,
  reportFreeze,
  resetFreezeReportThrottle,
  setFreezeReportSender,
} from '../../src/main/freeze-diagnostics';

describe('freeze diagnostics', () => {
  beforeEach(() => {
    setFreezeReportSender(null);
    resetFreezeReportThrottle();
  });

  it('builds a stall report with duration, running tasks and no retry', () => {
    const r = buildStallDiagnostic(7400, 'running tasks: a, b', new Date('2026-01-01T00:00:00Z'));
    expect(r.source).toBe('stall');
    expect(r.title).toBe('Jarvis froze for ~7s');
    expect(r.facts).toContainEqual({ label: 'Running at the time', value: 'running tasks: a, b' });
    expect(r.logFilter).toBe('[Stall]');
    expect(r.retry).toBeUndefined();
  });

  it('builds a window report', () => {
    const r = buildUnresponsiveDiagnostic('main', 12_000);
    expect(r.source).toBe('window');
    expect(r.facts).toContainEqual({ label: 'Window', value: 'main' });
    expect(r.retry).toBeUndefined();
  });

  it('does nothing without a sender', () => {
    expect(reportFreeze(buildStallDiagnostic(5000, ''))).toBe(false);
  });

  it('throttles reports within the cooldown and allows one after it', () => {
    const send = vi.fn();
    setFreezeReportSender(send);
    const report = buildStallDiagnostic(5000, '');
    expect(reportFreeze(report, 1_000_000)).toBe(true);
    expect(reportFreeze(report, 1_000_000 + FREEZE_REPORT_COOLDOWN_MS - 1)).toBe(false);
    expect(reportFreeze(report, 1_000_000 + FREEZE_REPORT_COOLDOWN_MS)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('swallows sender errors', () => {
    setFreezeReportSender(() => { throw new Error('window gone'); });
    expect(() => reportFreeze(buildStallDiagnostic(5000, ''))).not.toThrow();
  });
});
