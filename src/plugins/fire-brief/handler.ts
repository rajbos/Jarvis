import type { Database as SqlJsDatabase } from 'sql.js';
import type { BrowserWindow } from 'electron';
import { safeHandle, safeSend } from '../ipc-utils';
import { getConfigValue, saveDatabase } from '../../storage/database';
import { checkOllama, streamChat } from '../../services/ollama';
import { acknowledgeBrief, addProseSummary, buildFireBrief, collectBriefInputs, type FireBrief, type SummarizeFn } from '../../services/fire-brief';
import { logger } from '../../services/logger';
import { getLatestActiveSessionsSnapshot } from '../active-sessions/handler';

/** Build the structured brief from the database and the latest agent session snapshot. */
export function generateFireBrief(db: SqlJsDatabase): FireBrief {
  return buildFireBrief(collectBriefInputs(db, getLatestActiveSessionsSnapshot()));
}

/** Ollama-backed summarizer, or null when Ollama is stopped or no model is selected. */
async function resolveSummarizer(db: SqlJsDatabase): Promise<SummarizeFn | null> {
  const model = getConfigValue(db, 'selected_ollama_model');
  if (!model) return null;
  const status = await checkOllama();
  if (!status.available) return null;
  return async (prompt) => {
    let text = '';
    await streamChat(model, [{ role: 'user', content: prompt }], (t) => { text += t; });
    return text;
  };
}

/**
 * Push the brief to the renderer: the structured list first (no waiting on
 * Ollama), then a second push with prose if Ollama produced a summary.
 * `show` makes the renderer switch to the dashboard.
 */
export async function pushFireBrief(db: SqlJsDatabase, getWindow: () => BrowserWindow | null, show: boolean): Promise<void> {
  const send = (brief: FireBrief, showNow: boolean): void => {
    const win = getWindow();
    safeSend(win, 'fire-brief:updated', { brief, show: showNow });
  };
  try {
    const brief = generateFireBrief(db);
    send(brief, show);
    if (brief.allClear) return;
    const withProse = await addProseSummary(brief, await resolveSummarizer(db).catch(() => null));
    if (withProse.summary) send(withProse, false);
  } catch (err) {
    logger.warn('[FireBrief] Could not push brief:', err instanceof Error ? err.message : String(err));
  }
}

export function registerHandlers(db: SqlJsDatabase): void {
  safeHandle('fire-brief:get', () => generateFireBrief(db));
  safeHandle('fire-brief:refresh', async (): Promise<FireBrief> => {
    const brief = generateFireBrief(db);
    return addProseSummary(brief, await resolveSummarizer(db).catch(() => null));
  });
  safeHandle('fire-brief:acknowledge', (): FireBrief => {
    acknowledgeBrief(db);
    saveDatabase();
    return generateFireBrief(db);
  });
}
