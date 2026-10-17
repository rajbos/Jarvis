// Detects main-thread stalls. A timer that should fire every `intervalMs` is
// late when something ran synchronously; the lateness is how long the event
// loop (and with it the Windows message pump, i.e. the "Not responding" window)
// was blocked. Each stall is logged with a caller-supplied context string so the
// log shows what was running. Kept free of Electron imports.
import { logger } from './logger';

export interface StallWatchdogOptions {
  intervalMs?: number;
  /** Log stalls at least this long. */
  thresholdMs?: number;
  /** Describes what is running right now (e.g. active background task ids). */
  context?: () => string;
  /** Called for stalls of at least `notifyThresholdMs` (after they are logged). */
  onStall?: (lagMs: number, context: string) => void;
  /** Minimum stall length that triggers `onStall`; defaults to `thresholdMs`. */
  notifyThresholdMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startStallWatchdog(options: StallWatchdogOptions = {}): void {
  if (timer) return;
  const intervalMs = options.intervalMs ?? 250;
  const thresholdMs = options.thresholdMs ?? 1_000;
  let expected = Date.now() + intervalMs;
  timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + intervalMs;
    if (lag < thresholdMs) return;
    let ctx = '';
    try {
      ctx = options.context?.() ?? '';
    } catch {
      /* context is best effort */
    }
    logger.warn(`[Stall] main thread blocked for ~${lag}ms (ended ${new Date(now).toISOString()})${ctx ? `; ${ctx}` : ''}`);
    if (options.onStall && lag >= (options.notifyThresholdMs ?? thresholdMs)) {
      try {
        options.onStall(lag, ctx);
      } catch {
        /* notification is best effort */
      }
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopStallWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
