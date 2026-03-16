// ── Agent Approval Panel ──────────────────────────────────────────────────────
// Shows structured findings from a completed agent session with approve/reject buttons.
import { useState } from 'preact/hooks';
import type { AgentFinding, AgentSession } from '../types';

const FINDING_ICON: Record<string, string> = {
  ignore: '✅',
  investigate: '🔍',
  action_required: '⚠️',
};

const ACTION_LABEL: Record<string, string> = {
  close_notifications: 'Dismiss notifications',
  create_issue: 'Create GitHub issue',
  clone_repo: 'Clone repository',
  none: '',
};

interface FindingRowProps {
  finding: AgentFinding;
  onApprove: () => void;
  onReject: () => void;
}

function FindingRow({ finding, onApprove, onReject }: FindingRowProps) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const icon = FINDING_ICON[finding.finding_type] ?? '❓';
  const notifCount = (finding.action_data?.notification_ids as unknown[] | undefined)?.length ?? 0;
  const actionLabel = (() => {
    if (finding.action_type === 'close_notifications') {
      return notifCount > 0 ? `Dismiss ${notifCount} notification${notifCount === 1 ? '' : 's'}` : 'Dismiss notifications';
    }
    return ACTION_LABEL[finding.action_type] ?? finding.action_type;
  })();
  const hasAction = finding.action_type !== 'none';

  const handleApprove = async () => {
    setBusy(true);
    try { await onApprove(); } finally { setBusy(false); }
  };

  const handleReject = async () => {
    setBusy(true);
    try { await onReject(); } finally { setBusy(false); }
  };

  const stateLabel = (() => {
    if (finding.execution_error) return `⚠ Failed: ${finding.execution_error}`;
    if (finding.executed_at) return '✓ Done';
    if (finding.approved === 0) return '✗ Skipped';
    if (finding.approved === 1 && !finding.executed_at) return '⏳ Executing…';
    return null;
  })();

  return (
    <div class={`agent-finding agent-finding--${finding.finding_type}`}>
      <div class="agent-finding-header">
        <span class="agent-finding-icon">{icon}</span>
        <span class="agent-finding-subject">{finding.subject}</span>
        <span class={`agent-finding-badge agent-finding-badge--${finding.finding_type}`}>
          {finding.finding_type}
        </span>
      </div>

      <p class="agent-finding-reason">{finding.reason}</p>

      {finding.pattern && (
        <p class="agent-finding-pattern">
          <strong>Pattern:</strong> {finding.pattern}
        </p>
      )}

      {finding.action_type === 'create_issue' && finding.action_data && (
        <div class="agent-finding-issue-preview">
          <div class="agent-finding-issue-title">
            <strong>Issue title:</strong> {String(finding.action_data.issue_title ?? '')}
          </div>
          {finding.action_data.issue_body && (
            <div class="agent-finding-issue-toggle">
              <button class="agent-toggle-body-btn" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Hide issue body ▲' : 'Preview issue body ▼'}
              </button>
              {expanded && (
                <pre class="agent-issue-body">{String(finding.action_data.issue_body)}</pre>
              )}
            </div>
          )}
        </div>
      )}

      {hasAction && (
        <div class="agent-finding-actions">
          {stateLabel ? (
            <span class={`agent-finding-state${finding.executed_at ? ' done' : finding.approved === 0 ? ' skipped' : ''}`}>
              {stateLabel}
            </span>
          ) : (
            <>
              <span class="agent-action-label">Proposed: {actionLabel}</span>
              <div class="agent-finding-btns">
                <button
                  class="agent-approve-btn"
                  onClick={() => void handleApprove()}
                  disabled={busy}
                  title={`Approve: ${actionLabel}`}
                >
                  {busy ? '…' : '✓ Yes, do it'}
                </button>
                <button
                  class="agent-reject-btn"
                  onClick={() => void handleReject()}
                  disabled={busy}
                  title="Skip this action"
                >
                  {busy ? '…' : '✗ Skip'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface AgentApprovalPanelProps {
  session: AgentSession;
  onFindingUpdate: (sessionId: number) => void;
  onNotificationsDismissed?: (ids: string[]) => void;
}

export function AgentApprovalPanel({ session, onFindingUpdate, onNotificationsDismissed }: AgentApprovalPanelProps) {
  const actionableFindings = session.findings.filter((f) => f.action_type !== 'none');
  const infoFindings = session.findings.filter((f) => f.action_type === 'none');

  const handleApprove = async (finding: AgentFinding) => {
    await window.jarvis.agentsApproveFinding(finding.id);
    const execResult = await window.jarvis.agentsExecuteFinding(finding.id);
    if (!execResult.ok && execResult.error) {
      console.error('[AgentApproval] Execution failed:', execResult.error);
    }
    // Use the server-confirmed dismissed IDs (avoids relying on LLM-generated action_data)
    if (execResult.ok && finding.action_type === 'close_notifications') {
      const ids = execResult.dismissedIds ?? (finding.action_data?.notification_ids as string[] | undefined) ?? [];
      if (ids.length > 0) onNotificationsDismissed?.(ids);
    }
    onFindingUpdate(session.id);
  };

  const handleReject = async (finding: AgentFinding) => {
    await window.jarvis.agentsRejectFinding(finding.id);
    onFindingUpdate(session.id);
  };

  if (session.findings.length === 0) {
    return (
      <div class="agent-approval-panel">
        <p class="agent-no-findings">No structured findings were produced by the agent.</p>
      </div>
    );
  }

  return (
    <div class="agent-approval-panel">
      <div class="agent-approval-header">
        <span class="agent-approval-title">{'🔎 Agent Findings'}</span>
        <span class="agent-approval-meta">
          {session.agent_name} · {session.scope_value}
        </span>
      </div>

      {actionableFindings.length > 0 && (
        <div class="agent-findings-section">
          <h4 class="agent-findings-section-title">Proposed Actions</h4>
          {actionableFindings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              onApprove={() => handleApprove(f)}
              onReject={() => handleReject(f)}
            />
          ))}
        </div>
      )}

      {infoFindings.length > 0 && (
        <div class="agent-findings-section">
          <h4 class="agent-findings-section-title">Informational Findings</h4>
          {infoFindings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              onApprove={() => Promise.resolve()}
              onReject={() => Promise.resolve()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
