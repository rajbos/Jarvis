# Graph Report - session-titles-review-3693bb  (2026-10-09)

## Corpus Check
- 291 files · ~312,052 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 4, .css 3, .nsh 1)

## Summary
- 2708 nodes · 6441 edges · 125 communities (119 shown, 6 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 166 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2d0a538f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- JarvisApi
- server.ts
- github-notifications.ts
- saveDatabase
- mcp-server/index.ts
- local-file-index.ts
- background-tasks.ts
- plugins/types.ts
- utils.ts
- copilot-usage.ts
- github-accounts.ts
- DashboardPanel.tsx
- getConfigValue
- Notification Intelligence & Agent Framework
- github-oauth.ts
- preact
- background.js
- local-discovery.ts
- main/index.ts
- ref_fs
- active-sessions.ts
- notifications/handler.ts
- local-agent-sessions.ts
- Contributing to Jarvis
- NotifRepoPanel.tsx
- fixtures.ts
- index.tsx
- Customer Project Budget & Actuals Lookup
- Repository Quality Improvement Agent
- pr-readiness.ts
- onedrive-onenote-cache.ts
- onedrive/handler.ts
- config.ts
- sql.js
- claude.ts
- package.json
- scripts
- vitest
- ActiveSessionsPanel.tsx
- OneNote Caching for Jarvis Groups
- rules
- mcp-server/handler.ts
- registerHandlers
- claude-agent.ts
- manifest.json
- Phase 2 — Agent plugin
- github-fetch.ts
- database.ts
- ErrorBoundary.tsx
- agents/handler.ts
- github-host.ts
- runner.ts
- ClaudePanel.tsx
- github-workflows.ts
- ref_node_fs
- onenote-reader.ts
- compilerOptions
- watch-electron.mjs
- devDependencies
- compilerOptions
- file-index-runner.ts
- CopilotUsageBadge.tsx
- dashboard/handler.ts
- Benevolent Product Owner
- github-repo-access.ts
- browser-extension.test.ts
- Database
- Jarvis Agent — Architecture Specification
- mcp-settings-section.tsx
- mock-jarvis-api.ts
- groups/handler.ts
- Jarvis MCP Server
- ensure-electron.mjs
- ensureRuddrCache
- task-failure-log.ts
- active-sessions/handler.ts
- compilerOptions
- compilerOptions
- build-renderer.mjs
- view-harness.ts
- screenshots.ts
- createBackgroundTaskScheduler
- README.md
- Jarvis Browser Companion — Browser Extension
- ollama-provider.ts
- github-repo-catalog.ts
- active-sessions.test.ts
- useViewHarness
- Initial Capabilities
- Product
- GroupsDashboardPanel.tsx
- Check Jarvis Database
- 11. Activity Tracking & Weekly Summaries
- bug_report.md
- Getting Started
- groups-ruddr-budget.test.ts
- BrowserCompanionPanel.tsx
- OneNoteCachePanel.tsx
- 10. Async Actor Pattern
- 4. Electron GUI Host
- 9. Container Isolation
- dependencies
- popup.js
- agents-handler.test.ts
- 17. Active Agent Sessions & PR Review Readiness
- 5. First-Run Onboarding Flow
- 7. MCP Extensibility
- pull_request_template.md
- content.js
- settings-and-about.view.test.ts
- 16. Copilot AI Credit Budget Tracking
- 18. Multiple GitHub Accounts & GHE.com
- feature_request.md
- task-scheduler.ts
- 13. Configuration
- notifications-multi-account.test.ts
- update-verification.ts
- allowScripts
- UpdateState
- logger.ts
- assets.d.ts
- startBackgroundTasks

## God Nodes (most connected - your core abstractions)
1. `JarvisApi` - 178 edges
2. `sql.js` - 107 edges
3. `vitest` - 96 edges
4. `saveDatabase()` - 69 edges
5. `safeHandle()` - 51 edges
6. `getSchema()` - 48 edges
7. `electron` - 41 edges
8. `logger` - 40 edges
9. `registerHandlers()` - 38 edges
10. `App()` - 36 edges

## Surprising Connections (you probably didn't know these)
- `Authentication` --references--> `resolveGitHubScopes()`  [INFERRED]
  docs/ARCHITECTURE.md → src/agent/config.ts
- `4. Agent-Initiated Dismiss (User-Approved)` --references--> `AgentApprovalPanel()`  [INFERRED]
  docs/DISMISS-FLOWS.md → src/plugins/agents/AgentApprovalPanel.tsx
- `IPC Handler Error Contract` --references--> `safeHandle()`  [INFERRED]
  docs/ARCHITECTURE.md → src/plugins/ipc-utils.ts
- `8.1 Main screen — Analyse button` --references--> `NotifRepoPanel()`  [INFERRED]
  docs/NOTIFICATION-INTELLIGENCE.md → src/plugins/notifications/NotifRepoPanel.tsx
- `View tests (headless browser)` --references--> `JarvisApi`  [INFERRED]
  CONTRIBUTING.md → src/plugins/types.ts

## Import Cycles
- None detected.

## Communities (125 total, 6 thin omitted)

### Community 1 - "server.ts"
Cohesion: 0.10
Nodes (28): ref_events, ws, registerHandlers(), ALLOWED_URL_SCHEMES, authTimeouts, BRIDGE_ORIGIN, BRIDGE_PORT, BridgeCommand (+20 more)

### Community 2 - "github-notifications.ts"
Cohesion: 0.10
Nodes (29): AccountScope, checkPRMerged(), deleteNotificationsOfUntrackedAccounts(), enrichNotificationActors(), worker(), extractActorFromSubject(), extractBranchFromTitle(), fetchLiveBranchNames() (+21 more)

### Community 3 - "saveDatabase"
Cohesion: 0.12
Nodes (43): What uses it, registerHandlers(), startPrimaryDiscovery(), activeDiscovery, lastDiscoveryProgress, setActiveDiscovery(), setLastDiscoveryProgress(), abortDiscovery() (+35 more)

### Community 4 - "mcp-server/index.ts"
Cohesion: 0.06
Nodes (58): DB_PATH, getSql(), INDEX_DB_PATH, openIndexSnapshot(), server, buildTermFilter(), deriveRoles(), findAnywhere() (+50 more)

### Community 5 - "local-file-index.ts"
Cohesion: 0.08
Nodes (38): ref_node_util, buildMatchExpression(), classifyFile(), CONFIG_BASENAMES, CONFIG_EXT, CONTENT_BUDGET, createMemoryIndexDatabase(), deleteFileRow() (+30 more)

### Community 6 - "background-tasks.ts"
Cohesion: 0.10
Nodes (18): ACTIVE_SESSIONS_INITIAL_DELAY_MS, ACTIVE_SESSIONS_INTERVAL_MS, COPILOT_USAGE_INITIAL_DELAY_MS, COPILOT_USAGE_INTERVAL_MS, getBackgroundTaskScheduler(), GITHUB_AUTO_DISMISS_INITIAL_DELAY_MS, GITHUB_AUTO_DISMISS_INTERVAL_MS, GITHUB_NOTIFICATIONS_INITIAL_DELAY_MS (+10 more)

### Community 7 - "plugins/types.ts"
Cohesion: 0.06
Nodes (39): OneNoteSectionPanel(), PageCard(), Props, SecretsScanPanelProps, ActiveSessionVerdict, AgentSessionOrigin, AutoDismissCompletePayload, AutoDismissReason (+31 more)

### Community 8 - "utils.ts"
Cohesion: 0.12
Nodes (30): LocalFolderPanel(), LocalFolderPanelProps, LocalRepoCard(), LocalRepoCardProps, LocalRepoPanelView(), LocalRepoPanelViewProps, LocalSortKey, LocalSubfolderPanel() (+22 more)

### Community 9 - "copilot-usage.ts"
Cohesion: 0.10
Nodes (26): AccountCredentials, EMPTY_USAGE, usageBase, CopilotRawResponse, AI_CREDIT_USD, AiCreditFetchResult, AiCreditModelUsage, AiCreditUsageItem (+18 more)

### Community 10 - "github-accounts.ts"
Cohesion: 0.11
Nodes (38): checkAllAccountsUsage(), getAccountBudget(), isScope(), lookupHostUser(), registerHandlers(), sameId(), setAccountBudget(), getGhCliToken() (+30 more)

### Community 11 - "DashboardPanel.tsx"
Cohesion: 0.08
Nodes (43): 2b. Issues Closed by Me (Org view, User-Confirmed), 3. Per-Item and Per-Group Dismiss (Manual), 3a. Single notification dismiss (right-click menu), 3b. Per-workflow-group "Dismiss all" button, 3c. `DashboardNotificationTriage` — per-item dismiss in triage view, 4. Agent-Initiated Dismiss (User-Approved), Common IPC/API Chain, Dismiss Data Flows (+35 more)

### Community 12 - "getConfigValue"
Cohesion: 0.46
Nodes (6): accountIndexedKey(), discoverAdditionalAccounts(), getConfigValue(), repo(), requested, stubFetch()

### Community 13 - "Notification Intelligence & Agent Framework"
Cohesion: 0.05
Nodes (43): 10. Implementation Roadmap, 1. Overview, 2. Current State Analysis, 3. Missing Data in the Database, 4.1 Workflow runs list, 4.2 Jobs for a run, 4.3 Job log download (streaming), 4.4 Mark notification thread as done (already partially implemented) (+35 more)

### Community 14 - "github-oauth.ts"
Cohesion: 0.08
Nodes (59): resolveGitHubScopes(), fetchAccountCopilotUsage(), quotaToUsage(), ALERT_THRESHOLDS, broadcast(), checkCopilotUsage(), getCopilotBudget(), hasUserScope() (+51 more)

### Community 15 - "preact"
Cohesion: 0.09
Nodes (29): preact, ACTION_LABEL, AgentApprovalPanel(), AgentApprovalPanelProps, copilotUnavailableReason(), EscalateButton(), EscalateButtonProps, FINDING_ICON (+21 more)

### Community 16 - "background.js"
Cohesion: 0.13
Nodes (34): clickElement(), cmdClick(), cmdCloseTab(), cmdEvaluate(), cmdExtract(), cmdFill(), cmdFocusWindow(), cmdGetPageContent() (+26 more)

### Community 17 - "local-discovery.ts"
Cohesion: 0.15
Nodes (26): startFileIndexIfNeeded(), launchDetached(), openTerminal(), registerHandlers(), startLocalScanIfNeeded(), addScanFolder(), autoLinkLocalRepos(), findGitRepos() (+18 more)

### Community 18 - "main/index.ts"
Cohesion: 0.07
Nodes (40): ref_node_events, completeOnboardingStep(), getOnboardingStatus(), OnboardingStatus, skipOnboardingStep(), initialize(), showAboutWindow(), showMainWindow() (+32 more)

### Community 19 - "ref_fs"
Cohesion: 0.05
Nodes (29): fs, initSqlJs, path, fs, initSqlJs, path, fs, initSqlJs (+21 more)

### Community 20 - "active-sessions.ts"
Cohesion: 0.11
Nodes (30): AgentActivity, CloudTaskCache, cloudTaskToSession(), collectActiveSessions(), CollectActiveSessionsOptions, DEFAULT_BRANCHES, describeAgentActivity(), listCloudTasks() (+22 more)

### Community 21 - "notifications/handler.ts"
Cohesion: 0.12
Nodes (27): AutoDismissRunResult, AutoDismissStepResult, AutoDismissSweepResult, collaboratedOnPr(), dismissStoredNotification(), fetchIssueState(), fetchPrState(), fetchTokenRateLimitRemaining() (+19 more)

### Community 22 - "local-agent-sessions.ts"
Cohesion: 0.12
Nodes (28): CLAUDE_TITLE_ENTRIES, clientLabel(), deriveClaudeActivity(), deriveCopilotActivity(), discoverClaudeLocalSessions(), discoverCopilotLocalSessions(), encodeClaudeProjectDir(), eventsPrCache (+20 more)

### Community 23 - "Contributing to Jarvis"
Cohesion: 0.07
Nodes (25): Agents, Before you open a pull request, Common scripts, Contributing to Jarvis, Conventions, Don't commit local run artifacts, Getting started, Prerequisites (+17 more)

### Community 24 - "NotifRepoPanel.tsx"
Cohesion: 0.14
Nodes (27): AgentSelector(), AgentSelectorProps, DashNotifGroup, extractBranchFromTitle(), extractErrorHint(), FailureHint, groupNotifications(), normalizeWorkflowName() (+19 more)

### Community 25 - "fixtures.ts"
Cohesion: 0.08
Nodes (33): 5.1 Agent definition model, AutoDismissHistoryPanel(), BarChart(), formatDate(), formatPeriod(), Granularity, reasonIcon(), reasonLabel() (+25 more)

### Community 26 - "index.tsx"
Cohesion: 0.07
Nodes (50): src_plugins_chat_embeddedchatpanel_embeddedchatpanel, ClaudeStep(), CopilotUsageBadgeProps, DiscoverySection(), DiscoverySectionProps, GitHubStep(), GitHubStepProps, GroupsStep() (+42 more)

### Community 27 - "Customer Project Budget & Actuals Lookup"
Cohesion: 0.07
Nodes (27): 1. **Groups Table** (Customer Mapping), 1. **Partial Matching for Group Names**, 2. **JSON Storage for Relationships**, 2. **Ruddr Projects Table** (Project Metadata), 3. **Budget Data Lives Elsewhere**, 3. **External Finance System** (Actual Budget/Actuals), 4. **Combine with Qualitative Data**, Architecture Overview (+19 more)

### Community 28 - "Repository Quality Improvement Agent"
Cohesion: 0.07
Nodes (28): 0.1 Load Focus Area History, 0.2 Select Focus Area, 0.5.1 Search for Existing Open Issues, 0.5.2 Load Durable Issue History (Any State), 0.5.3 Determine Action Mode, Accessibility & Usability Analysis, CI/CD Analysis, Code Organization Analysis (+20 more)

### Community 29 - "pr-readiness.ts"
Cohesion: 0.11
Nodes (24): CopilotReviewStatus, fetchWithAccounts(), buildBatchQuery(), CHECKS_REGISTRATION_GRACE_MS, COPILOT_REVIEW_CHECK_NAME, COPILOT_REVIEWER_LOGINS, evaluateChecks(), evaluateCopilotReview() (+16 more)

### Community 30 - "onedrive-onenote-cache.ts"
Cohesion: 0.10
Nodes (23): Architecture Overview, Buffer Truncation Problem (Solved), Code Locations (Quick Reference), File Detection, Tier 1: Live COM API (Primary), Tier 2: Local Backup Files (Fallback), Two-Tier Caching Strategy, BackupSection (+15 more)

### Community 31 - "onedrive/handler.ts"
Cohesion: 0.20
Nodes (18): isPathWithinConfiguredRoot(), registerHandlers(), OnedriveFile, OnedriveFolderInfo, getGroup(), addOnedriveRoot(), collectFiles(), discoverCustomerFolderForGroup() (+10 more)

### Community 32 - "config.ts"
Cohesion: 0.14
Nodes (17): DEFAULT_CONFIG, getConfigDir(), JarvisConfig, loadConfig(), REQUIRED_GITHUB_SCOPES, saveConfig(), registerHandlers(), AboutInfo (+9 more)

### Community 33 - "sql.js"
Cohesion: 0.06
Nodes (45): electron, sql.js, registerTaskIpcHandlers(), registerIpcHandlers(), registerHandlers(), buildSystemContext(), RepoSearchRow, searchOneNoteForChat() (+37 more)

### Community 34 - "claude.ts"
Cohesion: 0.06
Nodes (66): 8. Local Storage, Field-Level Encryption (AES-256-GCM), Requirements, Schema, Storage Location, ref_crypto, ref_module, clearStoredCredentials() (+58 more)

### Community 35 - "package.json"
Cohesion: 0.09
Nodes (21): author, description, engines, node, license, main, name, version (+13 more)

### Community 36 - "scripts"
Cohesion: 0.08
Nodes (25): scripts, build, build:mcp, check:deps, copy-static, dev, dev:electron, dev:esbuild (+17 more)

### Community 37 - "vitest"
Cohesion: 0.12
Nodes (10): ref_os, ref_path, vitest, getSql(), openSnapshot(), LATEST_SCHEMA_VERSION, root, SOURCE_FILES (+2 more)

### Community 38 - "ActiveSessionsPanel.tsx"
Cohesion: 0.14
Nodes (22): ActiveSessionsPanel(), formatCredits(), formatLastActive(), Light(), NO_PR_STAGE, openUrl(), ProviderIcon(), SessionRow() (+14 more)

### Community 39 - "OneNote Caching for Jarvis Groups"
Cohesion: 0.09
Nodes (20): 1. **Large Output from Long-Running Scripts**, 2. **Cloud Notebooks Require Live APIs**, 3. **COM API Requires Running Process**, 4. **Single-Threaded Apartment (STA) Mode is Essential**, 5. **Temp File Cleanup**, Cache shows stale dates (weeks old), Cache skipped all files with "no matching sections found", Database Schema (+12 more)

### Community 40 - "rules"
Cohesion: 0.09
Nodes (22): entry, ignoreDependencies, project, rules, binaries, catalog, catalogReferences, cycles (+14 more)

### Community 41 - "mcp-server/handler.ts"
Cohesion: 0.21
Nodes (16): ref_node_path, describeLaunch(), getMcpClientConfig(), McpClientConfig, resolveServerScriptPath(), serverScriptPathFrom(), buildMcpClientSnippets(), buildServerEnv() (+8 more)

### Community 42 - "registerHandlers"
Cohesion: 0.18
Nodes (19): formatRuddrHours(), normalize(), parseRuddrFigure(), registerHandlers(), scoreMatch(), addGithubRepoToGroup(), addLocalRepoToGroup(), createGroup() (+11 more)

### Community 43 - "claude-agent.ts"
Cohesion: 0.13
Nodes (19): RawFinding, ALLOWED_TOOL_PATTERNS, ClaudeAgentQueryResult, ClaudeCliAvailability, ClaudeStreamLine, DEFAULT_CLAUDE_AGENT_MODEL, DISALLOWED_TOOLS, EMPTY_RUN_INFO (+11 more)

### Community 44 - "manifest.json"
Cohesion: 0.10
Nodes (20): action, default_icon, default_popup, default_title, background, service_worker, content_scripts, 128 (+12 more)

### Community 45 - "Phase 2 — Agent plugin"
Cohesion: 0.33
Nodes (6): 2. Background Auto-Dismiss Sweep (Fully Automatic), Step rules, Surfacing results in the UI, Phase 2 — Agent plugin, WorkflowJob, WorkflowRun

### Community 46 - "github-fetch.ts"
Cohesion: 0.14
Nodes (17): Known Gotchas & Lessons Learned, fetchAllPages(), githubGet(), OrgTooLargeError, parseLinkLastPage(), parseLinkNext(), rateLimitAwarePause(), computeWaitMs() (+9 more)

### Community 47 - "database.ts"
Cohesion: 0.11
Nodes (25): Implementation: sql.js, registerHandlers(), addSecretFavorite(), fetchRepoSecretNames(), listSecretFavorites(), listSecretsForRepo(), removeSecretFavorite(), RepoSecretRow (+17 more)

### Community 48 - "ErrorBoundary.tsx"
Cohesion: 0.15
Nodes (11): describeError(), ErrorBoundary, ErrorBoundaryProps, ErrorBoundaryState, installGlobalErrorHandlers(), AboutApp(), AboutInfo, formatReleaseDate() (+3 more)

### Community 49 - "agents/handler.ts"
Cohesion: 0.19
Nodes (14): buildCopilotHandoffIssueBody(), checkEscalationReadiness(), registerHandlers(), createAgentSession(), getAgentSession(), listAgentDefinitions(), detectClaudeCli(), resolveLocalRepoPath() (+6 more)

### Community 50 - "github-host.ts"
Cohesion: 0.23
Nodes (18): ref_async_hooks, parseGhAuthStatus(), parseGitCredentialUsernames(), saveHostAccountPat(), accountId(), AccountRef, apiBaseForHost(), currentHost() (+10 more)

### Community 51 - "runner.ts"
Cohesion: 0.18
Nodes (17): extractJsonResult(), buildFailureRangeContext(), buildLocalRepoContext(), buildNotificationContext(), buildWorkflowContext(), CreateAgentSessionOptions, getAgentDefinition(), renderSystemPrompt() (+9 more)

### Community 52 - "ClaudePanel.tsx"
Cohesion: 0.25
Nodes (13): ClaudePanel(), ClaudePanelProps, CloudCreditsRow(), ExtraUsageRow(), formatMoney(), WindowRow(), ClaudeStepProps, formatDurationUntil() (+5 more)

### Community 53 - "github-workflows.ts"
Cohesion: 0.20
Nodes (15): WorkflowRunSummary, createGitHubIssue(), extractErrorHighlights(), extractFailingStepWindow(), extractLogExcerpt(), fetchAndStoreWorkflowData(), fetchJobLogExcerpt(), fetchWorkflowRunJobs() (+7 more)

### Community 54 - "ref_node_fs"
Cohesion: 0.12
Nodes (10): ref_node_child_process, ref_node_fs, ref_node_os, ROOT, SERVER_ENTRY_MODULES, MAIN_DIR, RENDERER_DIR, ROOT (+2 more)

### Community 55 - "onenote-reader.ts"
Cohesion: 0.15
Nodes (17): buildPage(), ComNotebookResult, ComReaderPage, ComReaderResult, ExtractedString, extractIsoDateFromTitle(), extractStrings(), isNoise() (+9 more)

### Community 56 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, incremental, lib, module (+9 more)

### Community 57 - "watch-electron.mjs"
Cohesion: 0.14
Nodes (15): ref_net, configuredBridgePort, __dirname, DIST_RENDERER, electronPath, knownContents, portIsFree(), preloadDir() (+7 more)

### Community 58 - "devDependencies"
Cohesion: 0.12
Nodes (16): devDependencies, concurrently, electron, electron-builder, esbuild, eslint, @eslint/js, @joplin/onenote-converter (+8 more)

### Community 59 - "compilerOptions"
Cohesion: 0.12
Nodes (15): ../../tsconfig.json, compilerOptions, declaration, declarationMap, incremental, jsx, jsxImportSource, module (+7 more)

### Community 60 - "file-index-runner.ts"
Cohesion: 0.18
Nodes (18): describeIndex(), FileSearchResult, searchLocalFiles(), FileIndexState, getFileIndexState(), _resetFileIndexStateForTests(), resolveIndexPath(), runFileIndex() (+10 more)

### Community 61 - "CopilotUsageBadge.tsx"
Cohesion: 0.21
Nodes (13): copilotBudgetLevel, copilotUsageLimit(), AccountHeader(), CopilotUsageBadge(), credits(), LEVEL_COLOR, LEVEL_RANK, RawResponsesDialog() (+5 more)

### Community 62 - "dashboard/handler.ts"
Cohesion: 0.13
Nodes (19): ref_child_process, getFailedRunCount(), getLastPushedAt(), getLinkedGithubFullName(), getRepoNotifCount(), registerHandlers(), BranchUpstreamInfo, checkRepoHealth() (+11 more)

### Community 63 - "Benevolent Product Owner"
Cohesion: 0.13
Nodes (14): Benevolent Product Owner, Codebase Health, Guardrails, Mission Statement, Performance, Phase 1 — Assessment, Phase 2 — Proposals, Phase 3 — Rubber Duck Reviews (+6 more)

### Community 64 - "github-repo-access.ts"
Cohesion: 0.21
Nodes (16): registerHandlers(), syncGitHubNotifications(), AccountToken, listGhCliAccountsCached(), resolveAccountToken(), parseAccountId(), getNotificationCounts(), accessForAccount() (+8 more)

### Community 65 - "browser-extension.test.ts"
Cohesion: 0.14
Nodes (13): ref_vm, connected(), Ctx, EXT_DIR, FakeElement, FakeWebSocket, flush(), Harness (+5 more)

### Community 66 - "Database"
Cohesion: 0.13
Nodes (5): Database, QueryExecResult, sql.js, SqlJsStatic, Statement

### Community 67 - "Jarvis Agent — Architecture Specification"
Cohesion: 0.11
Nodes (18): 14. Initial Stack, 15. Claude Rate Limit Awareness, 1. Requirements Summary, 2. High-Level Architecture, 3. Runtime & Language implementation in TypeScript / Node.js, 6. Ollama Integration, Core Flow, Credential Source (+10 more)

### Community 68 - "mcp-settings-section.tsx"
Cohesion: 0.21
Nodes (8): formatWhen(), IndexProgressView, IndexStatusView, McpClientConfigView, McpSectionApi, McpServerSection(), SNIPPET_TABS, SnippetKey

### Community 69 - "mock-jarvis-api.ts"
Cohesion: 0.17
Nodes (10): Fixtures, defaultResponses(), EVENT_METHODS, install(), JarvisTestControl, ok, Responder, Responses (+2 more)

### Community 70 - "groups/handler.ts"
Cohesion: 0.14
Nodes (19): BrowserTabSession, budgetRowToResult(), CachedBudget, getRuddrMyProjectsUrl(), getRuddrProjectsUrl(), getRuddrWorkspace(), _getWindowFn(), isBudgetFresh() (+11 more)

### Community 71 - "Jarvis MCP Server"
Cohesion: 0.15
Nodes (13): Available tools, Claude Desktop configuration (manual), Data freshness, Design principle: cached data only, no credentials, Getting the client configuration from the app, GitHub tools (cached remote repos, local clones, notifications, workflow runs), Group & OneNote tools, How to navigate OneNote data (+5 more)

### Community 72 - "ensure-electron.mjs"
Cohesion: 0.22
Nodes (9): ref_url, __dirname, outDir, srcDir, DEFAULT_ROOT, __dirname, electronDir(), ensureElectron() (+1 more)

### Community 73 - "ensureRuddrCache"
Cohesion: 0.29
Nodes (14): sendCommand(), closeSessionTab(), createTabSession(), keepSessionTabOpen(), navigatePayload(), recordNavigationTab(), ensureRuddrCache(), _notifyNewProjects() (+6 more)

### Community 74 - "task-failure-log.ts"
Cohesion: 0.21
Nodes (6): getRecentTaskFailures(), MAX_FAILURES_PER_TASK, NOTIFY_AFTER_CONSECUTIVE_FAILURES, recordTaskFailure(), TaskFailureAlerter, TaskRunRecord

### Community 75 - "active-sessions/handler.ts"
Cohesion: 0.26
Nodes (11): notifyReady(), prKey(), recordReadiness(), refreshActiveSessions(), resetActiveSessionsState(), runActiveSessionsSweep(), STILL_PUSHING, ActiveSessionsSnapshot (+3 more)

### Community 76 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, jsx, jsxImportSource, lib, module, moduleResolution, noEmit (+4 more)

### Community 77 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, allowJs, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck (+4 more)

### Community 78 - "build-renderer.mjs"
Cohesion: 0.33
Nodes (5): esbuild, __dirname, main(), options, watch

### Community 79 - "view-harness.ts"
Cohesion: 0.18
Nodes (11): ref_node_http, ref_node_net, buildViews(), BuiltViews, CONTENT_TYPES, ERROR_BOUNDARY_ENTRY, launchBrowser(), MOCK_ENTRY (+3 more)

### Community 80 - "screenshots.ts"
Cohesion: 0.20
Nodes (11): playwright, InvokeMethod, OpenViewOptions, ViewName, harness, NOW, OUT_DIR, ROOT (+3 more)

### Community 81 - "createBackgroundTaskScheduler"
Cohesion: 0.26
Nodes (4): broadcastTaskUpdate(), createBackgroundTaskScheduler(), registerTask(), TaskScheduler

### Community 82 - "README.md"
Cohesion: 0.20
Nodes (7): Available tools, Connecting from an editor, Goals, Jarvis, MCP Server, Setup, Status

### Community 83 - "Jarvis Browser Companion — Browser Extension"
Cohesion: 0.18
Nodes (10): Architecture, Commands (Jarvis → Extension), Development, Installation (Developer Mode), Jarvis Browser Companion — Browser Extension, Owned tabs, Permissions, Security (+2 more)

### Community 84 - "ollama-provider.ts"
Cohesion: 0.36
Nodes (6): claudeAgentProvider, ollamaProvider, AgentProvider, AgentRunCallbacks, AgentRunOptions, AgentRunOutcome

### Community 85 - "github-repo-catalog.ts"
Cohesion: 0.23
Nodes (11): Candidate, countReposNeedingReadme(), pickCandidates(), README_MAX_CHARS, README_MAX_LINES, ReadmeBatchOptions, ReadmeBatchResult, ReadmeStatus (+3 more)

### Community 86 - "active-sessions.test.ts"
Cohesion: 0.16
Nodes (14): ActiveAgentSession, PendingLink, resetCloudTaskCache(), findRepoRoot(), GitConfigSection, GitContext, hasRemoteBranch(), parseGitConfig() (+6 more)

### Community 87 - "useViewHarness"
Cohesion: 0.53
Nodes (3): harness, useViewHarness(), ViewHarness

### Community 88 - "Initial Capabilities"
Cohesion: 0.22
Nodes (9): 12.1 Repository & Organization Indexing, 12.2 Secrets Scanning, 12.3 Fork Analysis & Upstream Sync, 12.4 Maintenance Tasks, 12.5 Implementation Approach, 12. GitHub Maintenance Module, Example Interactions, Initial Capabilities (+1 more)

### Community 89 - "Product"
Cohesion: 0.22
Nodes (8): Accessibility & Inclusion, Anti-references, Brand Personality, Design Principles, Product, Product Purpose, Register, Users

### Community 90 - "GroupsDashboardPanel.tsx"
Cohesion: 0.27
Nodes (9): formatFetchedAt(), GroupCard(), GroupsDashboardPanel(), formatDate(), RuddrProjectRow, RuddrProjectsPanel(), RuddrBudget, RuddrProjectInfo (+1 more)

### Community 91 - "Check Jarvis Database"
Cohesion: 0.25
Nodes (6): Check Jarvis Database, Example output, How to run, Script source, What it outputs, When to use this skill

### Community 92 - "11. Activity Tracking & Weekly Summaries"
Cohesion: 0.25
Nodes (8): 11. Activity Tracking & Weekly Summaries, Activity Fetching, Data Sources, Example Summary Output, Motivation, Query Examples, Weekly Summary Generation, Work Journal

### Community 93 - "bug_report.md"
Cohesion: 0.25
Nodes (7): Actual Behavior, Additional Context, Description, Environment, Expected Behavior, Screenshots / Logs, Steps to Reproduce

### Community 94 - "Getting Started"
Cohesion: 0.25
Nodes (8): Getting Started, Install and start with Windows, Intended Use, Jarvis, Main Features, Publish updates, Run and debug from VS Code, Verifying an installer

### Community 95 - "groups-ruddr-budget.test.ts"
Cohesion: 0.20
Nodes (7): saveRuddrBudgetToDb(), saveRuddrProjectsToDb(), BridgeModule, handlers, mockNotification, register(), SCRAPED_STATS

### Community 96 - "BrowserCompanionPanel.tsx"
Cohesion: 0.36
Nodes (7): BrowserCompanionPanel(), RunResult(), SkillForm(), SkillFormProps, BrowserCompanionStatus, BrowserSkill, BrowserSkillRun

### Community 97 - "OneNoteCachePanel.tsx"
Cohesion: 0.39
Nodes (7): groupBySectionFile(), OneNoteCachePanel(), PageRow(), Props, SectionBlock(), SectionGroup, OneNoteGroupCachePage

### Community 98 - "10. Async Actor Pattern"
Cohesion: 0.29
Nodes (7): 10. Async Actor Pattern, Actor Model, GitHub App Rate Limits, Motivation, Rate Limit Awareness, Task Lifecycle, Task Types

### Community 99 - "4. Electron GUI Host"
Cohesion: 0.29
Nodes (7): 4. Electron GUI Host, IPC Handler Error Contract, Notifications, Process Model, Startup on Boot, System Tray Behavior, Why Electron

### Community 100 - "9. Container Isolation"
Cohesion: 0.29
Nodes (7): 9. Container Isolation, Architecture, Container Configuration, Docker Image, Motivation, Recommendation, When to Containerize

### Community 101 - "dependencies"
Cohesion: 0.29
Nodes (7): dependencies, electron-updater, @modelcontextprotocol/sdk, preact, sql.js, ws, zod

### Community 102 - "popup.js"
Cohesion: 0.29
Nodes (5): btnSave, savedMsg, statusEl, statusTextEl, tokenInput

### Community 103 - "agents-handler.test.ts"
Cohesion: 0.20
Nodes (5): handlers, mockCheckClaudeRateLimit, mockDetectClaudeCli, mockResolveAccessToken, mockRunAgentSession

### Community 104 - "17. Active Agent Sessions & PR Review Readiness"
Cohesion: 0.33
Nodes (6): 17. Active Agent Sessions & PR Review Readiness, Background check & notifications, Linking sessions to PRs, Not covered yet, Readiness rules (evaluated on the PR's head commit), Session sources

### Community 105 - "5. First-Run Onboarding Flow"
Cohesion: 0.33
Nodes (6): 5. First-Run Onboarding Flow, Onboarding Sequence, Onboarding State Machine, Step 1: GitHub OAuth Connection, Step 2: Local Repository Discovery, Step 3: Ollama Discovery

### Community 106 - "7. MCP Extensibility"
Cohesion: 0.33
Nodes (6): 7. MCP Extensibility, Adding New Capabilities, Architecture, Connecting MCP Servers, Pre-built MCP Servers to Consider, Why MCP

### Community 107 - "pull_request_template.md"
Cohesion: 0.33
Nodes (5): Checklist, How to Test, Related Issue, Summary of Changes, Type of Change

### Community 108 - "content.js"
Cohesion: 0.60
Nodes (5): clickElement(), extractBySelector(), fillElement(), getPageContent(), handleMessage()

### Community 109 - "settings-and-about.view.test.ts"
Cohesion: 0.20
Nodes (5): FIXTURE_USER, EventMethod, RecordedCall, OpenedView, harness

### Community 110 - "16. Copilot AI Credit Budget Tracking"
Cohesion: 0.40
Nodes (5): 16. Copilot AI Credit Budget Tracking, Authentication, Budget, Data Sources, Scheduling & UI

### Community 111 - "18. Multiple GitHub Accounts & GHE.com"
Cohesion: 0.50
Nodes (4): 18. Multiple GitHub Accounts & GHE.com, Accounts and hosts, Known limits, Which account serves which repo

### Community 112 - "feature_request.md"
Cohesion: 0.40
Nodes (4): Additional Context, Describe Alternatives You've Considered, Describe the Solution You'd Like, Is Your Feature Request Related to a Problem?

### Community 113 - "task-scheduler.ts"
Cohesion: 0.28
Nodes (6): errorMessage(), nowIso(), RegisteredTask, TaskDefinition, TaskRunStatus, TaskStatus

### Community 114 - "13. Configuration"
Cohesion: 0.50
Nodes (4): 13. Configuration, Agent Configuration File, Encryption Key Management, Environment Variables

### Community 115 - "notifications-multi-account.test.ts"
Cohesion: 0.22
Nodes (5): Access, ACCOUNTS, handlers, inboxes, requested

### Community 116 - "update-verification.ts"
Cohesion: 0.43
Nodes (5): electron-updater, checkPublisherPresent(), enforceSignatureVerification(), MISSING_PUBLISHER_REASON, VerifiableUpdater

### Community 117 - "allowScripts"
Cohesion: 0.50
Nodes (4): allowScripts, electron, electron-winstaller, esbuild

### Community 119 - "logger.ts"
Cohesion: 0.32
Nodes (4): getLogLevel(), LEVEL_ORDER, LogLevel, setLogLevel()

### Community 124 - "startBackgroundTasks"
Cohesion: 0.67
Nodes (4): 1. Boot Cache Pre-Warm, `prewarmRuddrCache(db)`, `runBootWorkflowCheck(db, getWindow)`, startBackgroundTasks()

## Knowledge Gaps
- **834 isolated node(s):** `initSqlJs`, `fs`, `path`, `dbPath`, `initSqlJs` (+829 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1194 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `JarvisApi` connect `JarvisApi` to `mock-jarvis-api.ts`, `plugins/types.ts`, `settings-and-about.view.test.ts`, `view-harness.ts`, `screenshots.ts`, `UpdateState`, `Contributing to Jarvis`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **Why does `sql.js` connect `sql.js` to `server.ts`, `github-notifications.ts`, `saveDatabase`, `mcp-server/index.ts`, `local-file-index.ts`, `background-tasks.ts`, `github-accounts.ts`, `getConfigValue`, `github-oauth.ts`, `local-discovery.ts`, `main/index.ts`, `ref_fs`, `notifications/handler.ts`, `onedrive-onenote-cache.ts`, `onedrive/handler.ts`, `config.ts`, `claude.ts`, `package.json`, `vitest`, `mcp-server/handler.ts`, `registerHandlers`, `claude-agent.ts`, `database.ts`, `agents/handler.ts`, `runner.ts`, `github-workflows.ts`, `file-index-runner.ts`, `dashboard/handler.ts`, `github-repo-access.ts`, `groups/handler.ts`, `task-failure-log.ts`, `active-sessions/handler.ts`, `github-repo-catalog.ts`, `groups-ruddr-budget.test.ts`, `agents-handler.test.ts`, `notifications-multi-account.test.ts`?**
  _High betweenness centrality (0.136) - this node is a cross-community bridge._
- **Why does `vitest` connect `vitest` to `server.ts`, `github-notifications.ts`, `saveDatabase`, `mcp-server/index.ts`, `local-file-index.ts`, `background-tasks.ts`, `utils.ts`, `copilot-usage.ts`, `github-accounts.ts`, `getConfigValue`, `github-oauth.ts`, `preact`, `local-discovery.ts`, `main/index.ts`, `ref_fs`, `active-sessions.ts`, `notifications/handler.ts`, `local-agent-sessions.ts`, `fixtures.ts`, `pr-readiness.ts`, `onedrive-onenote-cache.ts`, `onedrive/handler.ts`, `config.ts`, `sql.js`, `claude.ts`, `package.json`, `mcp-server/handler.ts`, `registerHandlers`, `claude-agent.ts`, `github-fetch.ts`, `database.ts`, `ErrorBoundary.tsx`, `agents/handler.ts`, `github-host.ts`, `runner.ts`, `github-workflows.ts`, `ref_node_fs`, `onenote-reader.ts`, `file-index-runner.ts`, `dashboard/handler.ts`, `github-repo-access.ts`, `browser-extension.test.ts`, `ensure-electron.mjs`, `ensureRuddrCache`, `task-failure-log.ts`, `active-sessions/handler.ts`, `view-harness.ts`, `screenshots.ts`, `active-sessions.test.ts`, `useViewHarness`, `groups-ruddr-budget.test.ts`, `agents-handler.test.ts`, `settings-and-about.view.test.ts`, `notifications-multi-account.test.ts`, `update-verification.ts`, `logger.ts`?**
  _High betweenness centrality (0.130) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `saveDatabase()` (e.g. with `Implementation: sql.js` and `active-sessions-handler.test.ts`) actually correct?**
  _`saveDatabase()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `initSqlJs`, `fs`, `path` to the rest of the system?**
  _834 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `JarvisApi` be split into smaller, more focused modules?**
  _Cohesion score 0.012345679012345678 - nodes in this community are weakly interconnected._
- **Should `server.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09747899159663866 - nodes in this community are weakly interconnected._