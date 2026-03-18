import { contextBridge, ipcRenderer } from 'electron';

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
    ipcRenderer.on('chat:token', (_event, token) => callback(token));
  },
  onChatDone: (callback: () => void) => {
    ipcRenderer.on('chat:done', () => callback());
  },
  onChatError: (callback: (error: string) => void) => {
    ipcRenderer.on('chat:error', (_event, error) => callback(error));
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
  onSecretsProgress: (callback: (progress: Record<string, number>) => void) => {
    ipcRenderer.on('secrets:scan-progress', (_event, progress) => callback(progress));
  },
  onOpenChat: (callback: () => void) => {
    ipcRenderer.on('chat:open', () => callback());
  },
  onOAuthComplete: (callback: (result: Record<string, string>) => void) => {
    ipcRenderer.on('github:oauth-complete', (_event, result) => callback(result));
  },
  onDiscoveryProgress: (callback: (progress: Record<string, unknown>) => void) => {
    ipcRenderer.on('github:discovery-progress', (_event, progress) => callback(progress));
  },
  onDiscoveryComplete: (callback: (progress: Record<string, unknown>) => void) => {
    ipcRenderer.on('github:discovery-complete', (_event, progress) => callback(progress));
  },
  onLocalScanProgress: (callback: (progress: Record<string, unknown>) => void) => {
    ipcRenderer.on('local:scan-progress', (_event, progress) => callback(progress));
  },
  onLocalScanComplete: (callback: (progress: Record<string, unknown>) => void) => {
    ipcRenderer.on('local:scan-complete', (_event, progress) => callback(progress));
  },
});
