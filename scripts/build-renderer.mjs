#!/usr/bin/env node
// Bundles renderer TSX entry points into dist/renderer/ using esbuild.
import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/**
 * Shared with the headless view tests (tests/views), which bundle the same
 * entry points into a temp dir instead of dist/renderer.
 * @type {import('esbuild').BuildOptions}
 */
export const options = {
  entryPoints: {
    renderer: path.join(__dirname, '..', 'src', 'renderer', 'index.tsx'),
    settings: path.join(__dirname, '..', 'src', 'renderer', 'settings.tsx'),
    about: path.join(__dirname, '..', 'src', 'renderer', 'about.tsx'),
  },
  outdir: path.join(__dirname, '..', 'dist', 'renderer'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: true,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching renderer files...');
  } else {
    await esbuild.build(options);
  }
}

// Only build when run as a script, not when imported for its options.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
