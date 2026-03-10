import { BrowserWindow } from 'electron';
import path from 'path';

export function createOnboardingWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 600,
    height: 500,
    title: 'Jarvis — Setup',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open DevTools in development
  win.webContents.openDevTools({ mode: 'bottom' });

  return win;
}
