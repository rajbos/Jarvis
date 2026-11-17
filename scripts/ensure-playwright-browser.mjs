#!/usr/bin/env node
// Makes sure the headless Chromium build that the installed Playwright version
// expects is present before `npm run test:views` / `npm run screenshots` run.
//
// Every Playwright release pins its own Chromium build, and the builds live in
// a per-user cache (%LOCALAPPDATA%\ms-playwright), not in node_modules. So a
// Playwright bump, or `npm ci` in a fresh worktree, leaves the cache one build
// behind and `chromium.launch()` fails with "Executable doesn't exist". Here we
// try a launch, and download the matching build when that fails.
//
// A failed download is a warning, not an error: the view harness falls back to
// a locally installed Edge or Chrome.

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

/** True when Playwright's own Chromium launches. */
export async function bundledChromiumWorks() {
  try {
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

/** Returns true when the bundled Chromium is usable after this call. */
export async function ensurePlaywrightBrowser({ log = console.log } = {}) {
  if (process.env.JARVIS_VIEW_BROWSER_CHANNEL) return true; // a specific local browser was asked for
  if (await bundledChromiumWorks()) return true;

  const pkgPath = require.resolve('playwright/package.json');
  const { version } = require(pkgPath);
  log(`[ensure-playwright-browser] Chromium for Playwright ${version} is missing. Downloading now…`);
  const result = spawnSync(process.execPath, [path.join(path.dirname(pkgPath), 'cli.js'), 'install', 'chromium'], {
    stdio: 'inherit',
  });
  if (result.status === 0 && (await bundledChromiumWorks())) {
    log('[ensure-playwright-browser] Chromium ready.');
    return true;
  }
  log(
    `[ensure-playwright-browser] Could not install Chromium (exit ${result.status ?? 'signal'}). ` +
      'The view tests will fall back to a local Edge or Chrome; run `npm run test:views:install` once you are online.',
  );
  return false;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await ensurePlaywrightBrowser();
