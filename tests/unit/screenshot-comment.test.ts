import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ESM script without type declarations
import { buildComment, COMMENT_MARKER, isPng, publishImages, validateReport } from '../../scripts/screenshot-comment.mjs';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_URL = 'https://github.com/example-owner/example-repo/actions/runs/123456';

const report = [
  { name: 'settings', status: 'unchanged', diffPixels: 0, totalPixels: 1000 },
  { name: 'agent-sessions', status: 'changed', diffPixels: 250, totalPixels: 10000 },
  { name: 'new-view', status: 'added', diffPixels: 0, totalPixels: 0 },
  { name: 'old-view', status: 'removed', diffPixels: 0, totalPixels: 0 },
];

describe('validateReport', () => {
  it('keeps well-formed entries sorted by name', () => {
    expect(validateReport(report).map((e: { name: string }) => e.name)).toEqual(['agent-sessions', 'new-view', 'old-view', 'settings']);
  });

  it('drops entries with unsafe names, unknown statuses or duplicates', () => {
    const entries = validateReport([
      { name: '../escape', status: 'changed', diffPixels: 1, totalPixels: 1 },
      { name: 'Upper', status: 'changed', diffPixels: 1, totalPixels: 1 },
      { name: 'x"><script>', status: 'changed', diffPixels: 1, totalPixels: 1 },
      { name: 'ok', status: 'exploded', diffPixels: 1, totalPixels: 1 },
      { name: 'ok', status: 'changed', diffPixels: 1, totalPixels: 4 },
      { name: 'ok', status: 'added', diffPixels: 0, totalPixels: 0 },
      null,
      'nope',
    ]);
    expect(entries).toEqual([{ name: 'ok', status: 'changed', diffPixels: 1, totalPixels: 4 }]);
  });

  it('replaces non-integer counts with zero', () => {
    const [entry] = validateReport([{ name: 'a', status: 'changed', diffPixels: '9; rm -rf', totalPixels: -3 }]);
    expect(entry).toEqual({ name: 'a', status: 'changed', diffPixels: 0, totalPixels: 0 });
  });

  it('rejects a report that is not an array', () => {
    expect(() => validateReport({ name: 'a' })).toThrow(/array/);
  });
});

describe('buildComment', () => {
  const imageBase = 'https://raw.githubusercontent.com/example-owner/example-repo/abc123/pr-7/sha/';
  const all = () => true;

  it('renders a Name | Before | After | Diff table for the views that changed', () => {
    const { body, hasChanges } = buildComment({ report: validateReport(report), hasImage: all, imageBase, headSha: HEAD_SHA, runUrl: RUN_URL });
    expect(hasChanges).toBe(true);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('| Name | Before | After | Diff |');
    expect(body).toContain('1 changed, 1 added, 1 removed of 4 views at `0123456`');
    expect(body).toContain('**agent-sessions**<br>2.50% changed');
    expect(body).toContain('<img src="https://raw.githubusercontent.com/example-owner/example-repo/abc123/pr-7/sha/after/agent-sessions.png"');
    expect(body).toContain(`[workflow run](${RUN_URL})`);
    // Unchanged views are collapsed, not shown as rows
    expect(body).not.toMatch(/\| \*\*settings\*\*/);
    expect(body).toContain('<summary>1 unchanged</summary>');
  });

  it('shows a dash where an image is missing (no before for an added view)', () => {
    const { body } = buildComment({
      report: validateReport(report),
      hasImage: (kind: string, name: string) => !(name === 'new-view' && kind !== 'after'),
      imageBase,
      headSha: HEAD_SHA,
    });
    const row = body.split('\n').find((line: string) => line.startsWith('| **new-view**'));
    expect(row).toMatch(/^\| \*\*new-view\*\*<br>added \| — \| <img [^|]+ \| — \|$/);
  });

  it('reports no visual changes when every view is unchanged', () => {
    const { body, hasChanges } = buildComment({
      report: validateReport([report[0]]),
      hasImage: all,
      imageBase,
      headSha: HEAD_SHA,
    });
    expect(hasChanges).toBe(false);
    expect(body).toContain('No visual changes in the 1 rendered views');
    expect(body).not.toContain('| Name |');
  });

  it('does not link a run URL that is not a GitHub Actions run', () => {
    const { body } = buildComment({
      report: validateReport(report),
      hasImage: all,
      imageBase,
      headSha: 'not-a-sha',
      runUrl: 'https://evil.example/actions/runs/1',
    });
    expect(body).not.toContain('evil.example');
    expect(body).toContain('`unknown`');
  });
});

describe('publishImages', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-shot-comment-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function put(kind: string, name: string, content: Buffer) {
    fs.mkdirSync(path.join(dir, 'in', kind), { recursive: true });
    fs.writeFileSync(path.join(dir, 'in', kind, name), content);
  }

  it('copies only real PNGs of views that are not unchanged', async () => {
    put('before', 'agent-sessions.png', PNG_HEADER);
    put('after', 'agent-sessions.png', PNG_HEADER);
    put('diff', 'agent-sessions.png', PNG_HEADER);
    put('after', 'settings.png', PNG_HEADER);
    put('after', 'new-view.png', Buffer.from('<svg onload=alert(1)>'));
    put('after', 'unlisted.png', PNG_HEADER);

    const out = path.join(dir, 'out');
    const published = await publishImages(validateReport(report), path.join(dir, 'in'), out);

    expect([...published].sort()).toEqual(['after/agent-sessions', 'before/agent-sessions', 'diff/agent-sessions']);
    expect(fs.readdirSync(path.join(out, 'after'))).toEqual(['agent-sessions.png']);
  });

  it('isPng rejects missing files, directories and non-PNG content', async () => {
    put('after', 'real.png', PNG_HEADER);
    put('after', 'fake.png', Buffer.from('GIF89a-and-more'));
    expect(await isPng(path.join(dir, 'in', 'after', 'real.png'))).toBe(true);
    expect(await isPng(path.join(dir, 'in', 'after', 'fake.png'))).toBe(false);
    expect(await isPng(path.join(dir, 'in', 'after'))).toBe(false);
    expect(await isPng(path.join(dir, 'missing.png'))).toBe(false);
  });
});
