import { describe, it, expect } from 'vitest';
import { computeCiHealth, countFlakyShas, median, type CiRunInput } from '../../src/services/ci-health';

const NOW = new Date('2026-03-31T12:00:00Z');
const H = 3600_000;
const D = 24 * H;

function run(over: Partial<CiRunInput> & { ageMs: number; durMs?: number }): CiRunInput {
  const start = NOW.getTime() - over.ageMs;
  const { ageMs: _a, durMs, ...rest } = over;
  return {
    repoFullName: 'acme/rocket',
    workflowId: '1',
    workflowName: 'CI',
    headSha: 'sha',
    conclusion: 'success',
    runStartedAt: new Date(start).toISOString(),
    updatedAt: new Date(start + (durMs ?? 60_000)).toISOString(),
    ...rest,
  };
}

describe('median', () => {
  it('handles empty, odd and even', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe('countFlakyShas', () => {
  it('counts fail-then-pass on the same sha only', () => {
    const runs = [
      run({ ageMs: 5 * H, headSha: 'a', conclusion: 'failure' }),
      run({ ageMs: 4 * H, headSha: 'a', conclusion: 'success' }),
      run({ ageMs: 3 * H, headSha: 'b', conclusion: 'success' }),
      run({ ageMs: 2 * H, headSha: 'b', conclusion: 'failure' }), // pass then fail: not flaky
      run({ ageMs: 1 * H, headSha: 'c', conclusion: 'failure' }),
    ];
    expect(countFlakyShas(runs)).toBe(1);
  });
});

describe('computeCiHealth', () => {
  it('computes failure rate per workflow and ignores runs outside the window', () => {
    const runs = [
      run({ ageMs: 1 * D, conclusion: 'failure' }),
      run({ ageMs: 2 * D, conclusion: 'success' }),
      run({ ageMs: 3 * D, conclusion: 'success' }),
      run({ ageMs: 4 * D, conclusion: 'success' }),
      run({ ageMs: 20 * D, conclusion: 'failure' }),
      run({ ageMs: 1 * D, conclusion: 'cancelled' }),
      run({ ageMs: 1 * D, conclusion: null, status: 'in_progress' }),
    ];
    const r7 = computeCiHealth(runs, 7, NOW);
    expect(r7.workflows).toHaveLength(1);
    expect(r7.workflows[0]).toMatchObject({ totalRuns: 4, failedRuns: 1, failureRate: 0.25 });
    const r30 = computeCiHealth(runs, 30, NOW);
    expect(r30.workflows[0]).toMatchObject({ totalRuns: 5, failedRuns: 2 });
  });

  it('ranks the worst failing and flaky workflows first', () => {
    const runs = [
      run({ ageMs: 1 * D, workflowId: '1', workflowName: 'A', conclusion: 'failure', headSha: 'x' }),
      run({ ageMs: 1 * D - H, workflowId: '1', workflowName: 'A', conclusion: 'success', headSha: 'x' }),
      run({ ageMs: 2 * D, workflowId: '2', workflowName: 'B', conclusion: 'failure', headSha: 'y' }),
      run({ ageMs: 3 * D, workflowId: '2', workflowName: 'B', conclusion: 'failure', headSha: 'z' }),
    ];
    const r = computeCiHealth(runs, 7, NOW);
    expect(r.topFailing.map((w) => w.workflowName)).toEqual(['B', 'A']);
    expect(r.topFlaky.map((w) => w.workflowName)).toEqual(['A']);
  });

  it('reports duration drift between the two halves of the window', () => {
    const runs = [
      run({ ageMs: 6 * D, durMs: 60_000 }),
      run({ ageMs: 5 * D, durMs: 60_000 }),
      run({ ageMs: 1 * D, durMs: 120_000 }),
      run({ ageMs: 2 * D, durMs: 120_000 }),
    ];
    const r = computeCiHealth(runs, 7, NOW);
    const w = r.workflows[0];
    expect(w.previousMedianDurationMs).toBe(60_000);
    expect(w.medianDurationMs).toBe(120_000);
    expect(w.durationDrift).toBe(1);
    expect(r.topSlowing).toHaveLength(1);
  });

  it('leaves drift null with too little data, and keeps repos separate', () => {
    const runs = [
      run({ ageMs: 1 * D }),
      run({ ageMs: 6 * D }),
      run({ ageMs: 1 * D, repoFullName: 'acme/anvil' }),
    ];
    const r = computeCiHealth(runs, 7, NOW);
    expect(r.workflows).toHaveLength(2);
    expect(r.workflows.every((w) => w.durationDrift === null)).toBe(true);
    expect(r.topSlowing).toEqual([]);
  });

  it('parses SQLite-style timestamps as UTC', () => {
    const r = computeCiHealth(
      [{ ...run({ ageMs: 0 }), runStartedAt: '2026-03-30 12:00:00', updatedAt: '2026-03-30 12:01:00' }],
      7,
      NOW,
    );
    expect(r.workflows).toHaveLength(1);
  });
});
