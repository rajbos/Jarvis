// ── Browser Companion IPC handlers ───────────────────────────────────────────
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../../storage/database';
import {
  startBridgeServer,
  getBridgeStatus,
  sendCommand,
} from './server';

export function registerHandlers(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): void {
  // Start the WebSocket bridge server so the browser extension can connect
  startBridgeServer(getWindow);

  // ── Status ────────────────────────────────────────────────────────────────

  ipcMain.handle('browser:status', () => {
    return getBridgeStatus();
  });

  // ── Skill CRUD ────────────────────────────────────────────────────────────

  ipcMain.handle('browser:list-skills', () => {
    const result = db.exec(
      `SELECT id, name, description, start_url, instructions, extract_selector, created_at, updated_at
       FROM browser_skills ORDER BY name ASC`,
    );
    if (!result.length) return [];
    const [{ columns, values }] = result;
    return values.map((row) =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]])),
    );
  });

  ipcMain.handle(
    'browser:create-skill',
    (
      _event,
      name: string,
      description: string,
      startUrl: string,
      instructions: string,
      extractSelector: string,
    ) => {
      if (typeof name !== 'string' || name.trim().length === 0)
        return { ok: false, error: 'Invalid name' };
      if (typeof startUrl !== 'string' || startUrl.trim().length === 0)
        return { ok: false, error: 'Invalid startUrl' };
      if (typeof instructions !== 'string' || instructions.trim().length === 0)
        return { ok: false, error: 'Invalid instructions' };

      try {
        db.run(
          `INSERT INTO browser_skills (name, description, start_url, instructions, extract_selector)
           VALUES (?, ?, ?, ?, ?)`,
          [
            name.trim(),
            typeof description === 'string' ? description.trim() : '',
            startUrl.trim(),
            instructions.trim(),
            typeof extractSelector === 'string' ? extractSelector.trim() : '',
          ],
        );
        saveDatabase();
        const idResult = db.exec('SELECT last_insert_rowid() AS id');
        const id = idResult[0]?.values[0]?.[0] as number;
        return { ok: true, id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    'browser:update-skill',
    (
      _event,
      id: number,
      name: string,
      description: string,
      startUrl: string,
      instructions: string,
      extractSelector: string,
    ) => {
      if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
      if (typeof name !== 'string' || name.trim().length === 0)
        return { ok: false, error: 'Invalid name' };
      if (typeof startUrl !== 'string' || startUrl.trim().length === 0)
        return { ok: false, error: 'Invalid startUrl' };
      if (typeof instructions !== 'string' || instructions.trim().length === 0)
        return { ok: false, error: 'Invalid instructions' };

      db.run(
        `UPDATE browser_skills
         SET name = ?, description = ?, start_url = ?, instructions = ?,
             extract_selector = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          name.trim(),
          typeof description === 'string' ? description.trim() : '',
          startUrl.trim(),
          instructions.trim(),
          typeof extractSelector === 'string' ? extractSelector.trim() : '',
          id,
        ],
      );
      saveDatabase();
      return { ok: true };
    },
  );

  ipcMain.handle('browser:delete-skill', (_event, id: number) => {
    if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
    db.run('DELETE FROM browser_skills WHERE id = ?', [id]);
    saveDatabase();
    return { ok: true };
  });

  // ── Skill run history ─────────────────────────────────────────────────────

  ipcMain.handle('browser:list-runs', (_event, skillId?: number) => {
    if (skillId !== undefined && typeof skillId !== 'number')
      return [];
    const result = skillId !== undefined
      ? db.exec(
          `SELECT r.id, r.skill_id, s.name AS skill_name, r.status,
                  r.started_at, r.completed_at, r.extracted_data, r.error
           FROM browser_skill_runs r
           JOIN browser_skills s ON s.id = r.skill_id
           WHERE r.skill_id = ?
           ORDER BY r.started_at DESC LIMIT 50`,
          [skillId],
        )
      : db.exec(
          `SELECT r.id, r.skill_id, s.name AS skill_name, r.status,
                  r.started_at, r.completed_at, r.extracted_data, r.error
           FROM browser_skill_runs r
           JOIN browser_skills s ON s.id = r.skill_id
           ORDER BY r.started_at DESC LIMIT 50`,
        );
    if (!result.length) return [];
    const [{ columns, values }] = result;
    return values.map((row) =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]])),
    );
  });

  // ── Run / Test skill ──────────────────────────────────────────────────────

  ipcMain.handle(
    'browser:run-skill',
    async (_event, skillId: number, testMode = false) => {
      if (typeof skillId !== 'number') return { ok: false, error: 'Invalid skillId' };
      if (typeof testMode !== 'boolean') return { ok: false, error: 'Invalid testMode' };

      // Load skill
      const skillResult = db.exec(
        `SELECT id, name, start_url, instructions, extract_selector
         FROM browser_skills WHERE id = ?`,
        [skillId],
      );
      if (!skillResult.length || !skillResult[0].values.length)
        return { ok: false, error: 'Skill not found' };

      const [{ columns, values }] = skillResult;
      const skill = Object.fromEntries(
        columns.map((col, i) => [col, values[0][i]]),
      ) as {
        id: number;
        name: string;
        start_url: string;
        instructions: string;
        extract_selector: string;
      };

      // Check bridge connection
      const status = getBridgeStatus();
      if (!status.running || status.connectedClients === 0) {
        return {
          ok: false,
          error: 'No browser extension connected. Install and enable the Jarvis companion extension.',
        };
      }

      // Create a run record (unless test mode)
      let runId: number | null = null;
      if (!testMode) {
        db.run(
          `INSERT INTO browser_skill_runs (skill_id, status) VALUES (?, 'running')`,
          [skillId],
        );
        saveDatabase();
        const idResult = db.exec('SELECT last_insert_rowid() AS id');
        runId = idResult[0]?.values[0]?.[0] as number;
      }

      try {
        // Step 1: Navigate to the start URL
        const navResponse = await sendCommand({
          type: 'navigate',
          payload: { url: skill.start_url },
        });

        if (!navResponse.ok) {
          throw new Error(`Navigation failed: ${navResponse.error ?? 'unknown'}`);
        }

        // Step 2: Execute the skill instructions in the page
        const evalResponse = await sendCommand({
          type: 'evaluate',
          payload: {
            instructions: skill.instructions,
            testMode,
          },
        });

        if (!evalResponse.ok) {
          throw new Error(`Instruction execution failed: ${evalResponse.error ?? 'unknown'}`);
        }

        // Step 3: Extract data if a selector is configured
        let extractedData: unknown = null;
        if (skill.extract_selector && skill.extract_selector.trim().length > 0) {
          const extractResponse = await sendCommand({
            type: 'extract',
            payload: { selector: skill.extract_selector },
          });
          if (extractResponse.ok) {
            extractedData = extractResponse.data;
          } else {
            console.warn('[BrowserSkill] Extract step warning:', extractResponse.error);
          }
        } else {
          extractedData = evalResponse.data;
        }

        // Persist results
        if (runId !== null) {
          db.run(
            `UPDATE browser_skill_runs
             SET status = 'completed', completed_at = datetime('now'), extracted_data = ?
             WHERE id = ?`,
            [extractedData !== null ? JSON.stringify(extractedData) : null, runId],
          );
          saveDatabase();
        }

        return { ok: true, runId, data: extractedData, testMode };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (runId !== null) {
          db.run(
            `UPDATE browser_skill_runs
             SET status = 'failed', completed_at = datetime('now'), error = ?
             WHERE id = ?`,
            [message, runId],
          );
          saveDatabase();
        }
        return { ok: false, error: message, runId, testMode };
      }
    },
  );

  // ── Direct browser commands (for advanced / manual use) ───────────────────

  ipcMain.handle('browser:navigate', async (_event, url: string) => {
    if (typeof url !== 'string' || url.trim().length === 0)
      return { ok: false, error: 'Invalid url' };
    try {
      const response = await sendCommand({ type: 'navigate', payload: { url: url.trim() } });
      return response;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('browser:list-tabs', async () => {
    try {
      const response = await sendCommand({ type: 'list-tabs', payload: {} });
      return response;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('browser:get-page-content', async (_event, tabId?: number) => {
    try {
      const response = await sendCommand({
        type: 'get-page-content',
        payload: {},
        ...(typeof tabId === 'number' ? { tabId } : {}),
      });
      return response;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
