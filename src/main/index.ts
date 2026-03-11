import { app, BrowserWindow, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'path';
import pkg from '../../package.json';
import { getDatabase, closeDatabase } from '../storage/database';
import { loadConfig } from '../agent/config';
import { createTray } from './tray';
import { createOnboardingWindow, createSettingsWindow } from './windows';
import { getOnboardingStatus } from '../agent/onboarding';
import { registerIpcHandlers, startDiscoveryIfAuthed } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let currentDb: Awaited<ReturnType<typeof getDatabase>> | null = null;

async function initialize(): Promise<void> {
  const config = loadConfig();

  // Initialize the database (creates it if not present)
  const db = await getDatabase(config.storage.database);
  currentDb = db;
  console.log('Database initialized at:', config.storage.database);

  // Register IPC handlers for renderer ↔ main communication
  registerIpcHandlers(db, () => mainWindow);

  // Check onboarding status
  const onboarding = getOnboardingStatus(db);
  const needsOnboarding = Object.values(onboarding).some((s) => s === 'pending');

  // Build native application menu
  const appMenu = Menu.buildFromTemplate([
    {
      label: pkg.name.charAt(0).toUpperCase() + pkg.name.slice(1),
      submenu: [
        { label: 'Settings', click: () => showSettingsWindow() },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => { mainWindow?.webContents.toggleDevTools(); },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);

  // Create system tray
  tray = createTray(() => {
    showMainWindow();
  }, () => {
    showSettingsWindow();
  });

  if (needsOnboarding) {
    showMainWindow();
  }

  // If GitHub auth is already set up, start background discovery
  if (!needsOnboarding || onboarding.github_oauth === 'completed') {
    startDiscoveryIfAuthed(db, () => mainWindow);
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
  mainWindow = createOnboardingWindow(currentDb!);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = createSettingsWindow();
  settingsWindow.on('closed', () => {
    settingsWindow = null;
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
