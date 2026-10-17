// ── Phase timer ───────────────────────────────────────────────────────────────
// Records how long the named phases of a multi-step job take, for one compact
// debug line per run (e.g. "local=2410ms cloud=830ms pr:rajbos=420ms").
// Phases with the same name add up; `count` shows how often each ran.

export class PhaseTimer {
  private readonly phases = new Map<string, { ms: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  add(name: string, ms: number): void {
    const phase = this.phases.get(name) ?? { ms: 0, count: 0 };
    phase.ms += ms;
    phase.count++;
    this.phases.set(name, phase);
  }

  /** Time a synchronous step. */
  sync<T>(name: string, fn: () => T): T {
    const start = this.now();
    try {
      return fn();
    } finally {
      this.add(name, this.now() - start);
    }
  }

  /** Time an asynchronous step (wall-clock time until it settles). */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } finally {
      this.add(name, this.now() - start);
    }
  }

  get(name: string): number | undefined {
    return this.phases.get(name)?.ms;
  }

  summary(): string {
    return [...this.phases]
      .map(([name, { ms, count }]) => `${name}=${ms}ms${count > 1 ? `×${count}` : ''}`)
      .join(' ');
  }
}
