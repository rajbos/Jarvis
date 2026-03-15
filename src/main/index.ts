import { app, BrowserWindow, Tray, Menu } from 'electron';
import { getDatabase, closeDatabase } from '../storage/database';
import { loadConfig } from '../agent/config';
import pkg from '../../package.json';
import { createTray } from './tray';
import { createOnboardingWindow, createSettingsWindow } from './windows';
import { getOnboardingStatus, completeOnboardingStep } from '../agent/onboarding';
import { registerIpcHandlers, startDiscoveryIfAuthed, scheduleLocalDiscovery } from './ipc-handlers';
import { checkOllama } from '../services/ollama';
import { saveDatabase } from '../storage/database';

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- held to prevent GC of the Tray icon
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

  // Check if Ollama is available and update onboarding step accordingly
  checkOllama().then((ollama) => {
    const currentStatus = getOnboardingStatus(db);
    if (ollama.available && currentStatus.ollama === 'pending') {
      completeOnboardingStep(db, 'ollama');
      saveDatabase();
      console.log('[Ollama] Found with', ollama.models.length, 'model(s) — onboarding step marked complete');
    } else if (!ollama.available && currentStatus.ollama === 'pending') {
      console.log('[Ollama] Not found at startup:', ollama.error);
    }
  }).catch((err) => {
    console.error('[Ollama] Startup check failed:', err);
  });

  // Check onboarding status
  const onboarding = getOnboardingStatus(db);
  const needsOnboarding = Object.values(onboarding).some((s) => s === 'pending');

  const openChat = () => { mainWindow?.webContents.send('chat:open'); };

  // Build native application menu
  const appMenu = Menu.buildFromTemplate([
    {
      label: pkg.name.charAt(0).toUpperCase() + pkg.name.slice(1),
      submenu: [
        { label: 'Open Chat', click: openChat },
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
  }, openChat);

  const loginSettings = app.getLoginItemSettings();
  const startedHidden = loginSettings.wasOpenedAsHidden || config.electron.startMinimized;

  if (!startedHidden) {
    showMainWindow();
  }

  // If GitHub auth is already set up, start background discovery
  if (!needsOnboarding || onboarding.github_oauth === 'completed') {
    startDiscoveryIfAuthed(db, () => mainWindow);
  }

  // Schedule periodic local-repo scanning
  scheduleLocalDiscovery(db, () => mainWindow);

  // Register for startup on login (only when packaged — in dev mode the bare
  // electron.exe would be registered without the app path, causing the default
  // Electron splash screen to appear on every Windows boot)
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: config.electron.openAtLogin,
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
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
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
