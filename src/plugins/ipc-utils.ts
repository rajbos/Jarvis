import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { logger } from '../services/logger';

export type IpcErrorResponse = { ok: false; error: string };

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register an IPC handler that resolves failures as a predictable error payload. */
export function safeHandle(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    try {
      const result = handler(event, ...(args as never[]));
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).catch((error: unknown) => {
          logger.error(`[IPC] ${channel} failed:`, error);
          return { ok: false, error: errorMessage(error) } satisfies IpcErrorResponse;
        });
      }
      return result;
    } catch (error) {
      logger.error(`[IPC] ${channel} failed:`, error);
      return { ok: false, error: errorMessage(error) } satisfies IpcErrorResponse;
    }
  });
}

/** The part of a `BrowserWindow` that `safeSend()` touches — kept narrow so tests can pass a plain mock. */
type SendTarget = Pick<BrowserWindow, 'isDestroyed'> & {
  webContents: Pick<WebContents, 'isDestroyed' | 'send'>;
};

/**
 * Push an event to a window's renderer, skipping it when the window (or its
 * webContents) is missing or already destroyed. Async callbacks — discovery,
 * agent streaming, polling timers — often fire after a window has closed, and
 * `webContents.send()` on a destroyed window throws "Object has been destroyed".
 */
export function safeSend(win: SendTarget | null | undefined, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, ...args);
}
