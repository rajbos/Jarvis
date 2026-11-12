import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { trimCrashDumps, detectNewCrashDumps, buildCrashDiagnostic, listCrashDumpFiles } from '../../src/main/crash-dumps';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-crash-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function seed(rel: string, mtimeSec: number): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  fs.utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe('trimCrashDumps', () => {
  it('keeps only the newest N dumps and removes their meta files', () => {
    for (let i = 1; i <= 7; i++) { seed(`reports/d${i}.dmp`, 1000 + i); seed(`reports/d${i}.meta`, 1000 + i); }
    expect(trimCrashDumps(dir, 3)).toBe(4);
    const left = listCrashDumpFiles(dir).map((f) => path.basename(f.path)).sort();
    expect(left).toEqual(['d5.dmp', 'd5.meta', 'd6.dmp', 'd6.meta', 'd7.dmp', 'd7.meta']);
  });
  it('is a no-op for a missing directory', () => {
    expect(trimCrashDumps(path.join(dir, 'nope'), 3)).toBe(0);
  });
});

describe('detectNewCrashDumps', () => {
  it('baselines on first run, then reports only newer dumps', () => {
    const marker = path.join(dir, 'state', 'marker.json');
    seed('reports/a.dmp', 1000);
    expect(detectNewCrashDumps(dir, marker)).toEqual([]);
    expect(detectNewCrashDumps(dir, marker)).toEqual([]);
    seed('reports/b.dmp', 2000);
    const fresh = detectNewCrashDumps(dir, marker);
    expect(fresh.map((f) => path.basename(f.path))).toEqual(['b.dmp']);
    expect(detectNewCrashDumps(dir, marker)).toEqual([]);
  });
});

describe('buildCrashDiagnostic', () => {
  it('describes the dumps', () => {
    const r = buildCrashDiagnostic([{ path: 'a.dmp', mtimeMs: 1000 }], 'C:\\dumps', new Date(5000));
    expect(r.source).toBe('crash');
    expect(r.facts[0].value).toBe('1');
  });
});
