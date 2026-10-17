import { useState, useEffect } from 'preact/hooks';
import type { DiagnosticReport } from '../types';
import { isIpcError } from '../types';
import { diagnosticToText } from './diagnostics';
import { copyToClipboard } from '../clipboard';

const LOG_TAIL_LINES = 30;

interface DiagnosticCardProps {
  report: DiagnosticReport;
  /** Null when no model is selected; the card stays useful without one. */
  onExplain: ((report: DiagnosticReport, logLines: string[]) => void) | null;
  busy: boolean;
}

/**
 * A problem reported by Jarvis itself, shown in the chat. Everything needed to
 * investigate is on the card, so it works even when Ollama is not running.
 */
export function DiagnosticCard({ report, onExplain, busy }: DiagnosticCardProps) {
  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.jarvis.getDiagnosticLogTail(report.logFilter, LOG_TAIL_LINES)
      .then((result) => { if (!cancelled) setLogLines(isIpcError(result) ? [] : result); })
      .catch(() => { if (!cancelled) setLogLines([]); });
    return () => { cancelled = true; };
  }, [report.id, report.logFilter]);

  const onCopy = () => {
    setActionError(null);
    void copyToClipboard(diagnosticToText(report, logLines ?? [])).then((ok) => {
      if (!ok) { setActionError('Could not copy the details to the clipboard'); return; }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const onOpenLog = () => {
    setActionError(null);
    void window.jarvis.openAppLog().then((r) => { if (!r.ok) setActionError(r.error ?? 'Could not open the log file'); });
  };

  const onRetry = () => {
    setRetrying(true);
    void window.jarvis.checkForUpdatesNow().finally(() => setRetrying(false));
  };

  return (
    <div class="ec-diag" role="group" aria-label={report.title}>
      <div class="ec-diag-head">
        <span class="ec-diag-icon" aria-hidden="true">{'⚠'}</span>
        <span class="ec-diag-title">{report.title}</span>
        <span class="ec-diag-time">{new Date(report.occurredAt).toLocaleTimeString()}</span>
      </div>
      <p class="ec-diag-summary">{report.summary}</p>
      <dl class="ec-diag-facts">
        {report.facts.map((f) => (
          <div class="ec-diag-fact" key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>

      <button class="ec-diag-log-toggle" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
        {showLog ? '▼' : '▶'}{` Recent log lines${logLines ? ` (${logLines.length})` : ''}`}
      </button>
      {showLog && (
        <pre class="ec-debug-pre ec-diag-log">
          {logLines === null ? 'Loading…' : logLines.length === 0 ? 'No matching log lines.' : logLines.join('\n')}
        </pre>
      )}

      <div class="ec-diag-actions">
        {onExplain && (
          <button class="ec-diag-btn ec-diag-btn--primary" disabled={busy || logLines === null} onClick={() => onExplain(report, logLines ?? [])}>
            Explain this
          </button>
        )}
        {report.retry === 'update-check' && (
          <button class="ec-diag-btn" disabled={retrying} onClick={onRetry}>{retrying ? 'Checking…' : 'Retry'}</button>
        )}
        <button class="ec-diag-btn" onClick={onOpenLog}>Open log</button>
        <button class="ec-diag-btn" onClick={onCopy}>{copied ? 'Copied' : 'Copy details'}</button>
        {report.links?.map((link) => (
          <button class="ec-diag-btn ec-diag-btn--link" key={link.url} onClick={() => void window.jarvis.shellOpenUrl(link.url)}>
            {link.label} {'↗'}
          </button>
        ))}
      </div>
      {!onExplain && <div class="ec-diag-hint">Select an Ollama model to have the chat explain this.</div>}
      {actionError && <div class="ec-diag-hint ec-diag-hint--error">{actionError}</div>}
    </div>
  );
}
