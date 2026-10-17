// ── Browser skill runner ──────────────────────────────────────────────────────
// Runs one browser skill (manually from the panel or unattended from the
// background scheduler) and decides which scheduled skills are due.
import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../../storage/database';
import { logger } from '../../services/logger';
import { getBridgeStatus, sendCommand } from './server';
import {
  createTabSession,
  navigatePayload,
  recordNavigationTab,
  tabTarget,
  closeSessionTab,
} from './tab-session';

/** Bounds for a skill's unattended run interval (1 minute to 30 days). */
export const MIN_SKILL_INTERVAL_MINUTES = 1;
export const MAX_SKILL_INTERVAL_MINUTES = 30 * 24 * 60;

export interface RunSkillResult {
  ok: boolean;
  runId?: number | null;
  data?: unknown;
  error?: string;
  testMode?: boolean;
}

function findFailedStep(data: unknown): { step: string; error?: string } | null {
  const steps = (data as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return null;
  for (const s of steps) {
    if (s && typeof s === 'object' && (s as { ok?: unknown }).ok === false) {
      const { step, error } = s as { step?: unknown; error?: unknown };
      return { step: String(step ?? ''), error: typeof error === 'string' ? error : undefined };
    }
  }
  return null;
}

/** Skill ids with a run in flight, so a skill never runs twice at the same time. */
const runningSkillIds = new Set<number>();

export function isSkillRunning(skillId: number): boolean {
  return runningSkillIds.has(skillId);
}

/** Runs a skill in a dedicated background tab and records the run (unless testMode). */
export async function runSkill(
  db: SqlJsDatabase,
  skillId: number,
  testMode = false,
): Promise<RunSkillResult> {
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

  const status = getBridgeStatus();
  if (!status.running || status.connectedClients === 0) {
    return {
      ok: false,
      error: 'No browser extension connected. Install and enable the Jarvis companion extension.',
    };
  }

  if (runningSkillIds.has(skillId)) {
    return { ok: false, error: 'This skill is already running' };
  }
  runningSkillIds.add(skillId);

  try {
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

    // Run in a dedicated background tab (reusing an idle one Jarvis opened
    // earlier) instead of navigating the tab the user is looking at.
    const session = createTabSession();

    try {
      // Step 1: Navigate to the start URL
      const navResponse = await sendCommand({
        type: 'navigate',
        payload: { url: skill.start_url, ...navigatePayload(session) },
      });

      if (!navResponse.ok) {
        throw new Error(`Navigation failed: ${navResponse.error ?? 'unknown'}`);
      }
      recordNavigationTab(session, navResponse.data);

      // Step 2: Execute the skill instructions in the page
      const evalResponse = await sendCommand({
        type: 'evaluate',
        ...tabTarget(session),
        payload: {
          instructions: skill.instructions,
          testMode,
        },
      });

      if (!evalResponse.ok) {
        throw new Error(`Instruction execution failed: ${evalResponse.error ?? 'unknown'}`);
      }

      // A successful executeScript call only means the script ran; individual
      // steps (missing selector, unknown instruction) report failure in-band.
      const failedStep = findFailedStep(evalResponse.data);
      if (failedStep) {
        throw new Error(`Step failed: ${failedStep.step} (${failedStep.error ?? 'unknown error'})`);
      }

      // Step 3: Extract data if a selector is configured
      let extractedData: unknown = null;
      if (skill.extract_selector && skill.extract_selector.trim().length > 0) {
        const extractResponse = await sendCommand({
          type: 'extract',
          ...tabTarget(session),
          payload: { selector: skill.extract_selector },
        });
        if (extractResponse.ok) {
          extractedData = extractResponse.data;
        } else {
          logger.warn('[BrowserSkill] Extract step warning:', extractResponse.error);
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
    } finally {
      await closeSessionTab(session);
    }
  } finally {
    runningSkillIds.delete(skillId);
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────────

export interface ScheduledSkillRow {
  id: number;
  intervalMinutes: number;
  /** started_at of the most recent recorded run (SQLite UTC timestamp), or null if never run. */
  lastRunAt: string | null;
}

/** Parses a SQLite `YYYY-MM-DD HH:MM:SS` UTC timestamp. */
function parseSqliteUtc(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

/** Ids of scheduled skills whose interval has elapsed since their last run. */
export function selectDueSkills(rows: ScheduledSkillRow[], nowMs: number): number[] {
  return rows
    .filter((row) => {
      if (!(row.intervalMinutes > 0)) return false;
      if (isSkillRunning(row.id)) return false;
      if (row.lastRunAt === null) return true;
      const last = parseSqliteUtc(row.lastRunAt);
      if (Number.isNaN(last)) return true;
      return nowMs - last >= row.intervalMinutes * 60_000;
    })
    .map((row) => row.id);
}

function loadScheduledSkills(db: SqlJsDatabase): ScheduledSkillRow[] {
  const result = db.exec(
    `SELECT s.id, s.interval_minutes,
            (SELECT MAX(r.started_at) FROM browser_skill_runs r WHERE r.skill_id = s.id)
     FROM browser_skills s
     WHERE s.interval_minutes IS NOT NULL AND s.interval_minutes > 0`,
  );
  if (!result.length) return [];
  return result[0].values.map((v) => ({
    id: v[0] as number,
    intervalMinutes: v[1] as number,
    lastRunAt: (v[2] as string | null) ?? null,
  }));
}

/**
 * Background-task entry point: runs every scheduled skill that is due, one at
 * a time. Does nothing when no browser extension is connected.
 */
export async function runDueSkills(
  db: SqlJsDatabase,
  nowMs: number = Date.now(),
): Promise<{ skipped?: boolean; reason?: string; ran: number; failed: number }> {
  const status = getBridgeStatus();
  if (!status.running || status.connectedClients === 0) {
    return { skipped: true, reason: 'No browser extension connected', ran: 0, failed: 0 };
  }
  const due = selectDueSkills(loadScheduledSkills(db), nowMs);
  let ran = 0;
  let failed = 0;
  for (const id of due) {
    const result = await runSkill(db, id, false);
    if (result.ok) ran++;
    else {
      failed++;
      logger.warn(`[BrowserSkill] Scheduled run of skill ${id} failed:`, result.error);
    }
  }
  return { ran, failed };
}
