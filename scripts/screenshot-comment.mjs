#!/usr/bin/env node
// Turns the report.json written by screenshot-diff.mjs into the PR comment
// that shows | Name | Before | After | Diff | for every view a PR changed.
// Used by the pr-screenshots-comment workflow in two calls:
//
//   1. Publish: copy the PNGs the comment will show to a folder on the
//      screenshots branch (a PR comment cannot embed workflow artifacts).
//        node scripts/screenshot-comment.mjs --report <report.json> //          --images <artifact dir> --publish <branch folder>
//
//   2. Comment: once that branch is pushed, write the markdown, linking the
//      images by the pushed commit so they keep rendering after cleanup.
//        node scripts/screenshot-comment.mjs --report <report.json> //          --images <branch folder> --image-base <url of that folder> //          --head-sha <sha> [--run-url <url>] --out <comment.md>
//
// --images always holds before/, after/ and diff/ subfolders.
//
// This runs in a privileged workflow on a report that came out of an untrusted
// PR run, so every entry is validated: names must match SAFE_NAME, statuses
// come from a fixed list, counts must be numbers and an image is only used when
// it is a real PNG under MAX_IMAGE_BYTES. Nothing from the report reaches the
// markdown unescaped.
//
// The comment call prints `changes=true|false` to $GITHUB_OUTPUT (when set) so
// the workflow can skip creating a comment on PRs that do not change any view.

import { appendFile, copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMMENT_MARKER = '<!-- jarvis-view-screenshots -->';

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUSES = ['changed', 'added', 'removed', 'unchanged'];
const MAX_ENTRIES = 200;
const IMAGE_WIDTH = 300;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KINDS = ['before', 'after', 'diff'];

/** Drops every entry that does not look exactly like screenshot-diff.mjs output. */
export function validateReport(raw) {
  if (!Array.isArray(raw)) throw new Error('report.json must be an array');
  const seen = new Set();
  const entries = [];
  for (const item of raw.slice(0, MAX_ENTRIES)) {
    if (!item || typeof item !== 'object') continue;
    const { name, status, diffPixels, totalPixels } = item;
    if (typeof name !== 'string' || !SAFE_NAME.test(name) || seen.has(name)) continue;
    if (!STATUSES.includes(status)) continue;
    const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
    seen.add(name);
    entries.push({ name, status, diffPixels: count(diffPixels), totalPixels: count(totalPixels) });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function percent(entry) {
  if (!entry.totalPixels) return '';
  const pct = (entry.diffPixels / entry.totalPixels) * 100;
  return pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`;
}

/**
 * Builds the comment body.
 * @param {object} opts
 * @param {Array} opts.report validated report entries
 * @param {(kind: 'before'|'after'|'diff', name: string) => boolean} opts.hasImage
 * @param {string} opts.imageBase URL prefix that before/, after/ and diff/ live under
 * @param {string} opts.headSha the PR commit the "after" images were rendered from
 * @param {string} [opts.runUrl] link to the workflow run with the full artifact
 */
export function buildComment({ report, hasImage, imageBase, headSha, runUrl }) {
  const base = imageBase.replace(/\/+$/, '');
  const img = (kind, name) =>
    hasImage(kind, name) ? `<img src="${base}/${kind}/${name}.png" width="${IMAGE_WIDTH}" alt="${name} ${kind}">` : '—';

  const visible = report.filter((e) => e.status !== 'unchanged');
  const unchanged = report.filter((e) => e.status === 'unchanged');
  const sha = /^[0-9a-f]{7,40}$/.test(headSha) ? headSha.slice(0, 7) : 'unknown';
  const lines = [COMMENT_MARKER, '### View screenshots', ''];

  if (visible.length === 0) {
    lines.push(`No visual changes in the ${report.length} rendered views at \`${sha}\`.`);
  } else {
    const counts = STATUSES.filter((s) => s !== 'unchanged')
      .map((s) => [s, visible.filter((e) => e.status === s).length])
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);
    lines.push(`${counts.join(', ')} of ${report.length} views at \`${sha}\`, rendered headless from the synthetic view fixtures.`, '');
    lines.push('| Name | Before | After | Diff |', '|------|--------|-------|------|');
    for (const entry of visible) {
      const label = entry.status === 'changed' ? `**${entry.name}**<br>${percent(entry)} changed` : `**${entry.name}**<br>${entry.status}`;
      lines.push(`| ${label} | ${img('before', entry.name)} | ${img('after', entry.name)} | ${img('diff', entry.name)} |`);
    }
  }

  if (unchanged.length > 0) {
    lines.push('', `<details><summary>${unchanged.length} unchanged</summary>`, '', unchanged.map((e) => `\`${e.name}\``).join(', '), '', '</details>');
  }
  lines.push('');
  lines.push(
    runUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(\/attempts\/\d+)?$/.test(runUrl)
      ? `<sub>Magenta pixels in the diff changed. Full-size images are in the [workflow run](${runUrl}) artifact. Run \`npm run screenshots\` to render them locally.</sub>`
      : '<sub>Magenta pixels in the diff changed. Run `npm run screenshots` to render them locally.</sub>',
  );
  return { body: `${lines.join('\n')}\n`, hasChanges: visible.length > 0 };
}

function parseArgs(argv) {
  const keys = ['report', 'images', 'publish', 'image-base', 'head-sha', 'run-url', 'out'];
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!keys.includes(key) || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  const required = ['report', 'images', ...(args.publish ? [] : ['image-base', 'head-sha', 'out'])];
  for (const key of required) {
    if (!args[key]) throw new Error(`missing --${key}`);
  }
  return args;
}

/** True when `file` is a regular file of at most MAX_IMAGE_BYTES that starts with the PNG signature. */
export async function isPng(file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES || info.size < PNG_SIGNATURE.length) return false;
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    await handle.read(head, 0, head.length, 0);
    return head.equals(PNG_SIGNATURE);
  } finally {
    await handle.close();
  }
}

/**
 * Copies the before / after / diff PNGs of every non-unchanged entry from
 * `images` to `publish`. Returns the set of `<kind>/<name>` keys copied.
 */
export async function publishImages(report, images, publish) {
  const published = new Set();
  for (const entry of report) {
    if (entry.status === 'unchanged') continue;
    for (const kind of KINDS) {
      const source = path.join(images, kind, `${entry.name}.png`);
      if (!(await isPng(source))) continue;
      await mkdir(path.join(publish, kind), { recursive: true });
      await copyFile(source, path.join(publish, kind, `${entry.name}.png`));
      published.add(`${kind}/${entry.name}`);
    }
  }
  return published;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = validateReport(JSON.parse(await readFile(args.report, 'utf8')));
    if (args.publish) {
      const published = await publishImages(report, args.images, args.publish);
      console.log(`published ${published.size} images to ${args.publish}`);
    } else {
      const present = new Set();
      for (const entry of report) {
        for (const kind of KINDS) {
          if (await isPng(path.join(args.images, kind, `${entry.name}.png`))) present.add(`${kind}/${entry.name}`);
        }
      }
      const { body, hasChanges } = buildComment({
        report,
        hasImage: (kind, name) => present.has(`${kind}/${name}`),
        imageBase: args['image-base'],
        headSha: args['head-sha'],
        runUrl: args['run-url'],
      });
      await writeFile(args.out, body);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changes=${hasChanges}
`);
      console.log(body);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
