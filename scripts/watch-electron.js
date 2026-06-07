#!/usr/bin/env node
// Spawns Electron, restarts it when dist/ changes, and exits when the user quits the app.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronPath = String(require('electron'));
const ROOT = path.join(__dirname, '..');
const WATCH_DIRS = [
  path.join(ROOT, 'dist', 'main'),
  path.join(ROOT, 'dist', 'renderer'),
];

let electronProcess = null;
let intentionalRestart = false;
let debounceTimer = null;
// Ignore file-change events for this many ms after (re)starting electron.
// Covers tsc --watch and esbuild --watch doing their initial output writes.
const STARTUP_GRACE_MS = 4000;
let graceUntil = 0;

// Per-file content cache so we only restart when a file actually changed.
const fileContents = new Map();

function seedContentCache(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    if (!/\.(js|html|css)$/.test(filename)) continue;
    const fullPath = path.join(entry.parentPath ?? entry.path ?? dir, filename);
    try { fileContents.set(fullPath, fs.readFileSync(fullPath)); } catch { /* skip */ }
  }
}

function contentChanged(filePath) {
  try {
    const current = fs.readFileSync(filePath);
    const prev = fileContents.get(filePath);
    fileContents.set(filePath, current);
    if (prev && prev.equals(current)) return false;
    return true;
  } catch {
    return true; // file unreadable — assume changed
  }
}

function startElectron() {
  intentionalRestart = false;
  graceUntil = Date.now() + STARTUP_GRACE_MS;
  console.log('[watch-electron] starting electron...');
  electronProcess = spawn(electronPath, ['dist/main/index.js'], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  electronProcess.on('exit', () => {
    electronProcess = null;
    if (intentionalRestart) {
      startElectron(); // restarted due to file change — respawn
    } else {
      // User quit via tray or window — propagate the exit
      console.log('[watch-electron] app exited, stopping watcher');
      process.exit(0);
    }
  });
}

function scheduleRestart() {
  if (Date.now() < graceUntil) return; // still in startup grace window
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (electronProcess) {
      console.log('[watch-electron] restarting due to changes...');
      intentionalRestart = true;
      electronProcess.kill();
      // startElectron() is called from the exit handler above
    } else {
      startElectron();
    }
  }, 800); // wait 800ms for tsc to finish writing all files
}

const SRC_RENDERER = path.join(ROOT, 'src', 'renderer');
const DIST_RENDERER = path.join(ROOT, 'dist', 'renderer');

for (const dir of WATCH_DIRS) {
  if (fs.existsSync(dir)) {
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || !/\.(js|html|css)$/.test(filename)) return;
      const fullPath = path.join(dir, filename);
      if (!contentChanged(fullPath)) return;
      scheduleRestart();
    });
  }
}

// Watch src/renderer/ and copy static files to dist/renderer/ immediately.
// This means changes to index.html / renderer.js are picked up without a full tsc run.
if (fs.existsSync(SRC_RENDERER)) {
  fs.watch(SRC_RENDERER, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Only handle actual renderer assets — ignore .db files, editor swap files, etc.
    if (!/\.(html|js|css)$/.test(filename)) return;
    const src = path.join(SRC_RENDERER, filename);
    const dest = path.join(DIST_RENDERER, filename);
    try {
      if (!fs.existsSync(src)) return;
      // Skip copy (and the restart it would trigger) when content is identical.
      // Windows can fire spurious change events on file reads / metadata updates.
      if (fs.existsSync(dest)) {
        const srcBuf = fs.readFileSync(src);
        const destBuf = fs.readFileSync(dest);
        if (srcBuf.equals(destBuf)) return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`[watch-electron] copied ${filename} → dist/renderer/`);
    } catch (err) {
      console.warn(`[watch-electron] failed to copy ${filename}:`, err.message);
    }
    // scheduleRestart is triggered automatically because dist/renderer/ is in WATCH_DIRS
  });
}

// Pre-seed the content cache from whatever is already in dist/ right now.
// This means any subsequent tsc/esbuild rewrite with identical bytes is
// correctly treated as "no change" rather than "first time seen".
for (const dir of WATCH_DIRS) seedContentCache(dir);

startElectron();
