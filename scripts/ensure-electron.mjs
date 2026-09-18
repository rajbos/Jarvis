#!/usr/bin/env node
// Makes sure the Electron binary is actually present before `npm run dev` /
// `npm start` try to launch it.
//
// `npm install` normally downloads the binary in Electron's postinstall, but
// that step fails quietly when it runs without network access or when npm
// skips install scripts. Without this check, `require('electron')` falls back
// to a silent synchronous download that looks like a hang. Here we detect the
// missing binary, say so, and run the installer with visible output.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(__dirname, '..');

function electronDir(root) {
  return path.join(root, 'node_modules', 'electron');
}

/** Absolute path of the Electron executable if it is installed, else null. */
export function findElectronBinary(root = DEFAULT_ROOT) {
  const dir = electronDir(root);
  const pathFile = path.join(dir, 'path.txt');
  if (!fs.existsSync(pathFile)) return null;
  const relative = fs.readFileSync(pathFile, 'utf8').trim();
  const full = path.join(dir, 'dist', relative);
  return fs.existsSync(full) ? full : null;
}

/**
 * Ensure the binary exists, downloading it with visible progress when missing.
 * Returns the executable path; throws when it cannot be installed.
 */
export function ensureElectron({ log = console.log, root = DEFAULT_ROOT } = {}) {
  const existing = findElectronBinary(root);
  if (existing) return existing;

  const dir = electronDir(root);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error('The electron package is not installed. Run `npm install` first.');
  }
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  log(`[ensure-electron] Electron ${version} binary is missing (its postinstall did not complete). Downloading now…`);

  const result = spawnSync(process.execPath, [path.join(dir, 'install.js')], {
    stdio: 'inherit',
    cwd: dir,
    env: { ...process.env, ELECTRON_GET_USE_PROXY: process.env.ELECTRON_GET_USE_PROXY ?? 'true' },
  });
  if (result.status !== 0) {
    throw new Error(
      `Electron download failed (exit ${result.status ?? 'signal'}). ` +
      'Check your network/proxy, or copy node_modules/electron/dist from another checkout of the same Electron version.',
    );
  }
  const installed = findElectronBinary(root);
  if (!installed) throw new Error('Electron installer finished but no binary was found in node_modules/electron/dist.');
  log(`[ensure-electron] Electron binary ready: ${installed}`);
  return installed;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const bin = ensureElectron();
    if (process.argv.includes('--verbose')) console.log(`[ensure-electron] ${bin}`);
  } catch (err) {
    console.error(`[ensure-electron] ${err.message}`);
    process.exit(1);
  }
}
