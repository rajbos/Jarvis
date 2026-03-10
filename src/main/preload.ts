import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jarvis', {
  getOnboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  startGitHubOAuth: () => ipcRenderer.invoke('github:start-oauth'),
  getGitHubOAuthStatus: () => ipcRenderer.invoke('github:oauth-status'),
  getDiscoveryStatus: () => ipcRenderer.invoke('github:discovery-status'),
  startDiscovery: () => ipcRenderer.invoke('github:start-discovery'),
  listOrgs: () => ipcRenderer.invoke('github:list-orgs'),
  setOrgEnabled: (orgLogin: string, enabled: boolean) =>
    ipcRenderer.invoke('github:set-org-enabled', orgLogin, enabled),
  searchRepos: (query: string) => ipcRenderer.invoke('github:search-repos', query),
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
