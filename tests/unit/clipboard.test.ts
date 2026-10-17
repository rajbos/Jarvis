import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { copyToClipboard } from '../../src/plugins/clipboard';

function stubJarvis(clipboardWriteText: (text: string) => Promise<{ ok: boolean; error?: string }>) {
  vi.stubGlobal('window', { jarvis: { clipboardWriteText: vi.fn(clipboardWriteText) } });
  return (globalThis as unknown as { window: { jarvis: { clipboardWriteText: ReturnType<typeof vi.fn> } } }).window.jarvis.clipboardWriteText;
}

describe('copyToClipboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('copies through the main process and resolves true on success', async () => {
    const write = stubJarvis(async () => ({ ok: true }));
    await expect(copyToClipboard('pairing-token')).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith('pairing-token');
  });

  it('resolves false when the main process reports an error', async () => {
    stubJarvis(async () => ({ ok: false, error: 'clipboard busy' }));
    await expect(copyToClipboard('x')).resolves.toBe(false);
  });

  it('resolves false instead of throwing when the IPC call rejects', async () => {
    stubJarvis(async () => { throw new Error('ipc gone'); });
    await expect(copyToClipboard('x')).resolves.toBe(false);
  });
});

describe('renderer clipboard usage', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it('never calls navigator.clipboard (the permission handler denies it)', () => {
    const root = resolve(__dirname, '../../src');
    const offenders = [...sourceFiles(join(root, 'renderer')), ...sourceFiles(join(root, 'plugins'))]
      .filter((f) => /navigator\.clipboard\.\w+\(/.test(readFileSync(f, 'utf8')));
    expect(offenders, 'use copyToClipboard() from src/plugins/clipboard instead').toEqual([]);
  });
});
