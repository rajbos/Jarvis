import { app, BrowserWindow, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'path';
import { getDatabase, closeDatabase } from '../storage/database';
import { loadConfig } from '../agent/config';
import { createTray } from './tray';
import { createOnboardingWindow } from './windows';
import { getOnboardingStatus } from '../agent/onboarding';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

async function initialize(): Promise<void> {
  const config = loadConfig();

  // Initialize the database (creates it if not present)
  const db = await getDatabase(config.storage.database);
  console.log('Database initialized at:', config.storage.database);

  // Register IPC handlers for renderer ↔ main communication
  registerIpcHandlers(db, () => mainWindow);

  // Check onboarding status
  const onboarding = getOnboardingStatus(db);
  const needsOnboarding = Object.values(onboarding).some((s) => s === 'pending');

  // Create system tray
  tray = createTray(() => {
    showMainWindow();
  });

  if (needsOnboarding) {
    showMainWindow();
  }

  // Register for startup on login
  if (config.electron.openAtLogin) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });
  }
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = createOnboardingWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  initialize();
});

app.on('window-all-closed', () => {
  // Don't quit on window close — keep running in tray
});

app.on('before-quit', () => {
  closeDatabase();
});
