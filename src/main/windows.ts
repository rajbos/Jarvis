import { BrowserWindow, screen } from 'electron';
import path from 'path';
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../storage/database';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DisplayBounds {
  workArea: WindowBounds;
}

const DEFAULT_WINDOW_SIZE = { width: 600, height: 500 };

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

function overlapArea(bounds: WindowBounds, display: DisplayBounds): number {
  const area = display.workArea;
  const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
  const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  return width * height;
}

function centerWindowBounds(
  size: Pick<WindowBounds, 'width' | 'height'>,
  display: DisplayBounds,
): WindowBounds {
  const workArea = display.workArea;
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    width,
    height,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
  };
}

export function ensureWindowBoundsVisible(
  bounds: WindowBounds,
  displays: DisplayBounds[],
  primaryDisplay: DisplayBounds,
): WindowBounds {
  const targetDisplay = displays.reduce<{ display: DisplayBounds; overlap: number } | null>((best, display) => {
    const overlap = overlapArea(bounds, display);
    return !best || overlap > best.overlap ? { display, overlap } : best;
  }, null);

  if (!targetDisplay || targetDisplay.overlap === 0) {
    return centerWindowBounds(bounds, primaryDisplay);
  }

  const area = targetDisplay.display.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const adjusted = {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  };

  return adjusted.x === bounds.x && adjusted.y === bounds.y &&
    adjusted.width === bounds.width && adjusted.height === bounds.height
    ? bounds
    : adjusted;
}

export function createOnboardingWindow(db: SqlJsDatabase): BrowserWindow {
  const saved = loadWindowBounds(db);
  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = saved
    ? ensureWindowBoundsVisible(saved, screen.getAllDisplays(), primaryDisplay)
    : centerWindowBounds(DEFAULT_WINDOW_SIZE, primaryDisplay);

  if (saved && bounds !== saved) {
    saveWindowBounds(db, bounds);
  }

  const win = new BrowserWindow({
    ...bounds,
    title: 'Jarvis — Setup',
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const ensureCurrentBoundsVisible = () => {
    if (win.isDestroyed()) return;
    const currentBounds = win.getBounds();
    const visibleBounds = ensureWindowBoundsVisible(
      currentBounds,
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
    );
    if (visibleBounds !== currentBounds) {
      win.setBounds(visibleBounds);
      saveWindowBounds(db, visibleBounds);
    }
  };

  // Re-check the actual native window position after creation and whenever the
  // monitor layout changes while Jarvis is running.
  win.once('ready-to-show', ensureCurrentBoundsVisible);
  screen.on('display-removed', ensureCurrentBoundsVisible);
  screen.on('display-metrics-changed', ensureCurrentBoundsVisible);

  // Prevent the window from navigating to external URLs
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  // Persist bounds on move/resize
  const persistBounds = () => {
    if (!win.isDestroyed() && !win.isMinimized()) {
      saveWindowBounds(db, win.getBounds());
    }
  };
  win.on('resized', persistBounds);
  win.on('moved', persistBounds);
  win.on('closed', () => {
    screen.removeListener('display-removed', ensureCurrentBoundsVisible);
    screen.removeListener('display-metrics-changed', ensureCurrentBoundsVisible);
  });

  return win;
}

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 700,
    minWidth: 400,
    minHeight: 500,
    title: 'Jarvis — Settings',
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));

  // Prevent the window from navigating to external URLs
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  return win;
}
