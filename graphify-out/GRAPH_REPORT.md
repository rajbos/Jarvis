# Graph Report - github-repo-discovery-cache-46255f  (2026-10-08)

## Corpus Check
- 286 files · ~302,808 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 9 file(s) not represented in the graph (top: (none) 5, .css 3, .nsh 1)

## Summary
- 2655 nodes · 6291 edges · 124 communities (117 shown, 7 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 162 edges (avg confidence: 0.88)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `54812709`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- JarvisApi
- groups/handler.ts
- notifications/handler.ts
- saveDatabase
- mcp-server/index.ts
- local-file-index.ts
- background-tasks.ts
- plugins/types.ts
- App
- copilot-usage/handler.ts
- github-accounts.ts
- DashboardPanel.tsx
- sql.js
- Notification Intelligence & Agent Framework
- github-oauth.ts
- preact
- background.js
- local-discovery.ts
- main/index.ts
- ref_fs
- active-sessions.ts
- index.tsx
- local-agent-sessions.ts
- Contributing to Jarvis
- NotifRepoPanel.tsx
- fixtures.ts
- StatusBadge
- Customer Project Budget & Actuals Lookup
- Repository Quality Improvement Agent
- pr-readiness.ts
- onedrive-onenote-cache.ts
- onedrive/handler.ts
- config.ts
- getConfigValue
- claude.ts
- package.json
- scripts
- vitest
- ActiveSessionsPanel.tsx
- OneNote Caching for Jarvis Groups
- rules
- mcp-server/handler.ts
- encryption.ts
- claude-agent.ts
- manifest.json
- AgentApprovalPanel.tsx
- claude/handler.ts
- secrets/handler.ts
- ErrorBoundary.tsx
- agents-handler.test.ts
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
- chat/handler.ts
- CopilotUsageBadge.tsx
- git-health.ts
- Benevolent Product Owner
- windows.ts
- copilot-usage-handler.test.ts
- Database
- Jarvis Agent — Architecture Specification
- mcp-settings-section.tsx
- mock-jarvis-api.ts
- dashboard/handler.ts
- Jarvis MCP Server
- ensure-electron.mjs
- watch-electron.js
- safeHandle
- active-sessions/handler.ts
- compilerOptions
- compilerOptions
- build-renderer.mjs
- view-harness.ts
- agents/handler.ts
- update-checker.test.ts
- README.md
- Jarvis Browser Companion — Browser Extension
- ollama-provider.ts
- AutoDismissHistoryPanel.tsx
- active-sessions.test.ts
- useViewHarness
- Initial Capabilities
- Product
- git-context.ts
- Check Jarvis Database
- 11. Activity Tracking & Weekly Summaries
- bug_report.md
- Getting Started
- claude.test.ts
- BrowserCompanionPanel.tsx
- OneNoteCachePanel.tsx
- 10. Async Actor Pattern
- 4. Electron GUI Host
- 9. Container Isolation
- dependencies
- popup.js
- event-bus.ts
- 17. Active Agent Sessions & PR Review Readiness
- 5. First-Run Onboarding Flow
- 7. MCP Extensibility
- pull_request_template.md
- content.js
- OpenedView
- 16. Copilot AI Credit Budget Tracking
- resolveAccountToken
- feature_request.md
- check-db.js
- 13. Configuration
- 6. Ollama Integration
- 8. Local Storage
- allowScripts
- UpdateState
- settings-and-about.view.test.ts
- assets.d.ts

## God Nodes (most connected - your core abstractions)
1. `JarvisApi` - 177 edges
2. `sql.js` - 105 edges
3. `vitest` - 91 edges
4. `saveDatabase()` - 65 edges
5. `safeHandle()` - 51 edges
6. `getSchema()` - 48 edges
7. `electron` - 40 edges
8. `logger` - 37 edges
9. `App()` - 36 edges
10. `preact` - 32 edges

## Surprising Connections (you probably didn't know these)
- `Authentication` --references--> `resolveGitHubScopes()`  [INFERRED]
  docs/ARCHITECTURE.md → src/agent/config.ts
- `IPC Handler Error Contract` --references--> `safeHandle()`  [INFERRED]
  docs/ARCHITECTURE.md → src/plugins/ipc-utils.ts
- `Known Gotchas & Lessons Learned` --references--> `safeHandle()`  [INFERRED]
  .github/copilot-instructions.md → src/plugins/ipc-utils.ts
- `8.1 Main screen — Analyse button` --references--> `NotifRepoPanel()`  [INFERRED]
  docs/NOTIFICATION-INTELLIGENCE.md → src/plugins/notifications/NotifRepoPanel.tsx
- `View tests (headless browser)` --references--> `JarvisApi`  [INFERRED]
  CONTRIBUTING.md → src/plugins/types.ts

## Import Cycles
- None detected.

## Communities (124 total, 7 thin omitted)

### Community 1 - "groups/handler.ts"
Cohesion: 0.05
Nodes (80): ref_events, ws, registerHandlers(), ALLOWED_URL_SCHEMES, authTimeouts, BRIDGE_ORIGIN, BRIDGE_PORT, BridgeCommand (+72 more)

### Community 2 - "notifications/handler.ts"
Cohesion: 0.05
Nodes (76): AutoDismissRunResult, AutoDismissStepResult, AutoDismissSweepResult, collaboratedOnPr(), dismissStoredNotification(), fetchIssueState(), fetchPrState(), fetchTokenRateLimitRemaining() (+68 more)

### Community 3 - "saveDatabase"
Cohesion: 0.07
Nodes (66): What uses it, accountIndexedKey(), discoverAdditionalAccounts(), registerHandlers(), startPrimaryDiscovery(), activeDiscovery, lastDiscoveryProgress, setActiveDiscovery() (+58 more)

### Community 4 - "mcp-server/index.ts"
Cohesion: 0.06
Nodes (58): DB_PATH, getSql(), INDEX_DB_PATH, openIndexSnapshot(), server, buildTermFilter(), deriveRoles(), findAnywhere() (+50 more)

### Community 5 - "local-file-index.ts"
Cohesion: 0.07
Nodes (52): ref_node_util, describeIndex(), FileSearchResult, searchLocalFiles(), FileIndexState, _resetFileIndexStateForTests(), runFileIndex(), buildMatchExpression() (+44 more)

### Community 6 - "background-tasks.ts"
Cohesion: 0.06
Nodes (33): 1. Boot Cache Pre-Warm, `prewarmRuddrCache(db)`, `runBootWorkflowCheck(db, getWindow)`, ACTIVE_SESSIONS_INITIAL_DELAY_MS, ACTIVE_SESSIONS_INTERVAL_MS, broadcastTaskUpdate(), COPILOT_USAGE_INITIAL_DELAY_MS, COPILOT_USAGE_INTERVAL_MS (+25 more)

### Community 7 - "plugins/types.ts"
Cohesion: 0.06
Nodes (35): OneNoteSectionPanel(), PageCard(), Props, ActiveSessionVerdict, AgentSessionOrigin, AutoDismissCompletePayload, AutoDismissReason, AutoDismissRunResult (+27 more)

### Community 8 - "App"
Cohesion: 0.10
Nodes (33): ChatMsg, EmbeddedChatPanelProps, LocalFolderPanel(), LocalRepoCard(), LocalRepoCardProps, LocalRepoPanelView(), LocalRepoPanelViewProps, LocalSortKey (+25 more)

### Community 9 - "copilot-usage/handler.ts"
Cohesion: 0.10
Nodes (38): AccountCredentials, EMPTY_USAGE, fetchAccountCopilotUsage(), quotaToUsage(), usageBase, ALERT_THRESHOLDS, broadcast(), checkCopilotUsage() (+30 more)

### Community 10 - "github-accounts.ts"
Cohesion: 0.11
Nodes (40): checkAllAccountsUsage(), getAccountBudget(), isScope(), lookupHostUser(), registerHandlers(), sameId(), setAccountBudget(), AccountAssignment (+32 more)

### Community 11 - "DashboardPanel.tsx"
Cohesion: 0.08
Nodes (41): 2b. Issues Closed by Me (Org view, User-Confirmed), 3. Per-Item and Per-Group Dismiss (Manual), 3b. Per-workflow-group "Dismiss all" button, 3c. `DashboardNotificationTriage` — per-item dismiss in triage view, Common IPC/API Chain, Dismiss Data Flows, Overview, State Management Rules (+33 more)

### Community 12 - "sql.js"
Cohesion: 0.09
Nodes (27): Implementation: sql.js, sql.js, completeOnboardingStep(), getOnboardingStatus(), OnboardingStatus, skipOnboardingStep(), closeDatabase(), createMemoryDatabase() (+19 more)

### Community 13 - "Notification Intelligence & Agent Framework"
Cohesion: 0.05
Nodes (41): 10. Implementation Roadmap, 1. Overview, 2. Current State Analysis, 3. Missing Data in the Database, 4.1 Workflow runs list, 4.2 Jobs for a run, 4.3 Job log download (streaming), 4.4 Mark notification thread as done (already partially implemented) (+33 more)

### Community 14 - "github-oauth.ts"
Cohesion: 0.14
Nodes (32): resolveGitHubScopes(), startDiscoveryIfAuthed(), broadcastOAuthComplete(), checkPatForExpiry(), recheckCopilotUsage(), registerHandlers(), sleep(), startPollingLoop() (+24 more)

### Community 15 - "preact"
Cohesion: 0.09
Nodes (25): preact, formatFetchedAt(), GroupCard(), GroupsDashboardPanel(), GroupsPanel(), GroupsPanelProps, formatDate(), RuddrProjectRow (+17 more)

### Community 16 - "background.js"
Cohesion: 0.13
Nodes (34): clickElement(), cmdClick(), cmdCloseTab(), cmdEvaluate(), cmdExtract(), cmdFill(), cmdFocusWindow(), cmdGetPageContent() (+26 more)

### Community 17 - "local-discovery.ts"
Cohesion: 0.14
Nodes (27): getFileIndexState(), startFileIndexIfNeeded(), launchDetached(), openTerminal(), registerHandlers(), startLocalScanIfNeeded(), addScanFolder(), autoLinkLocalRepos() (+19 more)

### Community 18 - "main/index.ts"
Cohesion: 0.12
Nodes (25): electron, initialize(), showAboutWindow(), showMainWindow(), showSettingsWindow(), createTray(), broadcastState(), checkForUpdates() (+17 more)

### Community 19 - "ref_fs"
Cohesion: 0.06
Nodes (25): fs, initSqlJs, path, fs, initSqlJs, path, fs, initSqlJs (+17 more)

### Community 20 - "active-sessions.ts"
Cohesion: 0.11
Nodes (30): AgentActivity, CloudTaskCache, cloudTaskToSession(), collectActiveSessions(), CollectActiveSessionsOptions, DEFAULT_BRANCHES, describeAgentActivity(), listCloudTasks() (+22 more)

### Community 21 - "index.tsx"
Cohesion: 0.12
Nodes (25): src_plugins_chat_embeddedchatpanel_embeddedchatpanel, LocalFolderConfigPanel(), LocalFolderConfigPanelProps, LocalFolderPanelProps, LocalReposStep(), LocalReposStepProps, COLLAB_LABELS, formatCollabReason() (+17 more)

### Community 22 - "local-agent-sessions.ts"
Cohesion: 0.13
Nodes (26): clientLabel(), deriveClaudeActivity(), deriveCopilotActivity(), discoverClaudeLocalSessions(), discoverCopilotLocalSessions(), encodeClaudeProjectDir(), eventsPrCache, eventTime() (+18 more)

### Community 23 - "Contributing to Jarvis"
Cohesion: 0.06
Nodes (26): Agents, Before you open a pull request, Common scripts, Contributing to Jarvis, Conventions, Don't commit local run artifacts, Getting started, Prerequisites (+18 more)

### Community 24 - "NotifRepoPanel.tsx"
Cohesion: 0.14
Nodes (27): 3a. Single notification dismiss (right-click menu), AgentSelector(), AgentSelectorProps, DashNotifGroup, extractBranchFromTitle(), extractErrorHint(), FailureHint, groupNotifications() (+19 more)

### Community 25 - "fixtures.ts"
Cohesion: 0.09
Nodes (25): 5.1 Agent definition model, playwright, AgentDefinition, BackgroundTaskStatus, GitHubRateLimit, LocalIndexStatus, McpClientConfig, OnedriveRoot (+17 more)

### Community 26 - "StatusBadge"
Cohesion: 0.11
Nodes (21): DiscoverySection(), DiscoverySectionProps, GitHubStep(), GitHubStepProps, GroupsStep(), GroupsStepProps, OllamaPanel(), OllamaPanelProps (+13 more)

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
Cohesion: 0.11
Nodes (22): Architecture Overview, Code Locations (Quick Reference), File Detection, Tier 1: Live COM API (Primary), Tier 2: Local Backup Files (Fallback), Two-Tier Caching Strategy, BackupSection, CacheGroupResult (+14 more)

### Community 31 - "onedrive/handler.ts"
Cohesion: 0.20
Nodes (18): isPathWithinConfiguredRoot(), registerHandlers(), OnedriveFile, OnedriveFolderInfo, getGroup(), addOnedriveRoot(), collectFiles(), discoverCustomerFolderForGroup() (+10 more)

### Community 32 - "config.ts"
Cohesion: 0.14
Nodes (17): DEFAULT_CONFIG, getConfigDir(), JarvisConfig, loadConfig(), REQUIRED_GITHUB_SCOPES, saveConfig(), registerHandlers(), AboutInfo (+9 more)

### Community 33 - "getConfigValue"
Cohesion: 0.13
Nodes (17): 7.1 How the agent calls Ollama, What we have, registerHandlers(), ChatMessage, chatWithTools(), checkOllama(), extractTextToolCalls(), OllamaModel (+9 more)

### Community 34 - "claude.ts"
Cohesion: 0.14
Nodes (23): asCurrency(), asFraction(), asNumber(), asRecord(), checkClaudeRateLimit(), ClaudeCloudCredits, ClaudeExtraUsage, ClaudeRateLimitProbe (+15 more)

### Community 35 - "package.json"
Cohesion: 0.09
Nodes (22): author, description, engines, node, license, main, name, version (+14 more)

### Community 36 - "scripts"
Cohesion: 0.08
Nodes (24): scripts, build, build:mcp, check:deps, copy-static, dev, dev:electron, dev:esbuild (+16 more)

### Community 37 - "vitest"
Cohesion: 0.12
Nodes (10): ref_os, ref_path, vitest, getSql(), openSnapshot(), OneNoteSection, root, SOURCE_FILES (+2 more)

### Community 38 - "ActiveSessionsPanel.tsx"
Cohesion: 0.14
Nodes (22): ActiveSessionsPanel(), formatCredits(), formatLastActive(), Light(), NO_PR_STAGE, openUrl(), ProviderIcon(), SessionRow() (+14 more)

### Community 39 - "OneNote Caching for Jarvis Groups"
Cohesion: 0.09
Nodes (21): 1. **Large Output from Long-Running Scripts**, 2. **Cloud Notebooks Require Live APIs**, 3. **COM API Requires Running Process**, 4. **Single-Threaded Apartment (STA) Mode is Essential**, 5. **Temp File Cleanup**, Buffer Truncation Problem (Solved), Cache shows stale dates (weeks old), Cache skipped all files with "no matching sections found" (+13 more)

### Community 40 - "rules"
Cohesion: 0.09
Nodes (22): entry, ignoreDependencies, project, rules, binaries, catalog, catalogReferences, cycles (+14 more)

### Community 41 - "mcp-server/handler.ts"
Cohesion: 0.18
Nodes (19): ref_node_path, resolveIndexPath(), describeLaunch(), getMcpClientConfig(), McpClientConfig, resolveServerScriptPath(), serverScriptPathFrom(), getIndexDbPath() (+11 more)

### Community 42 - "encryption.ts"
Cohesion: 0.19
Nodes (17): Field-Level Encryption (AES-256-GCM), ref_module, archiveKeyFile(), decrypt(), decryptSecret(), deriveKey(), generateKey(), getConfigDirPath() (+9 more)

### Community 43 - "claude-agent.ts"
Cohesion: 0.13
Nodes (19): RawFinding, ALLOWED_TOOL_PATTERNS, ClaudeAgentQueryResult, ClaudeCliAvailability, ClaudeStreamLine, DEFAULT_CLAUDE_AGENT_MODEL, DISALLOWED_TOOLS, EMPTY_RUN_INFO (+11 more)

### Community 44 - "manifest.json"
Cohesion: 0.10
Nodes (20): action, default_icon, default_popup, default_title, background, service_worker, content_scripts, 128 (+12 more)

### Community 45 - "AgentApprovalPanel.tsx"
Cohesion: 0.14
Nodes (19): 2. Background Auto-Dismiss Sweep (Fully Automatic), 4. Agent-Initiated Dismiss (User-Approved), Step rules, Surfacing results in the UI, Phase 2 — Agent plugin, ACTION_LABEL, AgentApprovalPanel(), AgentApprovalPanelProps (+11 more)

### Community 46 - "claude/handler.ts"
Cohesion: 0.18
Nodes (17): clearStoredCredentials(), loadStoredCredentials(), registerHandlers(), resolveAccessToken(), storeCredentials(), buildAuthorizeUrl(), ClaudeCredentials, exchangeCodeForToken() (+9 more)

### Community 47 - "secrets/handler.ts"
Cohesion: 0.22
Nodes (12): registerHandlers(), addSecretFavorite(), fetchRepoSecretNames(), listSecretFavorites(), listSecretsForRepo(), removeSecretFavorite(), RepoSecretRow, scanUserRepoSecrets() (+4 more)

### Community 48 - "ErrorBoundary.tsx"
Cohesion: 0.15
Nodes (11): describeError(), ErrorBoundary, ErrorBoundaryProps, ErrorBoundaryState, installGlobalErrorHandlers(), AboutApp(), AboutInfo, formatReleaseDate() (+3 more)

### Community 49 - "agents-handler.test.ts"
Cohesion: 0.13
Nodes (11): assignCopilotToIssue(), checkCopilotAssignable(), CopilotAvailability, GraphQLResponse, IMPORTANT: this only works with a token tied to a real, Copilot-enabled user, SuggestedActorsResult, handlers, mockCheckClaudeRateLimit (+3 more)

### Community 50 - "github-host.ts"
Cohesion: 0.23
Nodes (17): ref_async_hooks, parseGhAuthStatus(), parseGitCredentialUsernames(), saveHostAccountPat(), accountId(), AccountRef, apiBaseForHost(), currentHost() (+9 more)

### Community 51 - "runner.ts"
Cohesion: 0.20
Nodes (15): extractJsonResult(), buildFailureRangeContext(), buildLocalRepoContext(), buildNotificationContext(), buildWorkflowContext(), CreateAgentSessionOptions, renderSystemPrompt(), runAgentSession() (+7 more)

### Community 52 - "ClaudePanel.tsx"
Cohesion: 0.18
Nodes (15): ClaudePanel(), ClaudePanelProps, CloudCreditsRow(), ExtraUsageRow(), formatMoney(), WindowRow(), ClaudeStep(), ClaudeStepProps (+7 more)

### Community 53 - "github-workflows.ts"
Cohesion: 0.19
Nodes (14): WorkflowRunSummary, extractErrorHighlights(), extractFailingStepWindow(), extractLogExcerpt(), fetchAndStoreWorkflowData(), fetchJobLogExcerpt(), fetchWorkflowRunJobs(), fetchWorkflowRuns() (+6 more)

### Community 54 - "ref_node_fs"
Cohesion: 0.12
Nodes (10): ref_node_child_process, ref_node_fs, ref_node_os, ROOT, SERVER_ENTRY_MODULES, MAIN_DIR, RENDERER_DIR, ROOT (+2 more)

### Community 55 - "onenote-reader.ts"
Cohesion: 0.17
Nodes (16): buildPage(), ComNotebookResult, ComReaderPage, ComReaderResult, ExtractedString, extractIsoDateFromTitle(), extractStrings(), isNoise() (+8 more)

### Community 56 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, incremental, lib, module (+9 more)

### Community 57 - "watch-electron.mjs"
Cohesion: 0.14
Nodes (15): ref_net, configuredBridgePort, knownContents, __dirname, DIST_RENDERER, electronPath, require, ROOT (+7 more)

### Community 58 - "devDependencies"
Cohesion: 0.12
Nodes (16): devDependencies, concurrently, electron, electron-builder, esbuild, eslint, @eslint/js, @joplin/onenote-converter (+8 more)

### Community 59 - "compilerOptions"
Cohesion: 0.12
Nodes (15): ../../tsconfig.json, compilerOptions, declaration, declarationMap, incremental, jsx, jsxImportSource, module (+7 more)

### Community 60 - "chat/handler.ts"
Cohesion: 0.23
Nodes (10): buildSystemContext(), RepoSearchRow, searchOneNoteForChat(), searchProjectBudgetForChat(), searchReposForChat(), searchSecretsForChat(), STOP_WORDS, activeChatAborts (+2 more)

### Community 61 - "CopilotUsageBadge.tsx"
Cohesion: 0.26
Nodes (14): copilotBudgetLevel, copilotUsageLimit(), AccountHeader(), CopilotUsageBadge(), CopilotUsageBadgeProps, credits(), LEVEL_COLOR, LEVEL_RANK (+6 more)

### Community 62 - "git-health.ts"
Cohesion: 0.21
Nodes (11): BranchUpstreamInfo, checkRepoHealth(), countRemotes(), DashboardSummary, escapeRegExp(), getBranchUpstream(), getCurrentBranch(), getLastCommitTime() (+3 more)

### Community 63 - "Benevolent Product Owner"
Cohesion: 0.13
Nodes (14): Benevolent Product Owner, Codebase Health, Guardrails, Mission Statement, Performance, Phase 1 — Assessment, Phase 2 — Proposals, Phase 3 — Rubber Duck Reviews (+6 more)

### Community 64 - "windows.ts"
Cohesion: 0.24
Nodes (13): attachCrashHandlers(), centerWindowBounds(), createAboutWindow(), createOnboardingWindow(), createSettingsWindow(), DEFAULT_WINDOW_SIZE, DisplayBounds, ensureWindowBoundsVisible() (+5 more)

### Community 65 - "copilot-usage-handler.test.ts"
Cohesion: 0.13
Nodes (12): _resetCopilotUsageState(), allWindows, enterpriseQuota, handlers, mockAuth, mockFetch, mockGhToken, mockPat (+4 more)

### Community 66 - "Database"
Cohesion: 0.13
Nodes (5): Database, QueryExecResult, sql.js, SqlJsStatic, Statement

### Community 67 - "Jarvis Agent — Architecture Specification"
Cohesion: 0.14
Nodes (14): 14. Initial Stack, 15. Claude Rate Limit Awareness, 1. Requirements Summary, 2. High-Level Architecture, 3. Runtime & Language implementation in TypeScript / Node.js, Core Flow, Credential Source, Decision Log (+6 more)

### Community 68 - "mcp-settings-section.tsx"
Cohesion: 0.21
Nodes (8): formatWhen(), IndexProgressView, IndexStatusView, McpClientConfigView, McpSectionApi, McpServerSection(), SNIPPET_TABS, SnippetKey

### Community 69 - "mock-jarvis-api.ts"
Cohesion: 0.15
Nodes (11): Fixtures, REPO_ROCKET, defaultResponses(), EVENT_METHODS, install(), JarvisTestControl, ok, Responder (+3 more)

### Community 70 - "dashboard/handler.ts"
Cohesion: 0.24
Nodes (8): ref_child_process, getFailedRunCount(), getLastPushedAt(), getLinkedGithubFullName(), getRepoNotifCount(), registerHandlers(), deriveWarnings(), handlers

### Community 71 - "Jarvis MCP Server"
Cohesion: 0.15
Nodes (13): Available tools, Claude Desktop configuration (manual), Data freshness, Design principle: cached data only, no credentials, Getting the client configuration from the app, GitHub tools (cached remote repos, local clones, notifications, workflow runs), Group & OneNote tools, How to navigate OneNote data (+5 more)

### Community 72 - "ensure-electron.mjs"
Cohesion: 0.22
Nodes (9): ref_url, __dirname, outDir, srcDir, DEFAULT_ROOT, __dirname, electronDir(), ensureElectron() (+1 more)

### Community 73 - "watch-electron.js"
Cohesion: 0.17
Nodes (10): fileContents, __dirname, DIST_RENDERER, electronPath, require, ROOT, scheduleRestart(), SRC_RENDERER (+2 more)

### Community 74 - "safeHandle"
Cohesion: 0.36
Nodes (10): registerTaskIpcHandlers(), registerIpcHandlers(), registerHandlers(), registerHandlers(), errorMessage(), safeHandle(), registerHandlers(), registerHandlers() (+2 more)

### Community 75 - "active-sessions/handler.ts"
Cohesion: 0.27
Nodes (10): notifyReady(), prKey(), recordReadiness(), refreshActiveSessions(), resetActiveSessionsState(), STILL_PUSHING, ActiveSessionsSnapshot, PrReadiness (+2 more)

### Community 76 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, jsx, jsxImportSource, lib, module, moduleResolution, noEmit (+4 more)

### Community 77 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, allowJs, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck (+4 more)

### Community 78 - "build-renderer.mjs"
Cohesion: 0.21
Nodes (9): esbuild, __dirname, main(), options, watch, __dirname, main(), options (+1 more)

### Community 79 - "view-harness.ts"
Cohesion: 0.18
Nodes (11): ref_node_http, ref_node_net, InvokeMethod, BuiltViews, CONTENT_TYPES, ERROR_BOUNDARY_ENTRY, MOCK_ENTRY, OpenViewOptions (+3 more)

### Community 80 - "agents/handler.ts"
Cohesion: 0.30
Nodes (11): buildCopilotHandoffIssueBody(), checkEscalationReadiness(), registerHandlers(), createAgentSession(), getAgentDefinition(), getAgentSession(), listAgentDefinitions(), detectClaudeCli() (+3 more)

### Community 81 - "update-checker.test.ts"
Cohesion: 0.18
Nodes (5): ref_node_events, getUpdateState(), MockNotification, mocks, UpdateCheckerModule

### Community 82 - "README.md"
Cohesion: 0.20
Nodes (7): Available tools, Connecting from an editor, Goals, Jarvis, MCP Server, Setup, Status

### Community 83 - "Jarvis Browser Companion — Browser Extension"
Cohesion: 0.20
Nodes (9): Architecture, Commands (Jarvis → Extension), Development, Installation (Developer Mode), Jarvis Browser Companion — Browser Extension, Owned tabs, Permissions, Security (+1 more)

### Community 84 - "ollama-provider.ts"
Cohesion: 0.36
Nodes (6): claudeAgentProvider, ollamaProvider, AgentProvider, AgentRunCallbacks, AgentRunOptions, AgentRunOutcome

### Community 85 - "AutoDismissHistoryPanel.tsx"
Cohesion: 0.31
Nodes (9): AutoDismissHistoryPanel(), BarChart(), formatDate(), formatPeriod(), Granularity, reasonIcon(), reasonLabel(), AutoDismissLogEntry (+1 more)

### Community 86 - "active-sessions.test.ts"
Cohesion: 0.22
Nodes (6): ActiveAgentSession, PendingLink, resetCloudTaskCache(), CopilotLocalDiscovery, PrLookup, NOW

### Community 87 - "useViewHarness"
Cohesion: 0.29
Nodes (6): harness, buildViews(), launchBrowser(), serve(), useViewHarness(), ViewHarness

### Community 88 - "Initial Capabilities"
Cohesion: 0.22
Nodes (9): 12.1 Repository & Organization Indexing, 12.2 Secrets Scanning, 12.3 Fork Analysis & Upstream Sync, 12.4 Maintenance Tasks, 12.5 Implementation Approach, 12. GitHub Maintenance Module, Example Interactions, Initial Capabilities (+1 more)

### Community 89 - "Product"
Cohesion: 0.22
Nodes (8): Accessibility & Inclusion, Anti-references, Brand Personality, Design Principles, Product, Product Purpose, Register, Users

### Community 90 - "git-context.ts"
Cohesion: 0.42
Nodes (8): findRepoRoot(), GitConfigSection, GitContext, hasRemoteBranch(), parseGitConfig(), readFileSafe(), resolveGitContext(), resolveGitDirs()

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

### Community 95 - "claude.test.ts"
Cohesion: 0.29
Nodes (5): ref_crypto, base64UrlEncode(), generatePkce(), isTokenExpired(), isTokenPotentiallyUsable()

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

### Community 103 - "event-bus.ts"
Cohesion: 0.43
Nodes (5): emit(), Events, Handler, on(), registry

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

### Community 109 - "OpenedView"
Cohesion: 0.33
Nodes (3): EventMethod, RecordedCall, OpenedView

### Community 110 - "16. Copilot AI Credit Budget Tracking"
Cohesion: 0.40
Nodes (5): 16. Copilot AI Credit Budget Tracking, Authentication, Budget, Data Sources, Scheduling & UI

### Community 111 - "resolveAccountToken"
Cohesion: 0.40
Nodes (5): 18. Multiple GitHub Accounts & GHE.com, Accounts and hosts, Known limits, Which account serves which repo, resolveAccountToken()

### Community 112 - "feature_request.md"
Cohesion: 0.40
Nodes (4): Additional Context, Describe Alternatives You've Considered, Describe the Solution You'd Like, Is Your Feature Request Related to a Problem?

### Community 113 - "check-db.js"
Cohesion: 0.40
Nodes (4): dbPath, fs, initSqlJs, path

### Community 114 - "13. Configuration"
Cohesion: 0.50
Nodes (4): 13. Configuration, Agent Configuration File, Encryption Key Management, Environment Variables

### Community 115 - "6. Ollama Integration"
Cohesion: 0.50
Nodes (4): 6. Ollama Integration, How Ollama Fits In, Model Selection, Tool Calling Approach

### Community 116 - "8. Local Storage"
Cohesion: 0.50
Nodes (4): 8. Local Storage, Requirements, Schema, Storage Location

### Community 117 - "allowScripts"
Cohesion: 0.50
Nodes (4): allowScripts, electron, electron-winstaller, esbuild

## Knowledge Gaps
- **828 isolated node(s):** `initSqlJs`, `fs`, `path`, `dbPath`, `initSqlJs` (+823 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1175 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `JarvisApi` connect `JarvisApi` to `mock-jarvis-api.ts`, `plugins/types.ts`, `App`, `OpenedView`, `view-harness.ts`, `UpdateState`, `Contributing to Jarvis`, `StatusBadge`?**
  _High betweenness centrality (0.157) - this node is a cross-community bridge._
- **Why does `sql.js` connect `sql.js` to `groups/handler.ts`, `notifications/handler.ts`, `saveDatabase`, `mcp-server/index.ts`, `local-file-index.ts`, `background-tasks.ts`, `copilot-usage/handler.ts`, `github-accounts.ts`, `github-oauth.ts`, `local-discovery.ts`, `main/index.ts`, `ref_fs`, `onedrive-onenote-cache.ts`, `onedrive/handler.ts`, `config.ts`, `getConfigValue`, `package.json`, `vitest`, `mcp-server/handler.ts`, `claude-agent.ts`, `claude/handler.ts`, `secrets/handler.ts`, `agents-handler.test.ts`, `runner.ts`, `github-workflows.ts`, `chat/handler.ts`, `windows.ts`, `copilot-usage-handler.test.ts`, `dashboard/handler.ts`, `safeHandle`, `active-sessions/handler.ts`, `agents/handler.ts`?**
  _High betweenness centrality (0.153) - this node is a cross-community bridge._
- **Why does `vitest` connect `vitest` to `groups/handler.ts`, `notifications/handler.ts`, `saveDatabase`, `mcp-server/index.ts`, `local-file-index.ts`, `background-tasks.ts`, `App`, `copilot-usage/handler.ts`, `github-accounts.ts`, `sql.js`, `github-oauth.ts`, `preact`, `local-discovery.ts`, `main/index.ts`, `ref_fs`, `active-sessions.ts`, `local-agent-sessions.ts`, `fixtures.ts`, `pr-readiness.ts`, `onedrive-onenote-cache.ts`, `onedrive/handler.ts`, `config.ts`, `getConfigValue`, `package.json`, `mcp-server/handler.ts`, `encryption.ts`, `claude-agent.ts`, `claude/handler.ts`, `secrets/handler.ts`, `ErrorBoundary.tsx`, `agents-handler.test.ts`, `github-host.ts`, `runner.ts`, `github-workflows.ts`, `ref_node_fs`, `onenote-reader.ts`, `chat/handler.ts`, `git-health.ts`, `windows.ts`, `copilot-usage-handler.test.ts`, `dashboard/handler.ts`, `ensure-electron.mjs`, `active-sessions/handler.ts`, `view-harness.ts`, `update-checker.test.ts`, `active-sessions.test.ts`, `useViewHarness`, `claude.test.ts`, `event-bus.ts`, `settings-and-about.view.test.ts`?**
  _High betweenness centrality (0.116) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `saveDatabase()` (e.g. with `Implementation: sql.js` and `active-sessions-handler.test.ts`) actually correct?**
  _`saveDatabase()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `initSqlJs`, `fs`, `path` to the rest of the system?**
  _828 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `JarvisApi` be split into smaller, more focused modules?**
  _Cohesion score 0.012578616352201259 - nodes in this community are weakly interconnected._
- **Should `groups/handler.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05394736842105263 - nodes in this community are weakly interconnected._