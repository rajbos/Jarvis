// ── Diagnostic hand-off to the chat panel ─────────────────────────────────────
// Any part of the renderer can hand a DiagnosticReport to the chat, which shows
// it as a card the user can investigate from (log tail, links, retry, and an
// optional explanation by the local model).
import type { DiagnosticReport } from '../types';

const SHOW_DIAGNOSTIC_EVENT = 'jarvis:show-diagnostic';

export function showDiagnosticInChat(report: DiagnosticReport): void {
  window.dispatchEvent(new CustomEvent<DiagnosticReport>(SHOW_DIAGNOSTIC_EVENT, { detail: report }));
}

export function onShowDiagnostic(cb: (report: DiagnosticReport) => void): () => void {
  const listener = (event: Event) => cb((event as CustomEvent<DiagnosticReport>).detail);
  window.addEventListener(SHOW_DIAGNOSTIC_EVENT, listener);
  return () => window.removeEventListener(SHOW_DIAGNOSTIC_EVENT, listener);
}

/** Plain-text rendering used for "Copy details" and as model context. */
export function diagnosticToText(report: DiagnosticReport, logLines: string[] = []): string {
  const parts = [
    `${report.title} (${report.source}, ${report.occurredAt})`,
    report.summary,
    '',
    ...report.facts.map((f) => `${f.label}: ${f.value}`),
  ];
  if (logLines.length > 0) {
    parts.push('', 'Recent log lines:', ...logLines);
  }
  return parts.join('\n');
}

export function explainPrompt(report: DiagnosticReport, logLines: string[]): string {
  const parts = [
    `Explain the Jarvis diagnostic "${report.title}" above in plain language: what most likely went wrong, ` +
    'whether the cause is on my machine, on GitHub, or in the release itself, and what I should check next. ' +
    'Use the read_app_log tool if you need more log context.',
  ];
  if (logLines.length > 0) parts.push('', 'Recent log lines:', ...logLines);
  return parts.join('\n');
}
