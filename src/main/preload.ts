import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jarvis', {
  getOnboardingStatus: () => ipcRenderer.invoke('onboarding:status'),
  startGitHubOAuth: () => ipcRenderer.invoke('github:start-oauth'),
  getGitHubOAuthStatus: () => ipcRenderer.invoke('github:oauth-status'),
  onOAuthComplete: (callback: (result: Record<string, string>) => void) => {
    ipcRenderer.on('github:oauth-complete', (_event, result) => callback(result));
  },
});
