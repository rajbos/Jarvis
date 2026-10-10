import { shell } from 'electron';
import { safeHandle } from '../plugins/ipc-utils';
import { getLogFilePath, readRecentLogLines } from '../services/logger';

const MAX_TAIL_LINES = 200;

/** IPC used by diagnostic cards in the chat panel to show and open the app log. */
export function registerDiagnosticsIpcHandlers(): void {
  safeHandle('diagnostics:log-tail', (_event, filter?: unknown, maxLines?: unknown): string[] => {
    const lines = typeof maxLines === 'number' && maxLines > 0 ? Math.min(maxLines, MAX_TAIL_LINES) : 40;
    return readRecentLogLines(lines, typeof filter === 'string' && filter !== '' ? filter : undefined);
  });

  safeHandle('diagnostics:open-log', async (): Promise<{ ok: boolean; error?: string }> => {
    const file = getLogFilePath();
    if (!file) return { ok: false, error: 'File logging is not enabled' };
    const error = await shell.openPath(file);
    return error ? { ok: false, error } : { ok: true };
  });
}
