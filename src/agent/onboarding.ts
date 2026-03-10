import type { Database as SqlJsDatabase } from 'sql.js';

export interface OnboardingStatus {
  ollama: string;
  local_repos: string;
  github_oauth: string;
}

export function getOnboardingStatus(db: SqlJsDatabase): OnboardingStatus {
  const stmt = db.prepare('SELECT step, status FROM onboarding');
  const status: OnboardingStatus = {
    ollama: 'pending',
    local_repos: 'pending',
    github_oauth: 'pending',
  };

  while (stmt.step()) {
    const row = stmt.getAsObject() as { step: string; status: string };
    if (row.step in status) {
      status[row.step as keyof OnboardingStatus] = row.status;
    }
  }
  stmt.free();

  return status;
}

export function completeOnboardingStep(db: SqlJsDatabase, step: string): void {
  db.run("UPDATE onboarding SET status = ?, completed_at = datetime('now') WHERE step = ?", [
    'completed',
    step,
  ]);
}

export function skipOnboardingStep(db: SqlJsDatabase, step: string): void {
  db.run("UPDATE onboarding SET status = ?, completed_at = datetime('now') WHERE step = ?", [
    'skipped',
    step,
  ]);
}
