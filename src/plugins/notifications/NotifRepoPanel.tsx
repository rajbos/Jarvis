import { useState, useEffect } from 'preact/hooks';
import { relativeAge, notifDescription, isDirect } from '../shared/utils';
import type { StoredNotification } from '../types';
import { AgentSelector } from '../agents/AgentSelector';

// Minimum notifications in a group to show the Analyse button
const ANALYSE_THRESHOLD = 2;

// Subject types treated as workflow/CI notifications for grouping purposes
const WORKFLOW_TYPES = new Set(['CheckSuite', 'WorkflowRun']);

const TYPE_ICON: Record<string, string> = {
  Issue: '\uD83D\uDC1B',
  PullRequest: '\uD83D\uDD00',
  Release: '\uD83C\uDF89',
  Commit: '\uD83D\uDCBE',
  Discussion: '\uD83D\uDCAC',
  CheckSuite: '\u274C',
};

// ── Workflow grouping ─────────────────────────────────────────────────────────

interface NotifGroup {
  /** Workflow name (subject_title) for CI groups, null for the "other" catch-all */
  workflowName: string | null;
  notifications: StoredNotification[];
}

/**
 * Group notifications by workflow name when there are 2 or more distinct
 * workflow names. Otherwise returns a single flat group (no grouping needed).
 */
function groupNotifications(notifications: StoredNotification[]): { groups: NotifGroup[]; isGrouped: boolean } {
  const workflowNotifs = notifications.filter((n) => WORKFLOW_TYPES.has(n.subject_type));
  const otherNotifs = notifications.filter((n) => !WORKFLOW_TYPES.has(n.subject_type));

  const byWorkflow = new Map<string, StoredNotification[]>();
  for (const n of workflowNotifs) {
    const name = n.subject_title;
    if (!byWorkflow.has(name)) byWorkflow.set(name, []);
    byWorkflow.get(name)!.push(n);
  }

  // Only split into groups when there are 2+ distinct workflow names
  const isGrouped = byWorkflow.size >= 2 || (byWorkflow.size >= 1 && otherNotifs.length > 0);

  if (!isGrouped) {
    return { groups: [{ workflowName: null, notifications }], isGrouped: false };
  }

  const groups: NotifGroup[] = [];
  for (const [name, notifs] of byWorkflow) {
    groups.push({ workflowName: name, notifications: notifs });
  }
  if (otherNotifs.length > 0) {
    groups.push({ workflowName: null, notifications: otherNotifs });
  }
  return { groups, isGrouped: true };
}

async function openNotifUrl(n: StoredNotification): Promise<void> {
  if (n.subject_type === 'CheckSuite') {
    if (n.subject_url) {
      const runUrl = await window.jarvis.getRunUrlForCheckSuite(n.subject_url);
      window.jarvis.openUrl(runUrl ?? `https://github.com/${n.repo_full_name}/actions`);
    } else {
      window.jarvis.openUrl(`https://github.com/${n.repo_full_name}/actions`);
    }
    return;
  }
  if (n.subject_type === 'WorkflowRun') {
    const url = n.subject_url
      ? n.subject_url.replace('https://api.github.com/repos/', 'https://github.com/')
      : `https://github.com/${n.repo_full_name}/actions`;
    window.jarvis.openUrl(url);
    return;
  }
  const url = n.subject_url
    ? n.subject_url
        .replace('https://api.github.com/repos/', 'https://github.com/')
        .replace(/\/pulls\/(\d+)$/, '/pull/$1')
        .replace(/\/issues\/(\d+)$/, '/issues/$1')
        .replace(/\/commits\/([a-f0-9]+)$/, '/commit/$1')
        .replace(/\/releases\/(\d+)$/, '/releases')
    : `https://github.com/${n.repo_full_name}`;
  window.jarvis.openUrl(url);
}

// ── Notification row ──────────────────────────────────────────────────────────

function NotifRow({ n, onContextMenu }: { n: StoredNotification; onContextMenu: (e: MouseEvent) => void }) {
  return (
    <div
      key={n.id}
      class="org-item"
      style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem', cursor: 'pointer' }}
      onClick={() => openNotifUrl(n)}
      onContextMenu={onContextMenu}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', width: '100%' }}>
        <span style={{ flexShrink: 0 }}>{TYPE_ICON[n.subject_type] ?? '\u2022'}</span>
        <span class="org-label" style={{ flex: 1, fontWeight: 500, whiteSpace: 'normal', lineHeight: 1.35 }}>{n.subject_title}</span>
        <span class={isDirect(n.reason) ? 'notif-involvement-direct' : 'notif-involvement-following'}>
          {isDirect(n.reason) ? 'involved' : 'following'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap', paddingLeft: '1.4rem' }}>
        <span class="repo-card-badge">{notifDescription(n.subject_type, n.reason)}</span>
        <span class="repo-card-date">{relativeAge(n.updated_at)}</span>
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface NotifRepoPanelProps {
  repoFullName: string;
  notifications: StoredNotification[];
  onClose: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onDismiss?: (id: string) => void;
  onAgentSessionStarted?: (sessionId: number) => void;
}

export function NotifRepoPanel({ repoFullName, notifications, onClose, onRefresh, refreshing, onDismiss, onAgentSessionStarted }: NotifRepoPanelProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; notifId: string } | null>(null);
  const [agentTarget, setAgentTarget] = useState<{ workflowFilter?: string } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ctxMenu]);

  const handleDismiss = async (id: string) => {
    setCtxMenu(null);
    await window.jarvis.dismissNotification(id);
    onDismiss?.(id);
  };

  const { groups, isGrouped } = groupNotifications(notifications);

  return (
    <div class="repo-panel">
      <div class="repo-panel-header">
        <span class="repo-panel-title">{repoFullName.split('/')[1]}</span>
        <span style={{ flex: 1 }} />
        {/* Show global Analyse button only when not grouped (single workflow or no CI notifs) */}
        {!isGrouped && notifications.length >= ANALYSE_THRESHOLD && (
          <button
            class="notif-analyse-btn"
            title="Analyse with an LLM agent — detects workflow failures, checks CI logs, and suggests fixes or issues to file"
            onClick={() => setAgentTarget({})}
          >
            {'🤖 Analyse'}
          </button>
        )}
        {onRefresh && (
          <span
            class={`notif-refresh-btn${refreshing ? ' notif-refresh-btn-spinning' : ''}`}
            title={refreshing ? 'Refreshing\u2026' : 'Refresh notifications for this repo'}
            onClick={refreshing ? undefined : onRefresh}
          >{'\u21BB'}</span>
        )}
        <span class="notif-badge notif-badge-large">{'\uD83D\uDD14'} {notifications.length}</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      {isGrouped ? (
        // ── Grouped view ────────────────────────────────────────────────────
        groups.map((group) => (
          <div key={group.workflowName ?? '__other__'} class="notif-workflow-group">
            <div class="notif-workflow-group-header">
              <span class="notif-workflow-group-icon">
                {group.workflowName ? '\u2699\uFE0F' : '\uD83D\uDCCB'}
              </span>
              <span class="notif-workflow-group-name">
                {group.workflowName ?? 'Other notifications'}
              </span>
              <span class="notif-workflow-group-count">{group.notifications.length}</span>
              {group.workflowName && group.notifications.length >= ANALYSE_THRESHOLD && (
                <button
                  class="notif-analyse-btn notif-analyse-btn--inline"
                  title={`Analyse "${group.workflowName}" with an LLM agent`}
                  onClick={() => setAgentTarget({ workflowFilter: group.workflowName! })}
                >
                  {'🤖 Analyse'}
                </button>
              )}
            </div>
            {group.notifications.map((n) => (
              <NotifRow
                key={n.id}
                n={n}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, notifId: n.id }); }}
              />
            ))}
          </div>
        ))
      ) : (
        // ── Flat view (single workflow or no CI) ────────────────────────────
        notifications.map((n) => (
          <NotifRow
            key={n.id}
            n={n}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, notifId: n.id }); }}
          />
        ))
      )}

      {ctxMenu && (
        <div
          class="notif-ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button class="notif-ctx-menu-item" onClick={() => handleDismiss(ctxMenu.notifId)}>
            Dismiss
          </button>
        </div>
      )}

      {agentTarget !== null && (
        <AgentSelector
          repoFullName={repoFullName}
          workflowFilter={agentTarget.workflowFilter}
          onClose={() => setAgentTarget(null)}
          onSessionStarted={(sessionId) => {
            setAgentTarget(null);
            onAgentSessionStarted?.(sessionId);
          }}
        />
      )}
    </div>
  );
}
