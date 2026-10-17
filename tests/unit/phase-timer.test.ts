import { describe, it, expect } from 'vitest';
import { PhaseTimer } from '../../src/services/phase-timer';

describe('PhaseTimer', () => {
  it('adds up repeated phases and summarises them in order', async () => {
    let clock = 0;
    const timer = new PhaseTimer(() => clock);
    timer.sync('scan', () => { clock += 5; });
    await timer.time('fetch', async () => { clock += 20; });
    timer.sync('scan', () => { clock += 3; });
    expect(timer.get('scan')).toBe(8);
    expect(timer.summary()).toBe('scan=8ms×2 fetch=20ms');
  });

  it('records a phase that throws', async () => {
    let clock = 0;
    const timer = new PhaseTimer(() => clock);
    await expect(timer.time('fail', async () => { clock += 4; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(() => timer.sync('bad', () => { clock += 1; throw new Error('x'); })).toThrow('x');
    expect(timer.summary()).toBe('fail=4ms bad=1ms');
  });
});
