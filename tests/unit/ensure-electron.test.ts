import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain ESM script without type declarations
import { ensureElectron, findElectronBinary } from '../../scripts/ensure-electron.mjs';

/** Lay out a fake node_modules/electron whose install.js behaves as requested. */
function fakeElectron(root: string, opts: { binary?: boolean; installer?: 'ok' | 'fail' | 'none' }): string {
  const dir = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'electron', version: '44.2.0' }));
  if (opts.binary) {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'electron.exe'), 'bin');
    fs.writeFileSync(path.join(dir, 'path.txt'), 'electron.exe');
  }
  if (opts.installer === 'ok') {
    fs.writeFileSync(
      path.join(dir, 'install.js'),
      `const fs=require('fs');const p=require('path');
       fs.mkdirSync(p.join(__dirname,'dist'),{recursive:true});
       fs.writeFileSync(p.join(__dirname,'dist','electron.exe'),'downloaded');
       fs.writeFileSync(p.join(__dirname,'path.txt'),'electron.exe');`,
    );
  } else if (opts.installer === 'fail') {
    fs.writeFileSync(path.join(dir, 'install.js'), 'process.exit(3)');
  }
  return dir;
}

describe('ensure-electron', () => {
  let root: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-electron-'));
    logs.length = 0;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is a silent no-op when the binary is present', () => {
    const dir = fakeElectron(root, { binary: true });
    expect(findElectronBinary(root)).toBe(path.join(dir, 'dist', 'electron.exe'));
    expect(ensureElectron({ log, root })).toBe(path.join(dir, 'dist', 'electron.exe'));
    expect(logs).toEqual([]);
  });

  it('runs the installer with a clear message when the binary is missing', () => {
    const dir = fakeElectron(root, { installer: 'ok' });
    expect(findElectronBinary(root)).toBeNull();
    expect(ensureElectron({ log, root })).toBe(path.join(dir, 'dist', 'electron.exe'));
    expect(fs.readFileSync(path.join(dir, 'dist', 'electron.exe'), 'utf8')).toBe('downloaded');
    expect(logs[0]).toContain('Electron 44.2.0 binary is missing');
    expect(logs[1]).toContain('Electron binary ready');
  });

  it('fails loudly when the installer fails', () => {
    fakeElectron(root, { installer: 'fail' });
    expect(() => ensureElectron({ log, root })).toThrow(/Electron download failed \(exit 3\)/);
  });

  it('explains when the electron package itself is absent', () => {
    expect(() => ensureElectron({ log, root })).toThrow(/Run `npm install` first/);
  });
});
