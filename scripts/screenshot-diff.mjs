#!/usr/bin/env node
// Compares two folders of view screenshots (`npm run screenshots` output) and
// writes a diff image per changed view plus a report.json, so a PR can show
// before / after / diff for every view the change touched.
//
//   node scripts/screenshot-diff.mjs --before <dir> --after <dir> --out <dir>
//
// Writes <out>/diff/<name>.png for every changed view and <out>/report.json:
//   [{ name, status: 'changed' | 'unchanged' | 'added' | 'removed', diffPixels, totalPixels }]
//
// The pixel compare runs in headless Chromium (Playwright is already a dev
// dependency for the view tests), so no PNG library is needed. A pixel counts
// as changed when any colour channel moves by more than CHANNEL_TOLERANCE,
// which absorbs the ±1 rasterizer noise on anti-aliased corners.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const CHANNEL_TOLERANCE = 8;

/** Screenshot names become file paths and URLs on the PR, so only allow a safe charset. */
export const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function listPngs(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return new Set();
  }
  return new Set(
    files
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.slice(0, -'.png'.length))
      .filter((name) => SAFE_NAME.test(name)),
  );
}

async function launchBrowser() {
  const failures = [];
  for (const channel of [undefined, 'msedge', 'chrome']) {
    try {
      return await chromium.launch(channel ? { channel } : {});
    } catch (err) {
      failures.push(`${channel ?? 'bundled chromium'}: ${err.message.split('\n')[0]}`);
    }
  }
  throw new Error(`No headless browser available (run \`npm run test:views:install\`).\n${failures.join('\n')}`);
}

/**
 * Runs in the page: draws both images on a canvas of the larger size, counts
 * pixels that differ, and returns a diff PNG (the "after" image washed out to
 * light grey with changed pixels in solid magenta) as a data URL.
 */
/* c8 ignore start -- executed inside the browser */
async function compareInPage({ before, after, tolerance }) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to decode'));
      img.src = src;
    });
  const [a, b] = await Promise.all([load(before), load(after)]);
  const width = Math.max(a.naturalWidth, b.naturalWidth);
  const height = Math.max(a.naturalHeight, b.naturalHeight);
  const pixels = (img) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  };
  const pa = pixels(a);
  const pb = pixels(b);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const octx = out.getContext('2d');
  const diff = octx.createImageData(width, height);
  let diffPixels = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const changed =
      Math.abs(pa[i] - pb[i]) > tolerance ||
      Math.abs(pa[i + 1] - pb[i + 1]) > tolerance ||
      Math.abs(pa[i + 2] - pb[i + 2]) > tolerance ||
      Math.abs(pa[i + 3] - pb[i + 3]) > tolerance;
    if (changed) {
      diffPixels++;
      diff.data[i] = 255;
      diff.data[i + 1] = 0;
      diff.data[i + 2] = 255;
      diff.data[i + 3] = 255;
    } else {
      // Unchanged pixels: the "after" luminance washed out towards white, so magenta stands out.
      const grey = Math.round((pb[i] * 0.299 + pb[i + 1] * 0.587 + pb[i + 2] * 0.114) * 0.25 + 255 * 0.75);
      diff.data[i] = grey;
      diff.data[i + 1] = grey;
      diff.data[i + 2] = grey;
      diff.data[i + 3] = 255;
    }
  }
  octx.putImageData(diff, 0, 0);
  return { diffPixels, totalPixels: width * height, diffPng: diffPixels > 0 ? out.toDataURL('image/png') : null };
}
/* c8 ignore stop */

/**
 * Compares every `<name>.png` in `before` with the same name in `after`.
 * Returns the report entries sorted by name and writes diffs to `<out>/diff`.
 */
export async function compareScreenshots({ before, after, out, tolerance = CHANNEL_TOLERANCE }) {
  const beforeNames = await listPngs(before);
  const afterNames = await listPngs(after);
  const names = [...new Set([...beforeNames, ...afterNames])].sort();
  const report = [];
  const diffDir = path.join(out, 'diff');
  await mkdir(diffDir, { recursive: true });

  const pairs = names.filter((n) => beforeNames.has(n) && afterNames.has(n));
  for (const name of names) {
    if (!beforeNames.has(name)) report.push({ name, status: 'added', diffPixels: 0, totalPixels: 0 });
    else if (!afterNames.has(name)) report.push({ name, status: 'removed', diffPixels: 0, totalPixels: 0 });
  }

  if (pairs.length > 0) {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      for (const name of pairs) {
        const dataUrl = async (dir) => `data:image/png;base64,${(await readFile(path.join(dir, `${name}.png`))).toString('base64')}`;
        const result = await page.evaluate(compareInPage, {
          before: await dataUrl(before),
          after: await dataUrl(after),
          tolerance,
        });
        if (result.diffPng) {
          await writeFile(path.join(diffDir, `${name}.png`), Buffer.from(result.diffPng.split(',')[1], 'base64'));
        }
        report.push({
          name,
          status: result.diffPixels > 0 ? 'changed' : 'unchanged',
          diffPixels: result.diffPixels,
          totalPixels: result.totalPixels,
        });
      }
    } finally {
      await browser.close();
    }
  }

  report.sort((x, y) => x.name.localeCompare(y.name));
  await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!['before', 'after', 'out'].includes(key) || argv[i + 1] === undefined) {
      throw new Error('usage: screenshot-diff.mjs --before <dir> --after <dir> --out <dir>');
    }
    args[key] = path.resolve(argv[i + 1]);
  }
  if (!args.before || !args.after || !args.out) {
    throw new Error('usage: screenshot-diff.mjs --before <dir> --after <dir> --out <dir>');
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = await compareScreenshots(parseArgs(process.argv.slice(2)));
    for (const entry of report) {
      const detail = entry.status === 'changed' ? ` (${entry.diffPixels} px)` : '';
      console.log(`${entry.status.padEnd(9)} ${entry.name}${detail}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
