#!/usr/bin/env node
// Spawns Electron, restarts it when dist/ changes, and exits when the user quits the app.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electronPath = String(require('electron'));
const ROOT = path.join(__dirname, '..');
const WATCH_DIRS = [
  path.join(ROOT, 'dist', 'main'),
  path.join(ROOT, 'dist', 'renderer'),
];

let electronProcess = null;
let intentionalRestart = false;
let debounceTimer = null;

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

for (const dir of WATCH_DIRS) {
  if (fs.existsSync(dir)) {
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && /\.(js|html|css)$/.test(filename)) {
        scheduleRestart();
      }
    });
  }
}

startElectron();
