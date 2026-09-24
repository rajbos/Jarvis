import { ipcMain } from 'electron';
import { logger } from '../services/logger';

export type IpcErrorResponse = { ok: false; error: string };

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register an IPC handler that resolves failures as a predictable error payload. */
export function safeHandle(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    try {
      const result = handler(event, ...args);
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
