// ── Detached process launching ───────────────────────────────────────────────
// Opens a terminal (Windows Terminal, falling back to the command shell) in a
// folder, optionally running a command there. Shared by the local-repos
// "open terminal" action and the agent session actions.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger';

export function launchDetached(command: string, args: string[], cwd: string, onError: (error: unknown) => void): void {
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('spawn', () => {
      child.unref();
    });
    child.once('error', onError);
  } catch (err) {
    onError(err);
  }
}

/** Resolve `folderPath` and confirm it is an existing directory; null otherwise. */
export function resolveDirectory(folderPath: string): string | null {
  const resolved = path.resolve(folderPath);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Open a terminal in `cwd`, running `command` (with `args`) in it when given.
 * Prefers Windows Terminal; falls back to the classic command prompt, which
 * keeps the window open (`/k`) so the command's output stays readable.
 * Launch failures are reported asynchronously through `onError`.
 */
export function openTerminal(cwd: string, command?: { file: string; args: string[] }, onError?: (error: unknown) => void): void {
  const wtArgs = ['-d', cwd, ...(command ? [command.file, ...command.args] : [])];
  launchDetached('wt.exe', wtArgs, cwd, () => {
    const shell = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    const shellArgs = command ? ['/k', command.file, ...command.args] : ['/k'];
    launchDetached(shell, shellArgs, cwd, (err) => {
      logger.error('[Launch] Could not open a terminal:', err);
      onError?.(err);
    });
  });
}
