import { safeHandle } from '../plugins/ipc-utils';

/** IPC that lets the renderer ask the main process to open the Settings window. */
export function registerAppWindowIpcHandlers(showSettingsWindow: () => void): void {
  safeHandle('app:open-settings', () => {
    showSettingsWindow();
  });
}
