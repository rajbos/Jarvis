/**
 * Browser-side fake of the preload bridge (`window.jarvis`).
 *
 * The view harness bundles this file and injects it with Playwright's
 * addInitScript, so it runs before the renderer bundle and the real views talk to
 * it exactly as they would talk to preload.ts in Electron. No main process,
 * database or network is involved.
 *
 * - Every JarvisApi method is implemented; the mapped types below make a new
 *   preload method a compile error here until it gets a default response.
 * - Tests override responses per page via `window.__JARVIS_VIEW_OVERRIDES__`
 *   (set by the harness from `openView(..., { responses })`). Overrides cross the
 *   node → browser boundary as JSON, so they are plain values, not functions.
 * - Calls are recorded and push events can be emitted through
 *   `window.__jarvisTest`, which the node-side harness wraps.
 */
import type { JarvisApi } from '../../../src/plugins/types';
import { createFixtures, FIXTURE_USER, REPO_ROCKET, type Fixtures } from './fixtures';

/** Push-event subscriptions (`onChatToken(cb) => unsubscribe`) — everything that does not return a Promise. */
export type EventMethod = { [K in keyof JarvisApi]: ReturnType<JarvisApi[K]> extends Promise<unknown> ? never : K }[keyof JarvisApi];
/** Request/response methods backed by ipcRenderer.invoke. */
export type InvokeMethod = Exclude<keyof JarvisApi, EventMethod>;
type Result<M extends InvokeMethod> = Awaited<ReturnType<JarvisApi[M]>>;
type Responder<M extends InvokeMethod> = Result<M> | ((...args: Parameters<JarvisApi[M]>) => Result<M>);
type Responses = { [M in InvokeMethod]: Responder<M> };

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface JarvisTestControl {
  calls: RecordedCall[];
  emit(event: EventMethod, payload?: unknown): number;
  listenerCount(event: EventMethod): number;
}

declare global {
  interface Window {
    __JARVIS_VIEW_OVERRIDES__?: Partial<Record<InvokeMethod, unknown>>;
    __JARVIS_VIEW_NOW__?: number;
    __jarvisTest: JarvisTestControl;
  }
}

// Record<EventMethod, true> rather than an array so a missing event is a type error.
const EVENT_METHODS: Record<EventMethod, true> = {
  onUpdateState: true,
  onChatToken: true,
  onChatDone: true,
  onChatError: true,
  onSecretsProgress: true,
  onOpenChat: true,
  onOAuthComplete: true,
  onPatExpired: true,
  onPatStatusChanged: true,
  onDiscoveryProgress: true,
  onDiscoveryComplete: true,
  onLocalScanProgress: true,
  onLocalScanComplete: true,
  onLocalIndexProgress: true,
  onLocalIndexComplete: true,
  onAgentSessionStarting: true,
  onAgentToken: true,
  onAgentAnalysisComplete: true,
  onAgentPhase2Error: true,
  onAgentSessionComplete: true,
  onAgentSessionError: true,
  onAgentDebugContext: true,
  onBrowserExtensionConnected: true,
  onBackgroundStatus: true,
  onNewRuddrProjects: true,
  onRuddrProjectDetailsRefreshed: true,
  onCopilotUsageUpdated: true,
  onActiveSessionsUpdated: true,
  onBackgroundTaskComplete: true,
  onNotificationCountsUpdated: true,
  onAutoDismissComplete: true,
};

const ok = { ok: true } as const;

function defaultResponses(f: Fixtures): Responses {
  const now = window.__JARVIS_VIEW_NOW__ ?? Date.now();
  return {
    // App + preferences
    getPreferences: { sortByNotifications: false, localSortByNotifs: false, localRepoSortKey: 'name' },
    setPreferences: ok,
    getStartupSettings: { openAtLogin: false, startMinimized: false, canRegisterAtLogin: true },
    setStartupSettings: ok,
    getAboutInfo: {
      displayVersion: '9.9.9-fixture', appVersion: '9.9.9', isDev: true, branch: 'fixture-branch',
      releasedAt: null, releaseUrl: null, repoUrl: 'https://example.invalid/jarvis',
    },
    getUpdateState: { status: 'up-to-date' },
    checkForUpdatesNow: { status: 'up-to-date' },
    installUpdate: ok,
    getSystemLocale: 'en-US',
    openSettings: undefined,
    shellOpenUrl: ok,
    // GitHub auth + discovery
    startGitHubOAuth: { login: FIXTURE_USER },
    getGitHubOAuthStatus: { authenticated: true, login: FIXTURE_USER },
    getDiscoveryStatus: { running: false, progress: { phase: 'done', orgsFound: 2, reposFound: 3 } },
    startPatDiscovery: { started: true },
    startOAuthDiscovery: ok,
    savePat: ok,
    deletePat: ok,
    getPatStatus: { hasPat: false },
    logout: ok,
    getGitHubRateLimit: f.rateLimit,
    // Orgs + repos
    listOrgs: f.orgs,
    setOrgEnabled: undefined,
    approveLargeOrg: undefined,
    searchRepos: (query) => Object.values(f.reposByOrg).flat().filter((r) => r.full_name.includes(query)),
    listReposForOrg: (org) => (org ? f.reposByOrg[org] ?? [] : []),
    listStarred: [],
    openUrl: undefined,
    // Notifications
    fetchNotifications: f.notificationCounts,
    getNotificationCounts: f.notificationCounts,
    fetchNotificationsForOwner: f.notificationCounts,
    fetchNotificationsForRepo: f.notificationCounts,
    listNotificationsForRepo: (repo) => f.notifications.filter((n) => n.repo_full_name === repo),
    listNotificationsForOwner: (owner) => f.notifications.filter((n) => n.repo_owner === owner),
    listNotificationsForStarred: [],
    dismissNotification: undefined,
    getRunUrlForCheckSuite: `https://github.com/${REPO_ROCKET}/actions/runs/7001`,
    githubGetIssueState: { state: 'open', closedByMe: false, closedViaMergedPr: false },
    listAutoDismissLog: f.autoDismissLog,
    getAutoDismissStats: f.autoDismissStats,
    // Ollama + chat
    checkOllama: f.ollama,
    getSelectedOllamaModel: null,
    setSelectedOllamaModel: ok,
    sendChatMessage: ok,
    abortChat: ok,
    // Local repos + index
    localGetFolders: f.scanFolders,
    localAddFolder: { canceled: true },
    localRemoveFolder: ok,
    localGetScanStatus: { running: false, progress: { phase: 'done', foldersScanned: 5, reposFound: f.localRepos.length } },
    localGetIndexStatus: f.localIndexStatus,
    mcpGetClientConfig: f.mcpConfig,
    localStartIndex: { started: true },
    localStartScan: { started: true },
    localListRepos: f.localRepos,
    localListReposForFolder: f.localRepos,
    localOpenFolder: undefined,
    localOpenTerminal: undefined,
    // Secrets
    scanRepoSecrets: { scanned: 3, secretsFound: f.secrets.length, errors: [] },
    listAllSecrets: f.secrets,
    listSecretFavorites: [],
    addSecretFavorite: ok,
    removeSecretFavorite: ok,
    // Agents
    agentsList: f.agents,
    agentsUpdate: ok,
    agentsRun: { sessionId: 1 },
    agentsGetSession: null,
    agentsApproveFinding: ok,
    agentsRejectFinding: ok,
    agentsExecuteFinding: ok,
    agentsCheckCopilotAvailability: { available: true },
    agentsEscalationReadiness: ok,
    agentsEscalate: ok,
    // Workflows + dashboard
    githubFetchWorkflowRuns: { ok: true, count: 1 },
    githubGetWorkflowSummary: f.workflowSummary,
    githubGetCachedWorkflowInfo: { fetchedAt: new Date(now).toISOString(), runCount: 1 },
    dashboardGetSummary: f.dashboard,
    dashboardPushBranchUpstream: ok,
    // Groups + Ruddr
    groupsList: f.groups,
    groupsGet: (id) => f.groupDetails[id] ?? null,
    groupsCreate: { ok: true, id: 3 },
    groupsRename: ok,
    groupsDelete: ok,
    groupsAddLocalRepo: ok,
    groupsRemoveLocalRepo: ok,
    groupsRemoveGithubRepo: ok,
    groupsFindRuddrProjects: { ok: true, allCount: 1, matches: [] },
    groupsSetRuddrProject: ok,
    groupsRemoveRuddrProject: ok,
    groupsRefreshRuddrCache: ok,
    groupsSyncRuddrCacheNow: { ok: true, count: 1 },
    groupsGetRuddrCache: { ok: true, projects: f.groups.flatMap((g) => g.ruddrProjectNames) },
    groupsGetRuddrProjectInfo: (name) => ({ ok: true, name, path: `/projects/${encodeURIComponent(name)}`, note: 'Fixture project note', cloudFolderUrl: null }),
    groupsListRuddrProjects: { ok: true, projects: [] },
    groupsGetRuddrWorkspace: { ok: true, workspace: 'fixture-workspace' },
    groupsSetRuddrWorkspace: ok,
    groupsGetRuddrBudget: f.ruddrBudget,
    groupsGetRuddrBudgetCache: { ok: true, budgets: Object.fromEntries(f.groups.flatMap((g) => g.ruddrProjectNames).map((n) => [n, f.ruddrBudget])) },
    // OneDrive / OneNote
    onedriveListRoots: f.onedriveRoots,
    onedriveBrowseFolder: { canceled: true },
    onedriveAddRoot: { ok: false, canceled: true },
    onedriveRemoveRoot: ok,
    onedriveDiscoverForGroup: { ok: true, folders: [] },
    onedriveRescanFiles: { ok: true, fileCount: 0 },
    onedriveListFilesForFolder: [],
    onedriveReadOneNoteFile: { ok: false, error: 'No OneNote files in fixtures' },
    onedriveReadUrlShortcut: { ok: false, error: 'No shortcuts in fixtures' },
    onedriveCacheOneNoteFilesForGroup: { filesProcessed: 0, pagesCached: 0, filesSkipped: 0, errors: [] },
    onedriveGetOneNoteCacheForGroup: { pages: [] },
    // Browser companion
    browserStatus: { running: true, port: 47001, connectedClients: 0 },
    browserGetToken: { token: 'fixture-token-not-a-secret' },
    browserRegenerateToken: { token: 'fixture-token-regenerated' },
    browserListSkills: f.browserSkills,
    browserCreateSkill: { ok: true, id: 2 },
    browserUpdateSkill: ok,
    browserDeleteSkill: ok,
    browserListRuns: f.browserRuns,
    browserRunSkill: { ok: true, runId: 1, data: null },
    browserFocusWindow: ok,
    // Claude + Copilot usage
    getClaudeStatus: f.claudeStatus,
    getClaudeRateLimit: f.claudeRateLimit,
    disconnectClaude: ok,
    beginClaudeOAuth: { ok: true, authorizeUrl: 'https://example.invalid/claude-oauth' },
    completeClaudeOAuth: ok,
    getCopilotUsage: f.copilotUsage,
    refreshCopilotUsage: f.copilotUsage,
    getCopilotBudget: { ok: true, budgetCredits: null },
    setCopilotBudget: { ok: true, budgetCredits: null },
    listGitHubAccounts: f.githubAccounts,
    getGitHubAccountsUsage: f.githubAccountsUsage,
    setGitHubAccountBudget: { ok: true, budgetCredits: null },
    addGitHubHostAccount: { ok: true, account: 'new-user@fixture.ghe.com', login: 'new-user' },
    setPrimaryGitHubAccount: ok,
    removeGitHubAccount: ok,
    setGitHubAccountAssignment: { ok: true, assignments: f.githubAccounts.assignments },
    syncGitHubAccountsFromGitConfig: { ok: true, imported: 0, keptManual: 0, assignments: [] },
    resolveGitHubAccountForRepo: { ok: true, resolved: null },
    // Active sessions + background tasks
    getActiveSessions: f.activeSessions,
    refreshActiveSessions: f.activeSessions,
    listBackgroundTasks: f.backgroundTasks,
    listRecentTaskFailures: [],
    runBackgroundTaskNow: {
      taskId: 'notifications', status: 'success', startedAt: new Date(now).toISOString(),
      finishedAt: new Date(now).toISOString(), durationMs: 5,
    },
  };
}

function install(): void {
  const fixtures = createFixtures(window.__JARVIS_VIEW_NOW__ ?? Date.now());
  const responses = defaultResponses(fixtures) as Record<string, unknown>;
  const overrides = window.__JARVIS_VIEW_OVERRIDES__ ?? {};
  const calls: RecordedCall[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const api: Record<string, unknown> = {};

  for (const method of Object.keys(responses)) {
    api[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      const source = method in overrides ? (overrides as Record<string, unknown>)[method] : responses[method];
      try {
        const value = typeof source === 'function' ? (source as (...a: unknown[]) => unknown)(...args) : source;
        // Hand out copies so a view mutating a response cannot change the next one.
        return Promise.resolve(value === undefined ? undefined : structuredClone(value));
      } catch (err) {
        return Promise.reject(err);
      }
    };
  }

  for (const event of Object.keys(EVENT_METHODS)) {
    api[event] = (cb: (payload: unknown) => void) => {
      calls.push({ method: event, args: [] });
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
      return () => { set.delete(cb); };
    };
  }

  window.jarvis = api as unknown as JarvisApi;
  window.__jarvisTest = {
    calls,
    emit(event, payload) {
      const set = listeners.get(event);
      for (const cb of set ?? []) cb(payload);
      return set?.size ?? 0;
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

install();
