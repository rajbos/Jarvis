// ── Ollama IPC handlers ───────────────────────────────────────────────────────
import { ipcMain } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { checkOllama } from '../../services/ollama';
import { getConfigValue, setConfigValue, saveDatabase } from '../../storage/database';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('ollama:status', async () => {
    return checkOllama();
  });

  ipcMain.handle('ollama:list-models', async () => {
    const result = await checkOllama();
    return { available: result.available, models: result.models, error: result.error };
  });

  ipcMain.handle('ollama:get-selected-model', () => {
    return getConfigValue(db, 'selected_ollama_model');
  });

  ipcMain.handle('ollama:set-selected-model', (_event, modelName: string) => {
    if (typeof modelName !== 'string' || modelName.length === 0) return { ok: false, error: 'Invalid model name' };
    setConfigValue(db, 'selected_ollama_model', modelName);
    saveDatabase();
    return { ok: true };
  });
}
