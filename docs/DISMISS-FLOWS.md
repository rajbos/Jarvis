# Dismiss Data Flows

This document describes every surface in Jarvis where notifications can be dismissed, how automatic each flow is, and the call chain involved.

---

## Overview

There are four distinct dismiss patterns, ordered from most- to least-automatic:

| # | Pattern | Trigger | User action needed |
|---|---------|---------|-------------------|
| 1 | **Boot cache pre-warm** | App startup | None (read-only, no dismiss) |
| 2 | **Background auto-dismiss sweep** | Scheduled task in the main process | None (results shown in a dashboard banner and history panel) |
| 3 | **Per-item / group dismiss** | User action in notification list | Per item or per workflow group |
| 4 | **Agent-initiated dismiss** | Agent session completes | Review + approve |

---

## 1. Boot Cache Pre-Warm

**Files:** [src/main/background-tasks.ts](../src/main/background-tasks.ts), [src/plugins/notifications/handler.ts](../src/plugins/notifications/handler.ts)  
**Called from:** `startBackgroundTasks()` (invoked from `initialize()` in [src/main/index.ts](../src/main/index.ts))

Nothing is dismissed here. These flows populate caches so later checks can resolve recovery status without extra user-triggered fetches.

### `runBootWorkflowCheck(db, getWindow)`

Registered as the `github-workflow-cache-prewarm` background task and run once at startup when GitHub auth is ready (`scheduler.runNow(...)`).

```
startBackgroundTasks(db, getWindow, { githubReady })
  └─ scheduler.runNow('github-workflow-cache-prewarm')
       └─ runBootWorkflowCheck(db, getWindow)
            ├─ Query DB: repos with CheckSuite/WorkflowRun notifications
            ├─ Filter out repos whose workflow cache is < 30 min old
            ├─ If estimated API calls > 50 AND rate-limit remaining < 1000 → skip
            └─ For each stale repo:
                 └─ fetchAndStoreWorkflowData(...)
                      ├─ GET /repos/{owner}/{repo}/actions/runs
                      └─ Stores results in github_workflow_runs table
```

Rate-limit safeguards:
- **Freshness guard:** skips repos whose cached data is < 30 minutes old.
- **Budget guard:** if estimated calls > `BOOT_CHECK_MAX_ESTIMATED_CALLS` (50) and GitHub core rate-limit remaining < `BOOT_CHECK_RATE_LIMIT_THRESHOLD` (1000), the entire pre-warm is skipped.

### `prewarmRuddrCache(db)`

**File:** [src/plugins/groups/handler.ts](../src/plugins/groups/handler.ts)  
Called directly from `startBackgroundTasks()`. Seeds Ruddr project data — and the persisted Ruddr budget cache — from the DB, then refreshes the project list via the Browser Companion extension. No dismissals occur.

Budgets are cached in the `ruddr_budgets` table and re-scraped at most once every 4 hours (`RUDDR_BUDGET_TTL_MS`). Opening the Groups dashboard renders the cached figures immediately and only re-scrapes projects whose cache has expired; the dashboard **Refresh** button and the per-project 💰 button bypass the TTL.

---

## 2. Background Auto-Dismiss Sweep (Fully Automatic)

**Files:** [src/main/background-tasks.ts](../src/main/background-tasks.ts), [src/plugins/notifications/handler.ts](../src/plugins/notifications/handler.ts), [src/plugins/dashboard/DashboardPanel.tsx](../src/plugins/dashboard/DashboardPanel.tsx), [src/plugins/notifications/AutoDismissHistoryPanel.tsx](../src/plugins/notifications/AutoDismissHistoryPanel.tsx)

The main process owns a recurring `github-auto-dismiss` background task, so the sweep keeps running whether or not the Dashboard is open. It first runs `GITHUB_AUTO_DISMISS_INITIAL_DELAY_MS` (90 s) after startup, then every `GITHUB_AUTO_DISMISS_INTERVAL_MS` (10 min). It dismisses notifications **without a confirmation click**, and records every dismissal in the `auto_dismiss_log` table so it can be reviewed afterwards.

> This replaces the earlier renderer-side "smart banners" (`RecoverableBanner`, `ClosedPrBanner`, `ClosedIssueBanner`), which ran their checks on Dashboard mount and required a "Dismiss N notifications" click.

```
Background task 'github-auto-dismiss'
  └─ runAutoDismissSweep(db, getWindow)
       ├─ loadGitHubAuth(db) — skip if not authenticated
       ├─ Runs four steps in parallel:
       │    ├─ runRecoverableStep     (reason: recovered_workflow)
       │    ├─ runClosedPrStep        (reasons: closed_pr_dependabot / closed_pr_merged_me / closed_pr_closed_me)
       │    ├─ runClosedIssueStep     (reasons: closed_issue_via_pr / closed_issue_me / closed_issue_collab_pr)
       │    └─ runDeletedBranchStep   (reason: deleted_branch)
       │         Each dismissal → dismissStoredNotification(db, token, n)
       │              ├─ PATCH /notifications/threads/{id}  (failure only logged)
       │              └─ DELETE FROM github_notifications WHERE id = ?
       ├─ logAutoDismissEntries(db, logEntries) → INSERT INTO auto_dismiss_log
       ├─ saveDatabase()  (only when something was dismissed)
       └─ webContents.send('github:auto-dismiss-complete', { result, logEntries })
          + 'github:notification-counts-updated' when counts changed
```

### Step rules

| Step | Candidates | Dismissed when |
|------|------------|----------------|
| **Recovered workflows** | `CheckSuite` / `WorkflowRun` notifications, grouped by repo and workflow name | The `github_workflow_runs` cache has a *successful* run of the same workflow (and branch, if the title names one) that started after the newest notification. Fetches workflow data first if the repo has no cached runs. |
| **Closed / merged PRs** | `PullRequest` notifications, grouped by subject URL | The PR is no longer open **and** it is a Dependabot PR or was closed/merged by the authenticated user. PRs closed by others are left alone. |
| **Closed issues** | `Issue` notifications, grouped by subject URL | The issue is closed **and** it was closed by the user, closed via a merged PR, or closed via a collaborator's PR. |
| **Deleted branches** | Notifications returned by `listDeletedBranchNotifications()` | The notification's branch no longer exists on GitHub. |

### Surfacing results in the UI

```
DashboardPanel
  └─ window.jarvis.onAutoDismissComplete(({ result, logEntries }) => ...)
       ├─ result.total > 0 → <AutoDismissSummaryBanner> (per-step counts, acknowledge button)
       ├─ After acknowledging (or if nothing was dismissed) → compact
       │    "Auto-dismissed N notifications" line with a history button
       └─ Own-repo triage list (3c) only loads once the first sweep has finished,
          so it never shows notifications that are about to be auto-dismissed

AutoDismissHistoryPanel (opened from the history button)
  ├─ window.jarvis.listAutoDismissLog(limit)  → IPC: github:list-auto-dismiss-log
  └─ window.jarvis.getAutoDismissStats()      → IPC: github:auto-dismiss-stats
```

While the first sweep is still running, the Dashboard shows a "Verifying N notifications against GitHub…" progress banner.

---

## 2b. Issues Closed by Me (Org view, User-Confirmed)

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

All user-triggered dismiss paths (2b, 3a–3c) go through the same IPC operation. The background sweep (2) and agent findings (4) run in the main process and perform the same two steps — `PATCH` the thread, then delete the local row — without going through IPC:

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
- **Recovery checks** in the auto-dismiss sweep read the `github_workflow_runs` cache (populated by the boot pre-warm), and only fetch from the API when a repo has no cached runs at all.
- **`dismissedNotifIds` prop** — `DashboardPanel` passes a `ReadonlySet<string>` of already-dismissed IDs down to `NotificationList` components so they can filter their local lists without a fresh DB fetch.
