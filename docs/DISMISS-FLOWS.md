# Dismiss Data Flows

This document describes every surface in Jarvis where notifications can be dismissed, how automatic each flow is, and the call chain involved.

---

## Overview

There are four distinct dismiss patterns, ordered from most- to least-automatic:

| # | Pattern | Trigger | User action needed |
|---|---------|---------|-------------------|
| 1 | **Boot cache pre-warm** | App startup | None (read-only, no dismiss) |
| 2 | **Smart banners** | Dashboard panel mount | One click to dismiss all |
| 3 | **Per-item / group dismiss** | User action in notification list | Per item or per workflow group |
| 4 | **Agent-initiated dismiss** | Agent session completes | Review + approve |

---

## 1. Boot Cache Pre-Warm

**File:** [src/plugins/notifications/handler.ts](../src/plugins/notifications/handler.ts)  
**Called from:** [src/main/index.ts](../src/main/index.ts) inside `initialize()`

Nothing is dismissed here. These flows populate caches so the UI can resolve recovery status instantly without user-triggered fetches.

### `runBootWorkflowCheck(db, getWindow)`

```
App startup (initialize())
  └─ runBootWorkflowCheck(db, getWindow)
       ├─ Query DB: repos with CheckSuite/WorkflowRun notifications
       ├─ Filter out repos whose workflow cache is < 30 min old
       ├─ If estimated API calls > 50 AND rate-limit remaining < 1000 → skip
       └─ For each stale repo:
            └─ fetchAndStoreWorkflowData(token, repoFullName, db)
                 ├─ GET /repos/{owner}/{repo}/actions/runs
                 └─ Stores results in github_workflow_runs table
```

Rate-limit safeguards:
- **Freshness guard:** skips repos whose cached data is < 30 minutes old.
- **Budget guard:** if estimated calls > `BOOT_CHECK_MAX_ESTIMATED_CALLS` (50) and GitHub core rate-limit remaining < `BOOT_CHECK_RATE_LIMIT_THRESHOLD` (1000), the entire pre-warm is skipped.

### `prewarmRuddrCache(db)`

**File:** [src/plugins/groups/handler.ts](../src/plugins/groups/handler.ts)  
Seeds Ruddr project data from DB cache or refreshes via the Browser Companion extension. No dismissals occur.

---

## 2. Smart Banners (Semi-Automatic Bulk Dismiss)

These banners appear automatically at the top of the Dashboard panel whenever certain conditions are detected. Each banner performs its own GitHub API checks on mount, and presents a single **"Dismiss N notifications"** button. No items are dismissed until the user clicks.

### 2a. `RecoverableBanner` — Workflows that recovered

**File:** [src/plugins/dashboard/DashboardPanel.tsx](../src/plugins/dashboard/DashboardPanel.tsx)  
**Trigger:** Rendered inside `DashboardPanel` whenever repos with CI notifications exist.

```
DashboardPanel mounts
  └─ <RecoverableBanner repoFullNames={[...]} />
       └─ useEffect (on mount)
            ├─ For each repo: window.jarvis.getWorkflowRecoveryStatus(repoFullName)
            │    └─ IPC → handler: checks github_workflow_runs cache
            │         Returns: { recovered: boolean, notificationIds: string[] }
            ├─ Collects all IDs where recovered === true
            └─ Renders banner if any found

  User clicks "Dismiss N notifications"
  └─ handleDismissAll()
       ├─ For each ID: window.jarvis.dismissNotification(id)
       │    └─ IPC: github:dismiss-notification
       │         ├─ PATCH /notifications/threads/{id}  (marks read on GitHub)
       │         ├─ DELETE FROM github_notifications WHERE id = ?
       │         └─ saveDatabase()
       └─ onDismissed() → triggers parent summary reload
```

**Safety:** Only dismisses notifications for workflows that have a *subsequent successful run* in the local cache (populated by the boot pre-warm above).

### 2b. `ClosedPrBanner` — Closed/merged PRs

**File:** [src/plugins/dashboard/DashboardPanel.tsx](../src/plugins/dashboard/DashboardPanel.tsx)  
**Trigger:** Rendered inside `DashboardPanel`, checks on mount.

```
DashboardPanel mounts
  └─ <ClosedPrBanner />
       └─ useEffect (on mount)
            ├─ window.jarvis.listPrNotifications()
            │    └─ IPC → SELECT from github_notifications WHERE subject_type = 'PullRequest'
            ├─ Groups by unique PR URL (max 50 PRs)
            ├─ Parallel API checks (concurrency 8):
            │    └─ window.jarvis.githubGetPrState(url)
            │         └─ IPC → GET /repos/.../pulls/{number}
            │              Returns: { state, isDependabot, closedByMe }
            ├─ Keeps only: isDependabot OR closedByMe (not PRs closed by others)
            └─ Renders banner if any found

  User clicks "Dismiss N notifications"
  └─ handleDismissAll()
       ├─ For each ID: window.jarvis.dismissNotification(id)  [same chain as above]
       ├─ setEntries([])  ← immediate local state clear (no stale banner during async reload)
       └─ onDismissed() → triggers parent summary reload
```

**Safety filter:** Only Dependabot PRs and PRs closed/merged by the authenticated user are surfaced. PRs closed by other contributors are excluded.

### 2c. `ClosedIssueBanner` — Issues closed by the user

**File:** [src/plugins/dashboard/DashboardPanel.tsx](../src/plugins/dashboard/DashboardPanel.tsx)  
**Trigger:** Rendered inside `DashboardPanel`, checks on mount.

```
DashboardPanel mounts
  └─ <ClosedIssueBanner />
       └─ useEffect (on mount)
            ├─ window.jarvis.listIssueNotifications()
            │    └─ IPC → SELECT from github_notifications WHERE subject_type = 'Issue'
            ├─ Groups by unique issue URL (max 50 issues)
            ├─ Parallel API checks (concurrency 8):
            │    └─ window.jarvis.githubGetIssueState(url)
            │         └─ IPC → GET /repos/.../issues/{number}
            │              Returns: { state, closedByMe, closedViaPr }
            ├─ Keeps only: closedByMe OR closedViaPr
            └─ Renders banner if any found

  User clicks "Dismiss N notifications"
  └─ handleDismissAll()  [same chain as above]
```

### 2d. `OrgNotifPanel` — Issues closed by me (Org view)

**File:** [src/plugins/notifications/OrgNotifPanel.tsx](../src/plugins/notifications/OrgNotifPanel.tsx)  
**Trigger:** Rendered when user opens an org notification panel. Checks on every `notifications` prop change.

```
OrgNotifPanel renders (notifications prop changes)
  └─ useEffect
       ├─ Filters to Issue-type notifications
       ├─ Parallel API checks (concurrency from CONCURRENCY constant):
       │    └─ window.jarvis.githubGetIssueState(url)
       │         Returns: { state, closedByMe }
       └─ Stores IDs where state === 'closed' && closedByMe

  User clicks "Dismiss N" (in "Issues you closed" banner)
  └─ handleDismissClosedByMe()
       ├─ For each ID: window.jarvis.dismissNotification(id)
       │    ├─ onDismiss?.(id)  ← propagates up to parent for list update
       └─ setClosedByMeIds([])  ← clears banner immediately
```

---

## 3. Per-Item and Per-Group Dismiss (Manual)

These flows require explicit user interaction for each item or group.

### 3a. Single notification dismiss (right-click menu)

Available in `NotifRepoPanel`, `OrgNotifPanel`, and `DashboardPanel`'s `NotificationList`.

```
User right-clicks notification → "Dismiss"
  └─ handleDismiss(id)
       └─ window.jarvis.dismissNotification(id)
            └─ IPC: github:dismiss-notification
                 ├─ PATCH /notifications/threads/{id}
                 ├─ DELETE FROM github_notifications WHERE id = ?
                 └─ saveDatabase()
  └─ onDismiss?.(id) → parent removes entry from list
```

### 3b. Per-workflow-group "Dismiss all" button

Available in `NotifRepoPanel` and `DashboardPanel`'s `NotificationList` component. Groups CI notifications by workflow name.

```
User clicks "Dismiss all" on a workflow group
  └─ handleDismissGroup(workflowName, [id1, id2, ...])
       ├─ setDismissingGroup(workflowName)  ← spinner state
       ├─ For each ID: window.jarvis.dismissNotification(id)  [same chain]
       ├─ setNotifications(prev.filter(n => !ids.includes(n.id)))  ← local state
       └─ setDismissingGroup(null)
```

### 3c. `DashboardNotificationTriage` — per-item dismiss in triage view

Notifications for the user's own repos are displayed in a triage list (people vs. bot/self/CI tabs). Each row has a dismiss button.

```
User clicks dismiss on a triage notification
  └─ handleDismiss(id)
       ├─ window.jarvis.dismissNotification(id)
       └─ onDismissed(id)
            └─ handleTriageNotificationDismissed(id) in DashboardPanel
                 └─ setOwnRepoNotifications(prev.filter(n => n.id !== id))
```

---

## 4. Agent-Initiated Dismiss (User-Approved)

**Files:** [src/plugins/agents/AgentApprovalPanel.tsx](../src/plugins/agents/AgentApprovalPanel.tsx), [src/plugins/agents/handler.ts](../src/plugins/agents/handler.ts)

An AI agent session can produce findings with `action_type: 'close_notifications'`. The user reviews and approves these in the `AgentApprovalPanel`.

```
Agent session completes
  └─ Finding stored in DB: { action_type: 'close_notifications', action_data: { notification_ids: [...] } }

  User clicks "✓ Yes, do it" on a finding
  └─ handleApprove(finding)
       ├─ window.jarvis.agentsApproveFinding(finding.id)
       │    └─ IPC → UPDATE agent_findings SET approved = 1
       ├─ window.jarvis.agentsExecuteFinding(finding.id)
       │    └─ IPC → agents:execute-finding
       │         ├─ Validates: approved === 1, not yet executed
       │         ├─ For each notification_id:
       │         │    ├─ PATCH /notifications/threads/{id}
       │         │    ├─ DELETE FROM github_notifications WHERE id = ?
       │         │    └─ Collects dismissed IDs (skips 404s gracefully)
       │         ├─ UPDATE agent_findings SET executed_at = datetime('now')
       │         └─ saveDatabase()
       │         Returns: { ok: true, dismissedIds: [...] }
       ├─ onNotificationsDismissed?.(ids)  ← update parent notification lists
       └─ Auto-reject stale siblings:
            For each other pending close_notifications finding in same session
            that shares any dismissed IDs → agentsRejectFinding(other.id)
```

**Key difference from other flows:** The agent uses `action_data.notification_ids` produced by the LLM, but the server returns the *server-confirmed* `dismissedIds` list. The renderer prefers the server-confirmed list, falling back to `action_data` only if the server returns an empty array.

---

## Common IPC/API Chain

All dismiss paths ultimately go through the same core operation:

```
window.jarvis.dismissNotification(id)          [preload.ts]
  ↓ IPC channel: 'github:dismiss-notification'
ipcMain.handle('github:dismiss-notification')   [notifications/handler.ts]
  ├─ loadGitHubAuth(db) — load stored token
  ├─ markNotificationRead(token, id)
  │    └─ PATCH https://api.github.com/notifications/threads/{id}
  │         ⚠️ Must use PATCH (marks read), NOT DELETE (unsubscribes)
  ├─ deleteNotification(db, id)
  │    └─ DELETE FROM github_notifications WHERE id = ?
  └─ saveDatabase()
```

---

## State Management Rules

- **Clear local state immediately** — after any dismiss (bulk or single), call `setEntries([])` or filter the local list *before* triggering a parent `load()` callback. This prevents stale banners or list entries remaining visible during the async reload.
- **Recovery banner data** comes from the boot pre-warm cache (`github_workflow_runs`), not a live API call on dismiss.
- **`dismissedNotifIds` prop** — `DashboardPanel` passes a `ReadonlySet<string>` of already-dismissed IDs down to `NotificationList` components so they can filter their local lists without a fresh DB fetch.
