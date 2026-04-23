#!/usr/bin/env node
// Copies the browser-extension source files into dist/browser-extension/.
// Pass --watch to rebuild automatically when source files change.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(__dirname, '..', 'src', 'browser-extension');
const DEST = path.join(__dirname, '..', 'dist', 'browser-extension');
const WATCH = process.argv.includes('--watch');

function copyAll() {
  fs.mkdirSync(DEST, { recursive: true });
  for (const file of fs.readdirSync(SRC)) {
    fs.copyFileSync(path.join(SRC, file), path.join(DEST, file));
    console.log(`[build-extension] ${file} → dist/browser-extension/${file}`);
  }
}

copyAll();
console.log('[build-extension] done');

if (WATCH) {
  console.log('[build-extension] watching for changes...');
  fs.watch(SRC, { recursive: false }, (_event, filename) => {
    if (!filename) return;
    const src  = path.join(SRC, filename);
    const dest = path.join(DEST, filename);
    try {
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(DEST, { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`[build-extension] updated ${filename}`);
    } catch (err) {
      console.warn(`[build-extension] failed to copy ${filename}:`, err.message);
    }
  });
}
