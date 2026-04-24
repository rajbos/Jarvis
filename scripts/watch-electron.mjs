#!/usr/bin/env node
// Spawns Electron, restarts it when dist/ changes, and exits when the user quits the app.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronPath = String(require('electron'));
const ROOT = path.join(__dirname, '..');
const DIST_RENDERER = path.join(ROOT, 'dist', 'renderer');
const TSC_BUILD_INFO = path.join(ROOT, 'tsconfig.tsbuildinfo');
const BROWSER_BRIDGE_PORT = 35789;

let electronProcess = null;
let intentionalRestart = false;
let debounceTimer = null;
let startInProgress = false;
// Ignore file-change events for this many ms after (re)starting electron.
// Covers tsc --watch and esbuild --watch doing their initial output writes.
const STARTUP_GRACE_MS = 4000;
let graceUntil = 0;

// Track last-known content of watched renderer files so we can ignore spurious
// write events from esbuild initial builds that produce identical output.
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

function portIsFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function waitForPortToFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function startElectron() {
  if (startInProgress) return;
  startInProgress = true;
  intentionalRestart = false;
  graceUntil = Date.now() + STARTUP_GRACE_MS;
  const bridgePortFreed = await waitForPortToFree(BROWSER_BRIDGE_PORT, 5000);
  if (!bridgePortFreed) {
    console.warn('[watch-electron] browser bridge port still busy after restart wait; starting anyway...');
  }
  console.log('[watch-electron] starting electron...');
  electronProcess = spawn(electronPath, ['dist/main/index.js'], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  electronProcess.on('exit', () => {
    electronProcess = null;
    startInProgress = false;
    if (intentionalRestart) {
      void startElectron(); // restarted due to file change — respawn
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
  }, 800); // batch rapid rebuild outputs before restarting
}

const SRC_RENDERER = path.join(ROOT, 'src', 'renderer');

preloadDir(DIST_RENDERER);

// Watch the renderer bundle directly. esbuild writes coherent output here, so
// restarting from these files is safe.
if (fs.existsSync(DIST_RENDERER)) {
  fs.watch(DIST_RENDERER, { recursive: true }, (_event, filename) => {
    if (!filename || !/\.(js|html|css)$/.test(filename)) return;
    const fullPath = path.join(DIST_RENDERER, filename);
    try {
      if (!fs.existsSync(fullPath)) {
        if (knownContents.has(fullPath)) { knownContents.delete(fullPath); scheduleRestart(); }
        return;
      }
      const newBuf = fs.readFileSync(fullPath);
      const prevBuf = knownContents.get(fullPath);
      if (prevBuf && prevBuf.equals(newBuf)) return;
      knownContents.set(fullPath, newBuf);
    } catch {
      // Can't read file — fall through and restart to be safe
    }
    scheduleRestart();
  });
}

// Watch the TypeScript incremental build-info marker instead of raw dist/main
// files. This fires when tsc finishes a coherent output batch, avoiding restarts
// against half-written JS that can produce undefined imports at runtime.
if (fs.existsSync(TSC_BUILD_INFO)) {
  fs.watchFile(TSC_BUILD_INFO, { interval: 250 }, (curr, prev) => {
    if (curr.mtimeMs === 0 || curr.mtimeMs === prev.mtimeMs) return;
    scheduleRestart();
  });
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

// Kill the Electron child when this watcher process is shut down (Ctrl+C,
// SIGTERM from concurrently, etc.).  Without this, orphaned Electron windows
// accumulate every time `npm run dev` is re-invoked.
function killChild() {
  if (electronProcess) {
    try { electronProcess.kill(); } catch { /* already dead */ }
  }
  process.exit(0);
}
process.on('SIGINT', killChild);
process.on('SIGTERM', killChild);

void startElectron();
