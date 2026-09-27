import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Every esbuild entry point in scripts/build-renderer.mjs must be reachable: some
// src/renderer/*.html has to load its bundle, and some BrowserWindow in src/main has
// to loadFile() that html. knip treats listed entries as intentionally used, so an
// orphaned renderer bundle (like the old standalone chat window) is otherwise missed.

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const MAIN_DIR = path.join(ROOT, 'src', 'main');

function entryPointNames(): string[] {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'build-renderer.mjs'), 'utf8');
  const block = script.match(/entryPoints:\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error('entryPoints not found in build-renderer.mjs');
  return [...block[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
}

function htmlLoadingBundle(name: string): string | undefined {
  return fs
    .readdirSync(RENDERER_DIR)
    .filter((f) => f.endsWith('.html'))
    .find((f) =>
      new RegExp(`<script[^>]*src=["']${name}\\.js["']`).test(
        fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8'),
      ),
    );
}

function loadedHtmlFiles(): Set<string> {
  const loaded = new Set<string>();
  for (const f of fs.readdirSync(MAIN_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(MAIN_DIR, f), 'utf8');
    for (const m of src.matchAll(/loadFile\([^)]*['"]([\w-]+\.html)['"]/g)) loaded.add(m[1]);
  }
  return loaded;
}

describe('renderer entry points', () => {
  const names = entryPointNames();
  const loaded = loadedHtmlFiles();

  it('finds the entry points', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('bundle "%s" is loaded by an html file that a window opens', (name) => {
    const html = htmlLoadingBundle(name);
    expect(html, `no src/renderer/*.html loads ${name}.js`).toBeDefined();
    expect(loaded.has(html!), `${html} is never passed to loadFile() in src/main`).toBe(true);
  });
});
