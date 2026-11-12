// Housekeeping for Electron's local native crash dumps: caps how many are kept
// and detects dumps written since the previous run. Free of Electron imports so
// it can be unit tested; the main process passes in the directories.
import fs from 'fs';
import path from 'path';
import type { DiagnosticReport } from '../types/ipc-payloads';

/** Newest dump files kept; older ones are deleted at startup. */
export const MAX_CRASH_DUMPS = 10;
const DUMP_EXTENSIONS = new Set(['.dmp', '.meta']);

export interface DumpFile {
  path: string;
  mtimeMs: number;
}

/** Lists crash dump files (.dmp plus companion .meta) anywhere under dir. Missing dir yields []. */
export function listCrashDumpFiles(dir: string): DumpFile[] {
  const out: DumpFile[] = [];
  const walk = (current: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (DUMP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** Deletes all but the newest `keep` .dmp files (and their .meta companions). Returns deleted dump count. */
export function trimCrashDumps(dir: string, keep: number = MAX_CRASH_DUMPS): number {
  const files = listCrashDumpFiles(dir);
  const dumps = files.filter((f) => f.path.toLowerCase().endsWith('.dmp')).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const doomed = dumps.slice(keep);
  for (const d of doomed) {
    for (const p of [d.path, d.path.replace(/\.dmp$/i, '.meta')]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return doomed.length;
}

/**
 * Returns dump files newer than the marker stored in markerPath, then advances the
 * marker. The first run (no marker) only records the baseline and reports nothing.
 */
export function detectNewCrashDumps(dir: string, markerPath: string): DumpFile[] {
  const dumps = listCrashDumpFiles(dir).filter((f) => f.path.toLowerCase().endsWith('.dmp'));
  const latest = dumps.reduce((max, f) => Math.max(max, f.mtimeMs), 0);
  let lastSeen: number | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { lastSeenMtimeMs?: unknown };
    if (typeof parsed.lastSeenMtimeMs === 'number') lastSeen = parsed.lastSeenMtimeMs;
  } catch {
    /* no marker yet */
  }
  const fresh = lastSeen === null ? [] : dumps.filter((f) => f.mtimeMs > lastSeen);
  if (lastSeen === null || latest > lastSeen) {
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ lastSeenMtimeMs: Math.max(latest, lastSeen ?? 0) }));
    } catch {
      /* best effort */
    }
  }
  return fresh;
}

export function buildCrashDiagnostic(dumps: DumpFile[], dir: string, now: Date = new Date()): DiagnosticReport {
  const newest = Math.max(...dumps.map((d) => d.mtimeMs));
  return {
    id: `crash-${now.getTime()}`,
    source: 'crash',
    title: dumps.length === 1 ? 'Jarvis crashed since the last run' : `Jarvis crashed ${dumps.length} times since the last run`,
    summary: 'A native crash dump was written after the previous check. Use "Open Crash Dumps Folder" in the app menu to find it and attach it to a bug report.',
    facts: [
      { label: 'New crash dumps', value: String(dumps.length) },
      { label: 'Most recent', value: new Date(newest).toISOString() },
      { label: 'Folder', value: dir },
    ],
    logFilter: '[Crash]',
    occurredAt: now.toISOString(),
  };
}
