// Renderer polling that catches up after sleep. Window timers pause while the
// machine is suspended (and Chromium throttles them while the window is hidden),
// so a plain setInterval can leave data stale for a full interval after wake.
// startPolling also runs on the main process's `app:resumed` push and when the
// window becomes visible again after missing a tick.

export interface PollingEnv {
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
  /** Subscribe to system resume; returns an unsubscribe. */
  onResume(cb: () => void): () => void;
  /** Subscribe to the window becoming visible; returns an unsubscribe. */
  onVisible(cb: () => void): () => void;
}

export interface PollingOptions {
  /** Run this instead of `run` on resume / visible (e.g. a fuller reload). */
  onWake?: () => unknown;
  env?: PollingEnv;
}

function browserEnv(): PollingEnv {
  return {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    now: () => Date.now(),
    onResume: (cb) => window.jarvis?.onSystemResumed?.(cb) ?? (() => {}),
    onVisible: (cb) => {
      const listener = () => { if (document.visibilityState === 'visible') cb(); };
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

/**
 * Call `run` every `intervalMs`, immediately on system resume, and on the window
 * turning visible when a tick is overdue. Does not run on start: callers that
 * want an initial load do it themselves. Returns a stop function.
 */
export function startPolling(run: () => unknown, intervalMs: number, options: PollingOptions = {}): () => void {
  const env = options.env ?? browserEnv();
  const wake = options.onWake ?? run;
  let lastRunAt = env.now();
  const fire = (fn: () => unknown) => {
    lastRunAt = env.now();
    // Callers log their own failures; this only keeps one bad tick from
    // surfacing as an unhandled rejection or breaking the poll.
    try {
      const result = fn();
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // see above
    }
  };
  const id = env.setInterval(() => fire(run), intervalMs);
  const offResume = env.onResume(() => fire(wake));
  const offVisible = env.onVisible(() => {
    if (env.now() - lastRunAt >= intervalMs) fire(wake);
  });
  return () => {
    env.clearInterval(id);
    offResume();
    offVisible();
  };
}
