import { BrowserWindow, screen } from 'electron';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../storage/database';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function loadWindowBounds(db: SqlJsDatabase): WindowBounds | null {
  try {
    const stmt = db.prepare("SELECT value FROM config WHERE key = 'window_bounds'");
    if (stmt.step()) {
      const row = stmt.getAsObject() as { value: string };
      stmt.free();
      return JSON.parse(row.value) as WindowBounds;
    }
    stmt.free();
  } catch {
    // ignore parse errors
  }
  return null;
}

function saveWindowBounds(db: SqlJsDatabase, bounds: WindowBounds): void {
  db.run(
    "INSERT INTO config (key, value) VALUES ('window_bounds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify(bounds)],
  );
  saveDatabase();
}

function boundsAreVisible(bounds: WindowBounds): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    // Check that at least part of the window is within this display
    return (
      bounds.x < x + width &&
      bounds.x + bounds.width > x &&
      bounds.y < y + height &&
      bounds.y + bounds.height > y
    );
  });
}

export function createOnboardingWindow(db: SqlJsDatabase): BrowserWindow {
  const saved = loadWindowBounds(db);
  const useSaved = saved && boundsAreVisible(saved);

  const win = new BrowserWindow({
    width: useSaved ? saved.width : 600,
    height: useSaved ? saved.height : 500,
    ...(useSaved ? { x: saved.x, y: saved.y } : {}),
    title: 'Jarvis — Setup',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Persist bounds on move/resize
  const persistBounds = () => {
    if (!win.isDestroyed() && !win.isMinimized()) {
      saveWindowBounds(db, win.getBounds());
    }
  };
  win.on('resized', persistBounds);
  win.on('moved', persistBounds);

  // Open DevTools in development
  win.webContents.openDevTools({ mode: 'bottom' });

  return win;
}
