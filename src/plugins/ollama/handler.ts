// ── Ollama IPC handlers ───────────────────────────────────────────────────────
import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { checkOllama } from '../../services/ollama';
import { getConfigValue, setConfigValue, saveDatabase } from '../../storage/database';
import { safeHandle } from '../ipc-utils';

export function registerHandlers(db: SqlJsDatabase, _getWindow: () => BrowserWindow | null): void {
  safeHandle('ollama:status', async () => {
    try {
      return await checkOllama();
    } catch (err) {
      console.error('[ollama] ollama:status error:', err);
      return { available: false, models: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('ollama:get-selected-model', () => {
    return getConfigValue(db, 'selected_ollama_model');
  });

  safeHandle('ollama:set-selected-model', (_event, modelName: string) => {
    if (typeof modelName !== 'string' || modelName.length === 0) return { ok: false, error: 'Invalid model name' };
    setConfigValue(db, 'selected_ollama_model', modelName);
    saveDatabase();
    return { ok: true };
  });
}
