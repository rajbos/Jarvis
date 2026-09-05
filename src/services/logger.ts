// ── Lightweight leveled logger wrapping console.* ────────────────────────────
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel: LogLevel = 'debug';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];
}

export const logger = {
  error(...args: unknown[]): void {
    if (shouldLog('error')) console.error(...args);
  },
  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(...args);
  },
  info(...args: unknown[]): void {
    if (shouldLog('info')) console.log(...args);
  },
  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.log(...args);
  },
};
