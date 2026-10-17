/// <reference path="../../src/types/sql.js.d.ts" />
/**
 * Browser skill scheduling — which scheduled skills are due, and the
 * background-task entry point (bridge disconnected, already running, recording).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';

vi.mock('../../src/storage/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/database')>();
  return { ...actual, saveDatabase: vi.fn() };
});

vi.mock('../../src/plugins/browser-companion/server', () => ({
  getBridgeStatus: vi.fn().mockReturnValue({ running: true, port: 35789, connectedClients: 1 }),
  sendCommand: vi.fn().mockResolvedValue({ id: 'c', ok: true, data: null }),
}));

import { selectDueSkills, runDueSkills, runSkill } from '../../src/plugins/browser-companion/skill-runner';
import { getBridgeStatus, sendCommand } from '../../src/plugins/browser-companion/server';

const NOW = Date.parse('2026-10-17T12:00:00Z');

describe('selectDueSkills', () => {
  it('selects a skill whose interval has elapsed since its last run', () => {
    expect(selectDueSkills([{ id: 1, intervalMinutes: 60, lastRunAt: '2026-10-17 10:59:00' }], NOW)).toEqual([1]);
  });

  it('skips a skill whose interval has not elapsed yet', () => {
    expect(selectDueSkills([{ id: 1, intervalMinutes: 60, lastRunAt: '2026-10-17 11:30:00' }], NOW)).toEqual([]);
  });

  it('treats a skill that never ran as due', () => {
    expect(selectDueSkills([{ id: 1, intervalMinutes: 15, lastRunAt: null }], NOW)).toEqual([1]);
  });

  it('ignores skills without a positive interval', () => {
    expect(selectDueSkills([{ id: 1, intervalMinutes: 0, lastRunAt: null }], NOW)).toEqual([]);
  });
});

describe('runDueSkills', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getBridgeStatus).mockReturnValue({ running: true, port: 35789, connectedClients: 1 });
    vi.mocked(sendCommand).mockResolvedValue({ id: 'c', ok: true, data: { steps: [] } });
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
    db.run(`INSERT INTO browser_skills (name, start_url, instructions, interval_minutes) VALUES ('Due', 'https://example.invalid/a', 'wait 1', 30)`);
    db.run(`INSERT INTO browser_skills (name, start_url, instructions, interval_minutes) VALUES ('Manual only', 'https://example.invalid/b', 'wait 1', NULL)`);
  });

  afterEach(() => db.close());

  it('skips silently when no browser extension is connected', async () => {
    vi.mocked(getBridgeStatus).mockReturnValue({ running: true, port: 35789, connectedClients: 0 });
    const result = await runDueSkills(db, NOW);
    expect(result).toMatchObject({ skipped: true, ran: 0 });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(db.exec('SELECT COUNT(*) FROM browser_skill_runs')[0].values[0][0]).toBe(0);
  });

  it('runs only the due scheduled skill and records the run', async () => {
    const result = await runDueSkills(db, NOW);
    expect(result).toMatchObject({ ran: 1, failed: 0 });
    const runs = db.exec('SELECT skill_id, status FROM browser_skill_runs')[0].values;
    expect(runs).toEqual([[1, 'completed']]);
  });

  it('does not run a skill again before its interval has elapsed', async () => {
    await runDueSkills(db, NOW);
    vi.mocked(sendCommand).mockClear();
    const result = await runDueSkills(db, Date.now());
    expect(result.ran).toBe(0);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent run of the same skill', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(sendCommand).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const first = runSkill(db, 1, false);
    // Let the first run reach its first (pending) command.
    await new Promise((r) => setTimeout(r, 0));
    const second = await runSkill(db, 1, false);
    expect(second).toMatchObject({ ok: false, error: 'This skill is already running' });
    expect(selectDueSkills([{ id: 1, intervalMinutes: 30, lastRunAt: null }], NOW)).toEqual([]);
    vi.mocked(sendCommand).mockResolvedValue({ id: 'c', ok: true, data: { steps: [] } });
    release({ id: 'c', ok: true, data: null });
    await first;
    expect(db.exec('SELECT COUNT(*) FROM browser_skill_runs')[0].values[0][0]).toBe(1);
  });
});
