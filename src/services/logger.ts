// ── Lightweight leveled logger wrapping console.* ────────────────────────────
// Optionally mirrors every emitted line to a log file (see enableFileLogging).
// Kept free of Electron imports so the MCP server can use it under plain Node.
import fs from 'fs';
import path from 'path';
import { format } from 'util';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Rotate the log file once it grows past this size (keeps one previous file). */
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

let currentLevel: LogLevel = 'debug';
let logFilePath: string | null = null;
let maxLogBytes = DEFAULT_MAX_LOG_BYTES;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Mirror log output to `<dir>/main.log`. When the file exceeds `maxBytes` it is
 * renamed to `main.old.log` (replacing any previous one) and a new file starts.
 * Returns the log file path.
 */
export function enableFileLogging(dir: string, maxBytes = DEFAULT_MAX_LOG_BYTES): string {
  fs.mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, 'main.log');
  maxLogBytes = maxBytes;
  return logFilePath;
}

export function disableFileLogging(): void {
  logFilePath = null;
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

function writeToFile(level: LogLevel, args: unknown[]): void {
  if (!logFilePath) return;
  try {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${format(...args)}\n`;
    try {
      if (fs.statSync(logFilePath).size + line.length > maxLogBytes) {
        fs.renameSync(logFilePath, path.join(path.dirname(logFilePath), 'main.old.log'));
      }
    } catch {
      // File does not exist yet — appendFileSync below creates it.
    }
    fs.appendFileSync(logFilePath, line);
  } catch {
    // Never let a logging failure (disk full, locked file) break the caller.
  }
}

export const logger = {
  error(...args: unknown[]): void {
    if (!shouldLog('error')) return;
    console.error(...args);
    writeToFile('error', args);
  },
  warn(...args: unknown[]): void {
    if (!shouldLog('warn')) return;
    console.warn(...args);
    writeToFile('warn', args);
  },
  info(...args: unknown[]): void {
    if (!shouldLog('info')) return;
    console.log(...args);
    writeToFile('info', args);
  },
  debug(...args: unknown[]): void {
    if (!shouldLog('debug')) return;
    console.log(...args);
    writeToFile('debug', args);
  },
};

/** How far back from the end of the log file readRecentLogLines looks. */
const LOG_TAIL_BYTES = 256 * 1024;

/**
 * Returns the last `maxLines` lines of the log file, optionally only those
 * containing `filter` (case-sensitive substring). Empty when file logging is
 * off or nothing has been written yet.
 */
export function readRecentLogLines(maxLines: number, filter?: string): string[] {
  if (!logFilePath) return [];
  let text: string;
  try {
    const size = fs.statSync(logFilePath).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const fd = fs.openSync(logFilePath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // A read that starts mid-file almost certainly begins mid-line.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((line) => line !== '' && (!filter || line.includes(filter)));
  return lines.slice(-Math.max(1, maxLines));
}
