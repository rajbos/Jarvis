/**
 * scripts/screenshot-diff.mjs: the pixel compare the PR screenshot workflow uses
 * to build its before / after / diff table. Needs a headless browser, so it
 * lives with the view tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { compareScreenshots } from '../../scripts/screenshot-diff.mjs';

let browser: Browser;
let dir: string;

/** Renders a solid-colour block (optionally with a smaller square on top) to a PNG. */
async function shot(file: string, { square, size = { width: 120, height: 80 } }: { square?: string; size?: { width: number; height: number } } = {}) {
  const page = await browser.newPage({ viewport: size });
  await page.setContent(
    `<body style="margin:0;background:#202020">${square ? `<div style="width:20px;height:20px;background:${square}"></div>` : ''}</body>`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  await page.close();
}

beforeAll(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), 'jarvis-shot-diff-'));
  const before = path.join(dir, 'before');
  const after = path.join(dir, 'after');
  await shot(path.join(before, 'same.png'));
  await shot(path.join(after, 'same.png'));
  await shot(path.join(before, 'moved.png'));
  await shot(path.join(after, 'moved.png'), { square: '#ff0000' });
  await shot(path.join(before, 'resized.png'));
  await shot(path.join(after, 'resized.png'), { size: { width: 120, height: 100 } });
  await shot(path.join(before, 'gone.png'));
  await shot(path.join(after, 'fresh.png'));
  await shot(path.join(after, 'Not-Safe.png'));
});

afterAll(async () => {
  await browser?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('compareScreenshots', () => {
  it('classifies every view and writes diffs only for changed ones', async () => {
    const out = path.join(dir, 'out');
    const report = await compareScreenshots({ before: path.join(dir, 'before'), after: path.join(dir, 'after'), out });

    expect(report).toEqual([
      { name: 'fresh', status: 'added', diffPixels: 0, totalPixels: 0 },
      { name: 'gone', status: 'removed', diffPixels: 0, totalPixels: 0 },
      { name: 'moved', status: 'changed', diffPixels: 400, totalPixels: 120 * 80 },
      // The extra 20 rows are transparent in the padded "before" image
      { name: 'resized', status: 'changed', diffPixels: 120 * 20, totalPixels: 120 * 100 },
      { name: 'same', status: 'unchanged', diffPixels: 0, totalPixels: 120 * 80 },
    ]);
    expect((await readdir(path.join(out, 'diff'))).sort()).toEqual(['moved.png', 'resized.png']);
    expect(JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'))).toEqual(report);
  });

  it('writes a PNG diff image', async () => {
    const png = await readFile(path.join(dir, 'out', 'diff', 'moved.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('treats a missing before folder as every view added', async () => {
    const report = await compareScreenshots({ before: path.join(dir, 'nope'), after: path.join(dir, 'after'), out: path.join(dir, 'out2') });
    expect(report.every((e: { status: string }) => e.status === 'added')).toBe(true);
  });
});
