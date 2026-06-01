#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const outDir = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.html')) {
    fs.cpSync(path.join(srcDir, file), path.join(outDir, file));
    copied++;
  }
}

console.log(`[copy-static] Copied ${copied} HTML file(s) to ${path.relative(path.join(__dirname, '..'), outDir)}`);
