#!/usr/bin/env node
// Bundles renderer TSX entry points into dist/renderer/ using esbuild.
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    renderer: path.join(__dirname, '..', 'src', 'renderer', 'index.tsx'),
    settings: path.join(__dirname, '..', 'src', 'renderer', 'settings.tsx'),
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
