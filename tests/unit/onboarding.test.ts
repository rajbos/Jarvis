import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { getSchema } from '../../src/storage/schema';
import { getOnboardingStatus, completeOnboardingStep, skipOnboardingStep } from '../../src/agent/onboarding';

describe('Onboarding', () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run(getSchema());
  });

  afterEach(() => {
    db.close();
  });

  it('should return all steps as pending initially', () => {
    const status = getOnboardingStatus(db);

    expect(status.ollama).toBe('pending');
    expect(status.local_repos).toBe('pending');
    expect(status.github_oauth).toBe('pending');
  });

  it('should mark a step as completed', () => {
    completeOnboardingStep(db, 'github_oauth');

    const status = getOnboardingStatus(db);
    expect(status.github_oauth).toBe('completed');
    expect(status.ollama).toBe('pending');
    expect(status.local_repos).toBe('pending');
  });

  it('should mark a step as skipped', () => {
    skipOnboardingStep(db, 'ollama');

    const status = getOnboardingStatus(db);
    expect(status.ollama).toBe('skipped');
    expect(status.github_oauth).toBe('pending');
  });

  it('should set completed_at when completing a step', () => {
    completeOnboardingStep(db, 'local_repos');

    const stmt = db.prepare('SELECT completed_at FROM onboarding WHERE step = ?');
    stmt.bind(['local_repos']);
    stmt.step();
    const row = stmt.getAsObject() as { completed_at: string | null };
    stmt.free();

    expect(row.completed_at).not.toBeNull();
  });
});
