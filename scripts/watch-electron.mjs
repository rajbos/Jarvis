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

// Track last-known content of watched dist/ files so we can ignore spurious
// write events from tsc/esbuild initial builds that produce identical output.
const knownContents = new Map();

function preloadDir(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        preloadDir(fullPath);
      } else if (/\.(js|html|css)$/.test(entry.name)) {
        try { knownContents.set(fullPath, fs.readFileSync(fullPath)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function startElectron() {
  intentionalRestart = false;
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

for (const dir of WATCH_DIRS) preloadDir(dir);

for (const dir of WATCH_DIRS) {
  if (fs.existsSync(dir)) {
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || !/\.(js|html|css)$/.test(filename)) return;
      const fullPath = path.join(dir, filename);
      try {
        if (!fs.existsSync(fullPath)) {
          // File deleted — only restart if we knew about it
          if (knownContents.has(fullPath)) { knownContents.delete(fullPath); scheduleRestart(); }
          return;
        }
        const newBuf = fs.readFileSync(fullPath);
        const prevBuf = knownContents.get(fullPath);
        if (prevBuf && prevBuf.equals(newBuf)) return; // content unchanged, ignore
        knownContents.set(fullPath, newBuf);
      } catch {
        // Can't read file — fall through and restart to be safe
      }
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

startElectron();
