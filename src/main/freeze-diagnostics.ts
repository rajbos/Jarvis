// Surfaces main-thread stalls and unresponsive windows in the chat panel as a
// DiagnosticReport card, instead of only writing them to the log. Kept free of
// Electron imports; the main process registers where reports are delivered.
import type { DiagnosticReport } from '../types/ipc-payloads';

/** Stalls shorter than this are only logged (the watchdog logs from 1s). */
export const STALL_NOTIFY_THRESHOLD_MS = 3_000;
/** A window must stay unresponsive this long before the user is told. */
export const UNRESPONSIVE_NOTIFY_THRESHOLD_MS = 5_000;
/** At most one freeze card per this long, so a bad stretch can't flood the chat. */
export const FREEZE_REPORT_COOLDOWN_MS = 5 * 60_000;

type Sender = (report: DiagnosticReport) => void;

let sender: Sender | null = null;
let lastReportAt = 0;

export function setFreezeReportSender(fn: Sender | null): void {
  sender = fn;
}

export function resetFreezeReportThrottle(): void {
  lastReportAt = 0;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function buildStallDiagnostic(lagMs: number, context: string, now: Date = new Date()): DiagnosticReport {
  const facts = [{ label: 'Blocked for', value: `~${seconds(lagMs)}` }];
  if (context) facts.push({ label: 'Running at the time', value: context });
  return {
    id: `stall-${now.getTime()}`,
    source: 'stall',
    title: `Jarvis froze for ~${seconds(lagMs)}`,
    summary: 'The main process was blocked, so the window did not respond for a moment. '
      + 'The background tasks that were running at the time are listed below; they are the likely cause.',
    facts,
    logFilter: '[Stall]',
    occurredAt: now.toISOString(),
  };
}

export function buildUnresponsiveDiagnostic(windowName: string, durationMs: number, now: Date = new Date()): DiagnosticReport {
  return {
    id: `window-${windowName}-${now.getTime()}`,
    source: 'window',
    title: 'Jarvis window stopped responding',
    summary: `The ${windowName} window did not respond for about ${seconds(durationMs)} before recovering.`,
    facts: [
      { label: 'Window', value: windowName },
      { label: 'Unresponsive for', value: `~${seconds(durationMs)}` },
    ],
    logFilter: 'unresponsive',
    occurredAt: now.toISOString(),
  };
}

/** Delivers the report unless one was delivered within the cooldown. Returns whether it was sent. */
export function reportFreeze(report: DiagnosticReport, nowMs: number = Date.now()): boolean {
  if (!sender) return false;
  if (lastReportAt && nowMs - lastReportAt < FREEZE_REPORT_COOLDOWN_MS) return false;
  lastReportAt = nowMs;
  try {
    sender(report);
  } catch {
    /* surfacing is best effort */
  }
  return true;
}
