import { contextBridge, ipcRenderer } from 'electron';
import type { DiscoveryProgress, LocalScanProgress, SecretsScanProgress } from '../plugins/types';
import type {
  AgentSessionStartingPayload,
  AgentAnalysisCompletePayload,
  AgentPhase2ErrorPayload,
  AgentSessionCompletePayload,
  AgentSessionErrorPayload,
  AgentDebugContextPayload,
} from '../types/ipc-payloads';

contextBridge.exposeInMainWorld('jarvis', {
  getOnboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  getPreferences: () => ipcRenderer.invoke('app:get-preferences'),
  setPreferences: (prefs: Record<string, unknown>) => ipcRenderer.invoke('app:set-preferences', prefs),
  checkOllama: () => ipcRenderer.invoke('ollama:status'),
  listOllamaModels: () => ipcRenderer.invoke('ollama:list-models'),
  getSelectedOllamaModel: () => ipcRenderer.invoke('ollama:get-selected-model'),
  setSelectedOllamaModel: (modelName: string) => ipcRenderer.invoke('ollama:set-selected-model', modelName),
  sendChatMessage: (messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke('chat:send', messages),
  abortChat: () => ipcRenderer.invoke('chat:abort'),
  adjustWindowWidth: (delta: number) => ipcRenderer.invoke('window:adjust-width', delta),
  onChatToken: (callback: (token: string) => void) => {
    const listener = (_event: unknown, token: string) => callback(token);
    ipcRenderer.on('chat:token', listener);
    return () => { ipcRenderer.removeListener('chat:token', listener); };
  },
  onChatDone: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('chat:done', listener);
    return () => { ipcRenderer.removeListener('chat:done', listener); };
  },
  onChatError: (callback: (error: string) => void) => {
    const listener = (_event: unknown, error: string) => callback(error);
    ipcRenderer.on('chat:error', listener);
    return () => { ipcRenderer.removeListener('chat:error', listener); };
  },
  startGitHubOAuth: () => ipcRenderer.invoke('github:start-oauth'),
  getGitHubOAuthStatus: () => ipcRenderer.invoke('github:oauth-status'),
  getDiscoveryStatus: () => ipcRenderer.invoke('github:discovery-status'),
  startDiscovery: () => ipcRenderer.invoke('github:start-discovery'),
  startPatDiscovery: () => ipcRenderer.invoke('github:start-pat-discovery'),
  listOrgs: () => ipcRenderer.invoke('github:list-orgs'),
  setOrgEnabled: (orgLogin: string, enabled: boolean) =>
    ipcRenderer.invoke('github:set-org-enabled', orgLogin, enabled),
  savePat: (pat: string) => ipcRenderer.invoke('github:save-pat', pat),
  deletePat: () => ipcRenderer.invoke('github:delete-pat'),
  getPatStatus: () => ipcRenderer.invoke('github:pat-status'),
  logout: () => ipcRenderer.invoke('github:logout'),
  startOAuthDiscovery: () => ipcRenderer.invoke('github:start-oauth-discovery'),
  searchRepos: (query: string) => ipcRenderer.invoke('github:search-repos', query),
  listReposForOrg: (orgLogin: string | null) => ipcRenderer.invoke('github:list-repos-for-org', orgLogin),
  listStarred: () => ipcRenderer.invoke('github:list-starred'),
  openUrl: (url: string) => ipcRenderer.invoke('github:open-url', url),
  fetchNotifications: () => ipcRenderer.invoke('github:fetch-notifications'),
  getNotificationCounts: () => ipcRenderer.invoke('github:notification-counts'),
  fetchNotificationsForOwner: (owner: string) =>
    ipcRenderer.invoke('github:fetch-notifications-for-owner', owner),
  fetchNotificationsForRepo: (repoFullName: string) =>
    ipcRenderer.invoke('github:fetch-notifications-for-repo', repoFullName),
  listNotificationsForRepo: (repoFullName: string) =>
    ipcRenderer.invoke('github:list-notifications-for-repo', repoFullName),
  listNotificationsForOwner: (owner: string) =>
    ipcRenderer.invoke('github:list-notifications-for-owner', owner),
  listNotificationsForStarred: () =>
    ipcRenderer.invoke('github:list-notifications-for-starred'),
  dismissNotification: (id: string) =>
    ipcRenderer.invoke('github:dismiss-notification', id),
  getRunUrlForCheckSuite: (checkSuiteApiUrl: string) =>
    ipcRenderer.invoke('github:get-run-url-for-check-suite', checkSuiteApiUrl),
  // Local repos
  localGetFolders: () => ipcRenderer.invoke('local:get-folders'),
  localAddFolder: (folderPath?: string) => ipcRenderer.invoke('local:add-folder', folderPath),
  localRemoveFolder: (folderPath: string) => ipcRenderer.invoke('local:remove-folder', folderPath),
  localGetScanStatus: () => ipcRenderer.invoke('local:get-scan-status'),
  localStartScan: () => ipcRenderer.invoke('local:start-scan'),
  localListRepos: () => ipcRenderer.invoke('local:list-repos'),
  localListReposForFolder: (folderPath: string) => ipcRenderer.invoke('local:list-repos-for-folder', folderPath),
  localLinkRepo: (localRepoId: number, githubRepoId: number | null) =>
    ipcRenderer.invoke('local:link-repo', localRepoId, githubRepoId),
  localOpenFolder: (folderPath: string) => ipcRenderer.invoke('local:open-folder', folderPath),
  // Secrets
  scanRepoSecrets: () => ipcRenderer.invoke('secrets:scan'),
  listSecretsForRepo: (repoFullName: string) => ipcRenderer.invoke('secrets:list-for-repo', repoFullName),
  listAllSecrets: () => ipcRenderer.invoke('secrets:list-all'),
  listSecretFavorites: () => ipcRenderer.invoke('secrets:list-favorites'),
  addSecretFavorite: (targetType: string, targetName: string) => ipcRenderer.invoke('secrets:add-favorite', targetType, targetName),
  removeSecretFavorite: (targetName: string) => ipcRenderer.invoke('secrets:remove-favorite', targetName),
  onSecretsProgress: (callback: (progress: SecretsScanProgress) => void) => {
    const listener = (_event: unknown, progress: SecretsScanProgress) => callback(progress);
    ipcRenderer.on('secrets:scan-progress', listener);
    return () => { ipcRenderer.removeListener('secrets:scan-progress', listener); };
  },
  onOpenChat: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('chat:open', listener);
    return () => { ipcRenderer.removeListener('chat:open', listener); };
  },
  onOAuthComplete: (callback: (result: Record<string, string>) => void) => {
    const listener = (_event: unknown, result: Record<string, string>) => callback(result);
    ipcRenderer.on('github:oauth-complete', listener);
    return () => { ipcRenderer.removeListener('github:oauth-complete', listener); };
  },
  onDiscoveryProgress: (callback: (progress: DiscoveryProgress) => void) => {
    const listener = (_event: unknown, progress: DiscoveryProgress) => callback(progress);
    ipcRenderer.on('github:discovery-progress', listener);
    return () => { ipcRenderer.removeListener('github:discovery-progress', listener); };
  },
  onDiscoveryComplete: (callback: (progress: DiscoveryProgress) => void) => {
    const listener = (_event: unknown, progress: DiscoveryProgress) => callback(progress);
    ipcRenderer.on('github:discovery-complete', listener);
    return () => { ipcRenderer.removeListener('github:discovery-complete', listener); };
  },
  onLocalScanProgress: (callback: (progress: LocalScanProgress) => void) => {
    const listener = (_event: unknown, progress: LocalScanProgress) => callback(progress);
    ipcRenderer.on('local:scan-progress', listener);
    return () => { ipcRenderer.removeListener('local:scan-progress', listener); };
  },
  onLocalScanComplete: (callback: (progress: LocalScanProgress) => void) => {
    const listener = (_event: unknown, progress: LocalScanProgress) => callback(progress);
    ipcRenderer.on('local:scan-complete', listener);
    return () => { ipcRenderer.removeListener('local:scan-complete', listener); };
  },
  // Agents
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsUpdate: (agentId: number, systemPrompt: string) =>
    ipcRenderer.invoke('agents:update', agentId, systemPrompt),
  agentsRun: (agentId: number, scopeType: 'repo' | 'org' | 'global', scopeValue: string, workflowFilter?: string) =>
    ipcRenderer.invoke('agents:run', agentId, scopeType, scopeValue, workflowFilter),
  agentsGetSession: (sessionId: number) => ipcRenderer.invoke('agents:get-session', sessionId),
  agentsApproveFinding: (findingId: number) => ipcRenderer.invoke('agents:approve-finding', findingId),
  agentsRejectFinding: (findingId: number) => ipcRenderer.invoke('agents:reject-finding', findingId),
  agentsExecuteFinding: (findingId: number) => ipcRenderer.invoke('agents:execute-finding', findingId),
  onAgentSessionStarting: (callback: (data: AgentSessionStartingPayload) => void) => {
    const listener = (_event: unknown, data: AgentSessionStartingPayload) => callback(data);
    ipcRenderer.on('agent:session-starting', listener);
    return () => { ipcRenderer.removeListener('agent:session-starting', listener); };
  },
  onAgentToken: (callback: (token: string) => void) => {
    const listener = (_event: unknown, token: string) => callback(token);
    ipcRenderer.on('agent:token', listener);
    return () => { ipcRenderer.removeListener('agent:token', listener); };
  },
  onAgentAnalysisComplete: (callback: (data: AgentAnalysisCompletePayload) => void) => {
    const listener = (_event: unknown, data: AgentAnalysisCompletePayload) => callback(data);
    ipcRenderer.on('agent:analysis-complete', listener);
    return () => { ipcRenderer.removeListener('agent:analysis-complete', listener); };
  },
  onAgentPhase2Error: (callback: (data: AgentPhase2ErrorPayload) => void) => {
    const listener = (_event: unknown, data: AgentPhase2ErrorPayload) => callback(data);
    ipcRenderer.on('agent:phase2-error', listener);
    return () => { ipcRenderer.removeListener('agent:phase2-error', listener); };
  },
  onAgentSessionComplete: (callback: (result: AgentSessionCompletePayload) => void) => {
    const listener = (_event: unknown, result: AgentSessionCompletePayload) => callback(result);
    ipcRenderer.on('agent:session-complete', listener);
    return () => { ipcRenderer.removeListener('agent:session-complete', listener); };
  },
  onAgentSessionError: (callback: (error: AgentSessionErrorPayload) => void) => {
    const listener = (_event: unknown, error: AgentSessionErrorPayload) => callback(error);
    ipcRenderer.on('agent:session-error', listener);
    return () => { ipcRenderer.removeListener('agent:session-error', listener); };
  },
  onAgentDebugContext: (callback: (data: AgentDebugContextPayload) => void) => {
    const listener = (_event: unknown, data: AgentDebugContextPayload) => callback(data);
    ipcRenderer.on('agent:debug-context', listener);
    return () => { ipcRenderer.removeListener('agent:debug-context', listener); };
  },
  // Workflow data
  githubFetchWorkflowRuns: (repoFullName: string) =>
    ipcRenderer.invoke('github:fetch-workflow-runs', repoFullName),
  githubGetWorkflowSummary: (repoFullName: string) =>
    ipcRenderer.invoke('github:get-workflow-summary', repoFullName),
  githubGetCachedWorkflowInfo: (repoFullName: string) =>
    ipcRenderer.invoke('github:get-cached-workflow-info', repoFullName),
  // Dashboard
  dashboardGetSummary: () => ipcRenderer.invoke('dashboard:get-summary'),
  dashboardGetRecentFailedRuns: () => ipcRenderer.invoke('dashboard:get-recent-failed-runs'),
  dashboardPushBranchUpstream: (repoPath: string, branch: string) =>
    ipcRenderer.invoke('dashboard:push-branch-upstream', repoPath, branch),
  // Groups
  groupsList: () => ipcRenderer.invoke('groups:list'),
  groupsGet: (groupId: number) => ipcRenderer.invoke('groups:get', groupId),
  groupsCreate: (name: string) => ipcRenderer.invoke('groups:create', name),
  groupsRename: (groupId: number, newName: string) => ipcRenderer.invoke('groups:rename', groupId, newName),
  groupsDelete: (groupId: number) => ipcRenderer.invoke('groups:delete', groupId),
  groupsAddLocalRepo: (groupId: number, localRepoId: number) =>
    ipcRenderer.invoke('groups:add-local-repo', groupId, localRepoId),
  groupsRemoveLocalRepo: (groupId: number, localRepoId: number) =>
    ipcRenderer.invoke('groups:remove-local-repo', groupId, localRepoId),
  groupsAddGithubRepo: (groupId: number, githubRepoId: number) =>
    ipcRenderer.invoke('groups:add-github-repo', groupId, githubRepoId),
  groupsRemoveGithubRepo: (groupId: number, githubRepoId: number) =>
    ipcRenderer.invoke('groups:remove-github-repo', groupId, githubRepoId),
  // Browser Companion
  browserStatus: () => ipcRenderer.invoke('browser:status'),
  browserListSkills: () => ipcRenderer.invoke('browser:list-skills'),
  browserCreateSkill: (name: string, description: string, startUrl: string, instructions: string, extractSelector: string) =>
    ipcRenderer.invoke('browser:create-skill', name, description, startUrl, instructions, extractSelector),
  browserUpdateSkill: (id: number, name: string, description: string, startUrl: string, instructions: string, extractSelector: string) =>
    ipcRenderer.invoke('browser:update-skill', id, name, description, startUrl, instructions, extractSelector),
  browserDeleteSkill: (id: number) => ipcRenderer.invoke('browser:delete-skill', id),
  browserListRuns: (skillId?: number) => ipcRenderer.invoke('browser:list-runs', skillId),
  browserRunSkill: (skillId: number, testMode?: boolean) =>
    ipcRenderer.invoke('browser:run-skill', skillId, testMode ?? false),
  browserNavigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
  browserListTabs: () => ipcRenderer.invoke('browser:list-tabs'),
  browserGetPageContent: (tabId?: number) => ipcRenderer.invoke('browser:get-page-content', tabId),
  onBrowserExtensionConnected: (callback: (data: { count: number }) => void) => {
    const listener = (_event: unknown, data: { count: number }) => callback(data);
    ipcRenderer.on('browser:extension-connected', listener);
    return () => { ipcRenderer.removeListener('browser:extension-connected', listener); };
  },
  // Ruddr project links
  ruddrListLinks: (groupId?: number) => ipcRenderer.invoke('ruddr:list-links', groupId),
  ruddrAddLink: (groupId: number, workspace: string, projectId: string, projectName: string, projectUrl: string, extractSelector: string) =>
    ipcRenderer.invoke('ruddr:add-link', groupId, workspace, projectId, projectName, projectUrl, extractSelector),
  ruddrUpdateLink: (id: number, projectName: string, projectUrl: string, extractSelector: string) =>
    ipcRenderer.invoke('ruddr:update-link', id, projectName, projectUrl, extractSelector),
  ruddrRemoveLink: (id: number) => ipcRenderer.invoke('ruddr:remove-link', id),
  ruddrFetchProjectState: (linkId: number) => ipcRenderer.invoke('ruddr:fetch-project-state', linkId),
});
