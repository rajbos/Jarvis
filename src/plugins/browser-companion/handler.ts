// ── Browser Companion IPC handlers ───────────────────────────────────────────
import type { BrowserWindow } from 'electron';
import type { Database as SqlJsDatabase } from 'sql.js';
import { safeHandle } from '../ipc-utils';
import { saveDatabase } from '../../storage/database';
import {
  startBridgeServer,
  getBridgeStatus,
  getBridgeToken,
  regenerateBridgeToken,
  sendCommand,
} from './server';
import { runSkill, MIN_SKILL_INTERVAL_MINUTES, MAX_SKILL_INTERVAL_MINUTES } from './skill-runner';

export function registerHandlers(
  db: SqlJsDatabase,
  getWindow: () => BrowserWindow | null,
): void {
  // Start the WebSocket bridge server so the browser extension can connect
  startBridgeServer(getWindow);

  // ── Status ────────────────────────────────────────────────────────────────

  safeHandle('browser:status', () => {
    return getBridgeStatus();
  });

  // ── Token management ──────────────────────────────────────────────────────

  safeHandle('browser:get-token', () => {
    return { token: getBridgeToken() };
  });

  safeHandle('browser:regenerate-token', () => {
    const token = regenerateBridgeToken();
    return { token };
  });

  // ── Skill CRUD ────────────────────────────────────────────────────────────

  safeHandle('browser:list-skills', () => {
    const result = db.exec(
      `SELECT id, name, description, start_url, instructions, extract_selector, interval_minutes, created_at, updated_at
       FROM browser_skills ORDER BY name ASC`,
    );
    if (!result.length) return [];
    const [{ columns, values }] = result;
    return values.map((row) =>
      Object.fromEntries(columns.map((col, i) => [col, row[i]])),
    );
  });

  safeHandle(
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
    },
  );

  safeHandle(
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

  safeHandle('browser:delete-skill', (_event, id: number) => {
    if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
    db.run('DELETE FROM browser_skills WHERE id = ?', [id]);
    saveDatabase();
    return { ok: true };
  });

  // ── Skill run history ─────────────────────────────────────────────────────

  safeHandle('browser:list-runs', (_event, skillId?: number) => {
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

  safeHandle(
    'browser:run-skill',
    async (_event, skillId: number, testMode = false) => {
      if (typeof skillId !== 'number') return { ok: false, error: 'Invalid skillId' };
      if (typeof testMode !== 'boolean') return { ok: false, error: 'Invalid testMode' };
      return runSkill(db, skillId, testMode);
    },
  );

  safeHandle(
    'browser:set-skill-interval',
    (_event, id: number, intervalMinutes: number | null) => {
      if (typeof id !== 'number') return { ok: false, error: 'Invalid id' };
      if (
        intervalMinutes !== null &&
        (typeof intervalMinutes !== 'number' ||
          !Number.isInteger(intervalMinutes) ||
          intervalMinutes < MIN_SKILL_INTERVAL_MINUTES ||
          intervalMinutes > MAX_SKILL_INTERVAL_MINUTES)
      )
        return { ok: false, error: 'Invalid intervalMinutes' };
      db.run('UPDATE browser_skills SET interval_minutes = ? WHERE id = ?', [intervalMinutes, id]);
      saveDatabase();
      return { ok: true };
    },
  );

  // ── Direct browser commands (for advanced / manual use) ───────────────────

  safeHandle('browser:focus-window', async (_event, tabId?: number) => {
    const response = await sendCommand({
      type: 'focus-window',
      payload: {},
      ...(typeof tabId === 'number' ? { tabId } : {}),
    });
    return response;
  });
}
