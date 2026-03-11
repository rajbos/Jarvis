import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jarvis', {
  getOnboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  checkOllama: () => ipcRenderer.invoke('ollama:status'),
  listOllamaModels: () => ipcRenderer.invoke('ollama:list-models'),
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
  onOAuthComplete: (callback: (result: Record<string, string>) => void) => {
    ipcRenderer.on('github:oauth-complete', (_event, result) => callback(result));
  },
  onDiscoveryProgress: (callback: (progress: Record<string, unknown>) => void) => {
    ipcRenderer.on('github:discovery-progress', (_event, progress) => callback(progress));
  },
  onDiscoveryComplete: (callback: (progress: Record<string, unknown>) => void) => {
    ipcRenderer.on('github:discovery-complete', (_event, progress) => callback(progress));
  },
});
